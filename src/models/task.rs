use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Incoming,
    InProgress,
    Completed,
    Failed,
}

impl std::fmt::Display for TaskStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Incoming => write!(f, "incoming"),
            Self::InProgress => write!(f, "in_progress"),
            Self::Completed => write!(f, "completed"),
            Self::Failed => write!(f, "failed"),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskCost {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default, alias = "cached_tokens")]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_write_tokens: u64,
    #[serde(default, alias = "cost_usd")]
    pub total_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskComment {
    #[serde(default)]
    pub author: String,
    #[serde(default, alias = "content")]
    pub message: String,
    #[serde(default = "Utc::now")]
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskInteraction {
    #[serde(default)]
    pub status_change: Option<OperatorStatusChange>,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub cancel_requested: bool,
    #[serde(default)]
    pub resume_requested: bool,
    #[serde(default)]
    pub usage_unavailable: bool,
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub messages: Vec<OperatorMessage>,
    #[serde(default)]
    pub handoff: Option<OperatorHandoff>,
    #[serde(default)]
    pub applied_requests: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperatorStatusChange {
    pub request_id: String,
    pub target: TaskStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperatorMessage {
    pub id: String,
    pub text: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperatorHandoff {
    pub id: String,
    pub agent: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderLease {
    pub token: String,
    #[serde(default)]
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub agent: String,
    pub title: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub independent_workspace: bool,
    #[serde(default = "default_status")]
    pub status: TaskStatus,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_config: Option<crate::copilot::SessionConfig>,
    #[serde(default = "Utc::now")]
    pub created_at: DateTime<Utc>,
    #[serde(default = "Utc::now")]
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub comments: Vec<TaskComment>,
    #[serde(default)]
    pub cost: TaskCost,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub turns: u32,
    #[serde(default)]
    pub interaction: TaskInteraction,
    #[serde(default)]
    pub provider: Option<ProviderLease>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acceptance: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runner_metadata: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deferred_pr_owner: bool,
}

fn default_status() -> TaskStatus {
    TaskStatus::Incoming
}

impl Task {
    pub fn new(id: impl Into<String>, agent: impl Into<String>, title: impl Into<String>, prompt: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            id: id.into(),
            agent: agent.into(),
            title: title.into(),
            prompt: prompt.into(),
            model: None,
            workspace: None,
            independent_workspace: false,
            status: TaskStatus::Incoming,
            session_id: None,
            session_config: None,
            created_at: now,
            updated_at: now,
            comments: Vec::new(),
            cost: TaskCost::default(),
            error: None,
            turns: 0,
            interaction: TaskInteraction::default(),
            provider: None,
            acceptance: None,
            runner_metadata: None,
            deferred_pr_owner: false,
        }
    }

    pub fn add_comment(&mut self, author: impl Into<String>, message: impl Into<String>) {
        self.comments.push(TaskComment {
            author: author.into(),
            message: message.into(),
            created_at: Utc::now(),
        });
        self.updated_at = Utc::now();
    }

    pub fn metadata(&self, root: &std::path::Path) -> anyhow::Result<Option<serde_json::Value>> {
        if let Some(metadata) = &self.runner_metadata { return Ok(Some(metadata.clone())); }
        let file = root.join(".runner-receipts").join(format!("task-{}.json", self.id));
        match std::fs::read(file) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
}
