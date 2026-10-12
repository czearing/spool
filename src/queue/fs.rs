use std::fs;
use std::path::{Path, PathBuf};
use anyhow::{Context, Result};
use crate::models::{Task, TaskStatus};

pub fn validate_id(id: &str) -> Result<()> {
    anyhow::ensure!(id.len() <= 180 && id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) &&
        id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')), "Invalid task or agent id");
    Ok(())
}

pub struct TaskGuard {
    _file: fs::File,
}

impl TaskGuard {
    pub fn acquire(queues: &Path, id: &str) -> Result<Self> {
        validate_id(id)?;
        let directory = queues.parent().context("Missing Spool root")?.join("controls").join("task-locks");
        fs::create_dir_all(&directory)?;
        let file = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false)
            .open(directory.join(format!("{id}.lock")))?;
        file.lock().context("Cannot acquire work-item mutation lock")?;
        Ok(Self { _file: file })
    }
}

pub fn locate_task(queues: &Path, id: &str) -> Result<(PathBuf, Task)> {
    validate_id(id)?;
    let paths = QueuePaths::new(queues);
    let mut found = None;
    for status in [TaskStatus::Incoming, TaskStatus::InProgress, TaskStatus::Completed, TaskStatus::Failed] {
        let file = paths.status_dir(status).join(format!("{id}.json"));
        if !file.try_exists()? { continue; }
        anyhow::ensure!(found.is_none(), "Task exists in multiple queues");
        let mut task = read_task(&file)?;
        anyhow::ensure!(task.id == id, "Task identity does not match queue file");
        task.status = status;
        found = Some((file, task));
    }
    found.context("Task not found")
}

pub fn save_task_state(queues: &Path, source: &Path, task: &Task) -> Result<()> {
    let destination = QueuePaths::new(queues).status_dir(task.status).join(format!("{}.json", task.id));
    anyhow::ensure!(source == destination || !destination.exists(), "Destination task already exists");
    write_task(source, task)?;
    if source != destination { atomic_move(source, destination)?; }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct QueuePaths {
    pub base: PathBuf,
    pub incoming: PathBuf,
    pub in_progress: PathBuf,
    pub completed: PathBuf,
    pub failed: PathBuf,
}

impl QueuePaths {
    pub fn new(queues_root: impl AsRef<Path>) -> Self {
        let base = queues_root.as_ref().to_path_buf();
        Self {
            incoming: base.join("incoming"),
            in_progress: base.join("in_progress"),
            completed: base.join("completed"),
            failed: base.join("failed"),
            base,
        }
    }

    pub fn ensure_dirs(&self) -> Result<()> {
        fs::create_dir_all(&self.incoming)?;
        fs::create_dir_all(&self.in_progress)?;
        fs::create_dir_all(&self.completed)?;
        fs::create_dir_all(&self.failed)?;
        Ok(())
    }

    pub fn status_dir(&self, status: TaskStatus) -> &Path {
        match status {
            TaskStatus::Incoming => &self.incoming,
            TaskStatus::InProgress => &self.in_progress,
            TaskStatus::Completed => &self.completed,
            TaskStatus::Failed => &self.failed,
        }
    }
}

pub fn read_task(path: impl AsRef<Path>) -> Result<Task> {
    let content = fs::read_to_string(path.as_ref())
        .with_context(|| format!("Failed to read task file {:?}", path.as_ref()))?;
    let task: Task = serde_json::from_str(&content)
        .with_context(|| format!("Invalid task JSON in {:?}", path.as_ref()))?;
    Ok(task)
}

pub fn write_task(path: impl AsRef<Path>, task: &Task) -> Result<()> {
    write_json(path, task)
}

pub fn write_json(path: impl AsRef<Path>, value: &impl serde::Serialize) -> Result<()> {
    use std::io::Write;
    let path = path.as_ref();
    let json = serde_json::to_string_pretty(value)?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::File::create_new(&temporary)?;
        file.write_all(json.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() && temporary.exists() {
        if let Err(error) = fs::remove_file(&temporary) {
            eprintln!("Cannot clean up task write {}: {error}", temporary.display());
        }
    }
    result.with_context(|| format!("Failed to write task file {path:?}"))
}

pub fn atomic_move(src: impl AsRef<Path>, dest: impl AsRef<Path>) -> Result<()> {
    if let Some(parent) = dest.as_ref().parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(src.as_ref(), dest.as_ref())
        .with_context(|| format!("Failed to move {:?} to {:?}", src.as_ref(), dest.as_ref()))?;
    Ok(())
}

pub fn list_tasks_in_dir(dir: impl AsRef<Path>) -> Vec<(PathBuf, Task)> {
    let mut tasks = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Ok(task) = read_task(&path) {
                    tasks.push((path, task));
                }
            }
        }
    }
    tasks
}

pub fn list_tasks_checked(dir: impl AsRef<Path>) -> Result<Vec<(PathBuf, Task)>> {
    let mut tasks = Vec::new();
    for entry in fs::read_dir(dir.as_ref())? {
        let path = entry?.path();
        if path.extension().and_then(|extension| extension.to_str()) == Some("json") {
            let task = read_task(&path)?;
            anyhow::ensure!(path.file_stem().and_then(|name| name.to_str()) == Some(task.id.as_str()),
                "Task identity does not match its queue file: {}", path.display());
            tasks.push((path, task));
        }
    }
    Ok(tasks)
}
