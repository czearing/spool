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
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub total_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskComment {
    pub author: String,
    pub message: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub agent: String,
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default = "default_status")]
    pub status: TaskStatus,
    #[serde(default)]
    pub session_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub comments: Vec<TaskComment>,
    #[serde(default)]
    pub cost: TaskCost,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub turns: u32,
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
            workspace: None,
            status: TaskStatus::Incoming,
            session_id: None,
            created_at: now,
            updated_at: now,
            comments: Vec::new(),
            cost: TaskCost::default(),
            error: None,
            turns: 0,
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
}
