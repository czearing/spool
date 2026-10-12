use std::path::{Path, PathBuf};
use std::sync::Arc;
use anyhow::{Context, Result};
use parking_lot::RwLock;
use tokio::sync::mpsc;

use crate::copilot::{CopilotRunner, CopilotExecutionResult};
use crate::engine::state::AppState;
use crate::models::{AgentConfig, Task, TaskStatus};
use crate::queue::fs::{atomic_move, list_tasks_checked, list_tasks_in_dir, read_task, write_task, write_json, QueuePaths, TaskGuard};
use crate::queue::watcher::{QueueEvent, QueueWatcher};

pub struct Orchestrator {
    pub root: PathBuf,
    pub agents_dir: PathBuf,
    pub queues_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub state: Arc<RwLock<AppState>>,
}

impl Orchestrator {
    pub fn new(root: impl AsRef<Path>, state: Arc<RwLock<AppState>>) -> Self {
        let r = root.as_ref().to_path_buf();
        Self {
            agents_dir: r.join("agents"),
            queues_dir: r.join("queues"),
            logs_dir: r.join("logs"),
            root: r,
            state,
        }
    }

    pub fn load_agents(&self) -> Result<()> {
        std::fs::create_dir_all(&self.agents_dir)?;
        let qp = QueuePaths::new(&self.queues_dir);
        qp.ensure_dirs()?;

        self.recover_interrupted_tasks()?;

        self.refresh_agents()?;
        Ok(())
    }

    pub fn recover_interrupted_tasks(&self) -> Result<()> {
        let qp = QueuePaths::new(&self.queues_dir);
        let mut sessions = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for status in [TaskStatus::Incoming, TaskStatus::InProgress, TaskStatus::Completed, TaskStatus::Failed] {
            for (_, task) in list_tasks_checked(qp.status_dir(status))? {
                anyhow::ensure!(seen.insert(task.id.clone()), "Task {} exists in multiple queues; recovery refused", task.id);
                if let Some(session) = task.session_id { sessions.push(session); }
                if let Some(provider) = task.provider { sessions.push(provider.token); }
            }
        }
        super::ownership::ensure_sessions_stopped(&sessions)?;
        for status in [TaskStatus::Incoming, TaskStatus::Completed, TaskStatus::Failed] {
            for (path, _) in list_tasks_checked(qp.status_dir(status))? {
                let id = path.file_stem().and_then(|name| name.to_str()).context("Invalid task identity")?;
                let _guard = TaskGuard::acquire(&self.queues_dir, id)?;
                let mut task = read_task(&path)?;
                if let Some(change) = task.interaction.status_change.take() {
                    task.provider = None;
                    super::operator::change_status(&mut task, change.target);
                    crate::queue::fs::save_task_state(&self.queues_dir, &path, &task)?;
                }
            }
        }
        for (path, mut task) in list_tasks_checked(&qp.in_progress)? {
            let _guard = TaskGuard::acquire(&self.queues_dir, &task.id)?;
            task.provider = None;
            if let Some(change) = task.interaction.status_change.take() {
                super::operator::change_status(&mut task, change.target);
                let destination = qp.status_dir(task.status).join(format!("{}.json", task.id));
                write_task(&path, &task)?;
                if path != destination { atomic_move(&path, destination)?; }
                continue;
            }
            for message in &mut task.interaction.messages {
                if message.status == "delivering" {
                    message.status = "delivery_uncertain".into();
                    message.error = Some("Runner stopped before delivery could be confirmed; operator input is required before resuming".into());
                    task.interaction.paused = true;
                }
            }
            if crate::copilot::process::interactive_enabled() {
                super::operator::recover_input(&mut task);
            }
            if task.interaction.paused { task.interaction.phase = "paused".into(); }
            task.add_comment("spool:supervisor", "Runner restarted; resuming task with preserved session ID");
            let dest = qp.incoming.join(format!("{}.json", task.id));
            task.status = TaskStatus::Incoming;
            anyhow::ensure!(!dest.exists(), "Task {} already exists in incoming; recovery refused", task.id);
            write_task(&path, &task)?;
            atomic_move(&path, &dest)?;
        }
        Ok(())
    }

    pub async fn run_supervised(self: Arc<Self>, shutdown_rx: mpsc::Receiver<()>) -> Result<()> {
        let error_file = self.root.join("controls").join("scheduler-error.json");
        std::fs::create_dir_all(error_file.parent().context("Missing controls directory")?)?;
        match std::fs::remove_file(&error_file) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        self.state.write().scheduler_error = None;
        let orchestrator = Arc::clone(&self);
        let result = match tokio::spawn(async move { orchestrator.run_loop(shutdown_rx).await }).await {
            Ok(result) => result,
            Err(error) => Err(anyhow::anyhow!("Scheduler task stopped unexpectedly: {error}")),
        };
        if let Err(error) = &result {
            let message = format!("SCHEDULER FAILED: {error:#}. Queued work is not being dispatched.");
            {
                let mut state = self.state.write();
                state.scheduler_error = Some(message.clone());
                state.add_log(message.clone());
            }
            eprintln!("{message}");
            write_json(&error_file, &serde_json::json!({
                "pid": std::process::id(), "updatedAt": chrono::Utc::now(), "error": message,
            }))?;
        }
        result
    }

    pub async fn run_loop(self: Arc<Self>, mut shutdown_rx: mpsc::Receiver<()>) -> Result<()> {
        let (tx, mut rx) = mpsc::channel::<QueueEvent>(100);
        let _watcher = QueueWatcher::start(&self.queues_dir, tx)?;

        self.dispatch_available_tasks();

        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(2));
        let mut controls = tokio::time::interval(tokio::time::Duration::from_millis(250));

        loop {
            tokio::select! {
                Some(_event) = rx.recv() => {
                    self.dispatch_available_tasks();
                }
                _ = interval.tick() => {
                    self.dispatch_available_tasks();
                }
                _ = controls.tick() => {
                    let active = self.state.read().active_tasks.keys().cloned().collect();
                    if let Err(error) = super::operator::process_requests(&self.root, &active) {
                        self.state.write().add_log(format!("Operator control failed: {error:#}"));
                    }
                }
                _ = shutdown_rx.recv() => {
                    break;
                }
            }
        }
        Ok(())
    }

}

#[path = "orchestrator/dispatch.rs"]
mod dispatch;
#[path = "orchestrator/execution.rs"]
mod execution;
#[cfg(test)]
#[path = "orchestrator/recovery_tests.rs"]
mod recovery_tests;
#[cfg(test)]
#[path = "orchestrator/ownership_tests.rs"]
mod ownership_tests;
#[cfg(test)]
#[path = "orchestrator/settlement_tests.rs"]
mod settlement_tests;
#[cfg(test)]
mod workspace_tests;
#[cfg(test)]
#[path = "orchestrator/concurrency_tests.rs"]
mod concurrency_tests;
