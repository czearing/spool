use std::path::{Path, PathBuf};
use std::sync::Arc;
use anyhow::Result;
use parking_lot::RwLock;
use tokio::sync::mpsc;

use crate::copilot::CopilotRunner;
use crate::engine::state::AppState;
use crate::models::{AgentConfig, Task, TaskStatus};
use crate::pricing::calculate_cost;
use crate::queue::fs::{atomic_move, list_tasks_in_dir, read_task, write_task, AgentQueuePaths};
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
        let mut loaded = Vec::new();

        if let Ok(entries) = std::fs::read_dir(&self.agents_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("md") {
                    if let Ok(agent) = AgentConfig::from_file(&path) {
                        let qp = AgentQueuePaths::new(&self.queues_dir, &agent.name);
                        let _ = qp.ensure_dirs();
                        loaded.push(agent);
                    }
                }
            }
        }

        let mut state = self.state.write();
        for agent in loaded {
            state.agents.insert(agent.name.clone(), agent);
        }
        Ok(())
    }

    pub async fn run_loop(self: Arc<Self>, mut shutdown_rx: mpsc::Receiver<()>) -> Result<()> {
        let (tx, mut rx) = mpsc::channel::<QueueEvent>(100);
        let _watcher = QueueWatcher::start(&self.queues_dir, tx)?;

        self.sweep_all_incoming();

        loop {
            tokio::select! {
                Some(event) = rx.recv() => {
                    if event.is_incoming {
                        let orch = Arc::clone(&self);
                        tokio::spawn(async move {
                            orch.handle_task_file(&event.path).await;
                        });
                    }
                }
                _ = shutdown_rx.recv() => {
                    break;
                }
            }
        }
        Ok(())
    }

    pub fn sweep_all_incoming(&self) {
        let agents = { self.state.read().agents.clone() };
        for agent in agents.values() {
            let qp = AgentQueuePaths::new(&self.queues_dir, &agent.name);
            for (path, _) in list_tasks_in_dir(&qp.incoming) {
                let orch = self.clone_arc();
                tokio::spawn(async move {
                    orch.handle_task_file(&path).await;
                });
            }
        }
    }

    fn clone_arc(&self) -> Arc<Self> {
        Arc::new(Self {
            root: self.root.clone(),
            agents_dir: self.agents_dir.clone(),
            queues_dir: self.queues_dir.clone(),
            logs_dir: self.logs_dir.clone(),
            state: Arc::clone(&self.state),
        })
    }

    pub async fn handle_task_file(&self, incoming_file: &Path) {
        if !incoming_file.exists() { return; }
        let task = match read_task(incoming_file) {
            Ok(t) => t,
            Err(_) => return,
        };

        let agent_name = task.agent.clone();
        let agent = match self.state.read().agents.get(&agent_name).cloned() {
            Some(a) => a,
            None => return,
        };

        let is_running = { self.state.read().active_tasks.contains_key(&agent_name) };
        if is_running { return; }

        let qp = AgentQueuePaths::new(&self.queues_dir, &agent_name);
        let in_progress_file = qp.in_progress.join(format!("{}.json", task.id));

        if atomic_move(incoming_file, &in_progress_file).is_err() {
            return;
        }

        {
            let mut state = self.state.write();
            state.active_tasks.insert(agent_name.clone(), task.id.clone());
            state.add_log(format!("[{}] Picked up task {}: {}", agent_name, task.id, task.title));
        }

        self.execute_task_pipeline(task, agent, in_progress_file).await;

        {
            let mut state = self.state.write();
            state.active_tasks.remove(&agent_name);
        }
    }

    async fn execute_task_pipeline(&self, mut task: Task, agent: AgentConfig, in_prog_path: PathBuf) {
        let runner = CopilotRunner::new(&self.logs_dir);
        let exe_path = std::env::current_exe().ok();
        
        let (log_tx, mut log_rx) = mpsc::channel::<String>(50);
        let state_ref = Arc::clone(&self.state);
        let log_task = tokio::spawn(async move {
            while let Some(msg) = log_rx.recv().await {
                state_ref.write().add_log(msg);
            }
        });

        let res = runner.execute_task(&task, &agent, exe_path.as_deref(), Some(log_tx)).await;
        let _ = log_task.await;

        let qp = AgentQueuePaths::new(&self.queues_dir, &agent.name);

        match res {
            Ok(exec_res) => {
                task.session_id = Some(exec_res.session_id);
                task.turns += exec_res.usage.turns;
                
                let cost = calculate_cost(
                    &agent.model,
                    exec_res.usage.input_tokens,
                    exec_res.usage.output_tokens,
                    exec_res.usage.cache_read_tokens,
                    exec_res.usage.cache_write_tokens,
                );
                task.cost = cost.clone();
                self.state.write().record_task_cost(&agent.name, &cost);

                if in_prog_path.exists() {
                    let target_status = if exec_res.exit_code == 0 { TaskStatus::Completed } else { TaskStatus::Failed };
                    task.status = target_status;
                    let dest = qp.status_dir(target_status).join(format!("{}.json", task.id));
                    let _ = write_task(&in_prog_path, &task);
                    let _ = atomic_move(&in_prog_path, &dest);
                }
            }
            Err(err) => {
                task.status = TaskStatus::Failed;
                task.error = Some(err.to_string());
                let dest = qp.failed.join(format!("{}.json", task.id));
                let _ = write_task(&in_prog_path, &task);
                let _ = atomic_move(&in_prog_path, &dest);
            }
        }
    }
}
