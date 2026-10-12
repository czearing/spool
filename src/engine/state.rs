use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use crate::models::{AgentConfig, Task, TaskCost};

#[derive(Debug)]
pub struct ActiveTask {
    pub agent: String,
    pub session_id: Option<String>,
    pub independent_workspace: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSummary {
    pub name: String,
    pub description: String,
    pub model: String,
    pub running: bool,
    pub active_task: Option<String>,
    pub incoming_count: usize,
    pub in_progress_count: usize,
    pub completed_count: usize,
    pub failed_count: usize,
    pub total_cost_usd: f64,
    pub total_tokens: u64,
    pub last_active_ago: String,
}

#[derive(Debug)]
pub struct AppState {
    pub agents: HashMap<String, AgentConfig>,
    pub active_tasks: HashMap<String, ActiveTask>, // task_id -> execution
    pub active_workspaces: HashMap<PathBuf, String>,
    pub agent_costs: HashMap<String, TaskCost>,
    pub recent_logs: VecDeque<String>,
    pub scheduler_error: Option<String>,
    pub total_cost_usd: f64,
    pub total_tokens: u64,
    pub notify: Arc<Notify>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            agents: HashMap::new(),
            active_tasks: HashMap::new(),
            active_workspaces: HashMap::new(),
            agent_costs: HashMap::new(),
            recent_logs: VecDeque::new(),
            scheduler_error: None,
            total_cost_usd: 0.0,
            total_tokens: 0,
            notify: Arc::new(Notify::new()),
        }
    }
}

impl AppState {
    pub fn new() -> Arc<RwLock<Self>> {
        Arc::new(RwLock::new(Self::default()))
    }

    pub fn add_log(&mut self, log: String) {
        if self.recent_logs.len() >= 100 {
            self.recent_logs.pop_front();
        }
        self.recent_logs.push_back(log);
        self.notify.notify_waiters();
    }

    pub fn set_active_task(&mut self, task: &Task) {
        self.active_tasks.insert(task.id.clone(), ActiveTask {
            agent: task.agent.clone(),
            session_id: task.session_id.clone(),
            independent_workspace: task.independent_workspace,
        });
        self.notify.notify_waiters();
    }

    pub fn remove_active_task(&mut self, task_id: &str) {
        self.active_tasks.remove(task_id);
        self.active_workspaces.retain(|_, owner| owner != task_id);
        self.notify.notify_waiters();
    }

    pub fn record_task_cost(&mut self, agent: &str, cost: &TaskCost) {
        let entry = self.agent_costs.entry(agent.to_string()).or_default();
        entry.input_tokens += cost.input_tokens;
        entry.output_tokens += cost.output_tokens;
        entry.cache_read_tokens += cost.cache_read_tokens;
        entry.cache_write_tokens += cost.cache_write_tokens;
        entry.total_cost_usd += cost.total_cost_usd;

        self.total_cost_usd += cost.total_cost_usd;
        self.total_tokens += cost.input_tokens + cost.output_tokens;
        self.notify.notify_waiters();
    }
}
