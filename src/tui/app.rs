use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use parking_lot::RwLock;

use crate::engine::state::{AgentSummary, AppState};
use crate::queue::fs::{list_tasks_in_dir, QueuePaths};

pub struct TuiApp {
    pub state: Arc<RwLock<AppState>>,
    pub queues_root: std::path::PathBuf,
    pub selected_agent_idx: usize,
    pub should_quit: bool,
    pub cached_summaries: Vec<AgentSummary>,
    pub recent_activities: Vec<String>,
}

impl TuiApp {
    pub fn new(state: Arc<RwLock<AppState>>, queues_root: impl AsRef<Path>) -> Self {
        let mut app = Self {
            state,
            queues_root: queues_root.as_ref().to_path_buf(),
            selected_agent_idx: 0,
            should_quit: false,
            cached_summaries: Vec::new(),
            recent_activities: Vec::new(),
        };
        app.reload_summaries();
        app
    }

    pub fn total_stats(&self) -> (u64, f64) {
        let mut tokens = 0;
        let mut cost = 0.0;
        for s in &self.cached_summaries {
            tokens += s.total_tokens;
            cost += s.total_cost_usd;
        }
        (tokens, cost)
    }

    pub fn reload_summaries(&mut self) {
        let state = self.state.read();
        let qp = QueuePaths::new(&self.queues_root);

        let inc_tasks = list_tasks_in_dir(&qp.incoming);
        let prog_tasks = list_tasks_in_dir(&qp.in_progress);
        let comp_tasks = list_tasks_in_dir(&qp.completed);
        let fail_tasks = list_tasks_in_dir(&qp.failed);

        let mut inc_counts: HashMap<String, usize> = HashMap::new();
        let mut prog_counts: HashMap<String, usize> = HashMap::new();
        let mut comp_counts: HashMap<String, usize> = HashMap::new();
        let mut fail_counts: HashMap<String, usize> = HashMap::new();
        let mut task_costs: HashMap<String, (u64, f64)> = HashMap::new();

        for (_, t) in &inc_tasks { *inc_counts.entry(t.agent.clone()).or_default() += 1; }
        for (_, t) in &prog_tasks { *prog_counts.entry(t.agent.clone()).or_default() += 1; }

        for (_, t) in comp_tasks.iter().chain(fail_tasks.iter()).chain(prog_tasks.iter()) {
            let entry = task_costs.entry(t.agent.clone()).or_default();
            entry.0 += t.cost.input_tokens + t.cost.output_tokens;
            entry.1 += t.cost.total_cost_usd;
        }

        for (_, t) in &comp_tasks { *comp_counts.entry(t.agent.clone()).or_default() += 1; }
        for (_, t) in &fail_tasks { *fail_counts.entry(t.agent.clone()).or_default() += 1; }

        let mut summaries = Vec::new();

        for (name, agent) in &state.agents {
            let mut active: Vec<_> = state.active_tasks.iter()
                .filter(|(_, task)| &task.agent == name).map(|(id, _)| id.as_str()).collect();
            active.sort_unstable();
            let active_task = (!active.is_empty()).then(|| active.join(", "));
            let running = active_task.is_some();
            let live_cost_rec = state.agent_costs.get(name);
            let disk_cost = task_costs.get(name).cloned().unwrap_or((0, 0.0));

            let total_tokens = live_cost_rec.map(|c| c.input_tokens + c.output_tokens).unwrap_or(0).max(disk_cost.0);
            let total_cost_usd = live_cost_rec.map(|c| c.total_cost_usd).unwrap_or(0.0).max(disk_cost.1);

            summaries.push(AgentSummary {
                name: name.clone(),
                description: agent.description.clone(),
                model: agent.model.clone(),
                running,
                active_task,
                incoming_count: *inc_counts.get(name).unwrap_or(&0),
                in_progress_count: *prog_counts.get(name).unwrap_or(&0),
                completed_count: *comp_counts.get(name).unwrap_or(&0),
                failed_count: *fail_counts.get(name).unwrap_or(&0),
                total_cost_usd,
                total_tokens,
                last_active_ago: if running { "now".to_string() } else { "idle".to_string() },
            });
        }

        summaries.sort_by(|a, b| a.name.cmp(&b.name));
        self.cached_summaries = summaries;

        // Build recent activities feed from task states
        let mut all_tasks = Vec::new();
        for (_, t) in comp_tasks.iter().chain(fail_tasks.iter()).chain(prog_tasks.iter()).chain(inc_tasks.iter()) {
            all_tasks.push(t.clone());
        }
        all_tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

        let mut activities = Vec::new();
        for t in all_tasks.into_iter().take(12) {
            let cost_str = if t.cost.total_cost_usd > 0.0 {
                format!(" (${:.2}, {}k tok)", t.cost.total_cost_usd, (t.cost.input_tokens + t.cost.output_tokens) / 1000)
            } else {
                String::new()
            };
            activities.push(format!("[{}] {} {:<8}: {}{}", t.updated_at.format("%H:%M:%S"), t.status, t.id, t.title, cost_str));
        }
        self.recent_activities = activities;
    }

    pub fn get_agent_summaries(&self) -> &[AgentSummary] {
        &self.cached_summaries
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
