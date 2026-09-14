use std::fs;
use std::path::{Path, PathBuf};
use anyhow::{Context, Result};
use crate::models::{Task, TaskStatus};

#[derive(Debug, Clone)]
pub struct AgentQueuePaths {
    pub base: PathBuf,
    pub incoming: PathBuf,
    pub in_progress: PathBuf,
    pub completed: PathBuf,
    pub failed: PathBuf,
}

impl AgentQueuePaths {
    pub fn new(queues_root: impl AsRef<Path>, agent: &str) -> Self {
        let base = queues_root.as_ref().join(agent);
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
    let json = serde_json::to_string_pretty(task)?;
    fs::write(path.as_ref(), json)
        .with_context(|| format!("Failed to write task file {:?}", path.as_ref()))?;
    Ok(())
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
