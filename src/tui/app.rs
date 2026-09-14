use std::path::Path;
use std::sync::Arc;
use parking_lot::RwLock;

use crate::engine::state::{AgentSummary, AppState};
use crate::queue::fs::{list_tasks_in_dir, AgentQueuePaths};

pub struct TuiApp {
    pub state: Arc<RwLock<AppState>>,
    pub queues_root: std::path::PathBuf,
    pub selected_agent_idx: usize,
    pub should_quit: bool,
}

impl TuiApp {
    pub fn new(state: Arc<RwLock<AppState>>, queues_root: impl AsRef<Path>) -> Self {
        Self {
            state,
            queues_root: queues_root.as_ref().to_path_buf(),
            selected_agent_idx: 0,
            should_quit: false,
        }
    }

    pub fn get_agent_summaries(&self) -> Vec<AgentSummary> {
        let state = self.state.read();
        let mut summaries = Vec::new();

        for (name, agent) in &state.agents {
            let qp = AgentQueuePaths::new(&self.queues_root, name);
            let inc = list_tasks_in_dir(&qp.incoming).len();
            let prog = list_tasks_in_dir(&qp.in_progress).len();
            let comp = list_tasks_in_dir(&qp.completed).len();
            let fail = list_tasks_in_dir(&qp.failed).len();

            let active_task = state.active_tasks.get(name).cloned();
            let running = active_task.is_some();
            let cost_rec = state.agent_costs.get(name);

            summaries.push(AgentSummary {
                name: name.clone(),
                description: agent.description.clone(),
                model: agent.model.clone(),
                running,
                active_task,
                incoming_count: inc,
                in_progress_count: prog,
                completed_count: comp,
                failed_count: fail,
                total_cost_usd: cost_rec.map(|c| c.total_cost_usd).unwrap_or(0.0),
                total_tokens: cost_rec.map(|c| c.input_tokens + c.output_tokens).unwrap_or(0),
                last_active_ago: if running { "now".to_string() } else { "idle".to_string() },
            });
        }

        summaries.sort_by(|a, b| a.name.cmp(&b.name));
        summaries
    }

    pub fn next_agent(&mut self, total: usize) {
        if total > 0 {
            self.selected_agent_idx = (self.selected_agent_idx + 1) % total;
        }
    }

    pub fn prev_agent(&mut self, total: usize) {
        if total > 0 {
            self.selected_agent_idx = if self.selected_agent_idx == 0 {
                total - 1
            } else {
                self.selected_agent_idx - 1
            };
        }
    }
}
