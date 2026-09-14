use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::models::{AgentConfig, TaskCost};

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

#[derive(Debug, Default)]
pub struct AppState {
    pub agents: HashMap<String, AgentConfig>,
    pub active_tasks: HashMap<String, String>, // agent_name -> task_id
    pub agent_costs: HashMap<String, TaskCost>,
    pub recent_logs: VecDeque<String>,
    pub total_cost_usd: f64,
    pub total_tokens: u64,
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
    }
}
