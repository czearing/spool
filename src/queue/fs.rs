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
        rename_with_retry(&temporary, path)
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
    rename_with_retry(src.as_ref(), dest.as_ref())
        .with_context(|| format!("Failed to move {:?} to {:?}", src.as_ref(), dest.as_ref()))?;
    Ok(())
}

fn rename_with_retry(source: &Path, destination: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    for _ in 0..20 {
        match fs::rename(source, destination) {
            Err(error) if matches!(error.raw_os_error(), Some(5 | 32 | 33)) =>
                std::thread::sleep(std::time::Duration::from_millis(50)),
            result => return result,
        }
    }
    fs::rename(source, destination)
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;
    use std::time::Duration;

    fn hold_without_delete_sharing(path: &Path) -> std::thread::JoinHandle<()> {
        let file = fs::OpenOptions::new().read(true).share_mode(3).open(path).unwrap();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            drop(file);
        })
    }

    #[test]
    fn replacing_json_waits_for_a_windows_reader() {
        let directory = std::env::temp_dir().join(format!("spool-write-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("task.json");
        write_json(&path, &serde_json::json!({ "version": 1 })).unwrap();
        let reader = hold_without_delete_sharing(&path);
        let result = write_json(&path, &serde_json::json!({ "version": 2 }));
        reader.join().unwrap();
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap(),
            serde_json::json!({ "version": 2 }));
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn moving_a_task_waits_for_a_windows_reader() {
        let directory = std::env::temp_dir().join(format!("spool-move-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let source = directory.join("incoming.json");
        let destination = directory.join("in_progress.json");
        fs::write(&source, b"task").unwrap();
        let reader = hold_without_delete_sharing(&source);
        let result = atomic_move(&source, &destination);
        reader.join().unwrap();
        assert!(result.is_ok(), "{result:?}");
        assert!(!source.exists());
        assert_eq!(fs::read(&destination).unwrap(), b"task");
        fs::remove_file(destination).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn a_persistent_windows_lock_preserves_the_original_json() {
        let directory = std::env::temp_dir().join(format!("spool-locked-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("task.json");
        write_json(&path, &serde_json::json!({ "version": 1 })).unwrap();
        let reader = fs::OpenOptions::new().read(true).share_mode(3).open(&path).unwrap();
        let error = write_json(&path, &serde_json::json!({ "version": 2 })).unwrap_err();
        assert_eq!(error.downcast_ref::<std::io::Error>().unwrap().raw_os_error(), Some(5));
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap(),
            serde_json::json!({ "version": 1 }));
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        drop(reader);
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
