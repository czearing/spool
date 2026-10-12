use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use super::task::TaskStatus;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_return: Option<ChatReturn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatReturn {
    pub status: TaskStatus,
    pub error: Option<String>,
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
