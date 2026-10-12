use std::collections::HashSet;
use std::path::Path;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::models::{AgentConfig, Task, TaskStatus};
use crate::models::task::{OperatorHandoff, OperatorStatusChange};
use crate::queue::fs::{locate_task, save_task_state, validate_id, write_json, write_task, TaskGuard, QueuePaths};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperatorRequest {
    pub id: String,
    pub kind: String,
    pub task_id: String,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub status: Option<TaskStatus>,
    #[serde(default)]
    pub expected_status: Option<TaskStatus>,
    #[serde(default)]
    pub metadata: Option<Value>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

fn required<'a>(value: &'a Option<String>, name: &str, max: usize) -> Result<&'a str> {
    let text = value.as_deref().with_context(|| format!("{name} is required"))?;
    anyhow::ensure!(!text.trim().is_empty() && text.len() <= max, "{name} must contain 1 to {max} bytes");
    Ok(text)
}

fn validate_agent(root: &Path, agent: &str) -> Result<()> {
    validate_id(agent)?;
    AgentConfig::from_file(root.join("agents").join(format!("{agent}.md")))?;
    Ok(())
}

pub fn apply_request(root: &Path, request: &OperatorRequest, active: &HashSet<String>) -> Result<Value> {
    validate_id(&request.id)?;
    validate_id(&request.task_id)?;
    let queues = root.join("queues");
    let _guard = TaskGuard::acquire(&queues, &request.task_id)?;
    let paths = QueuePaths::new(&queues);
    let existing = [TaskStatus::Incoming, TaskStatus::InProgress, TaskStatus::Completed, TaskStatus::Failed]
        .iter().any(|status| paths.status_dir(*status).join(format!("{}.json", request.task_id)).exists());
    let (file, mut task) = if existing {
        locate_task(&queues, &request.task_id)?
    } else {
        anyhow::ensure!(request.kind == "create", "Task not found");
        let agent = required(&request.agent, "agent", 180)?;
        validate_agent(root, agent)?;
        let title = required(&request.title, "title", 500)?;
        let prompt = required(&request.prompt, "prompt", 131072)?;
        let workspace = required(&request.workspace, "workspace", 4096)?;
        anyhow::ensure!(Path::new(workspace).is_absolute() && Path::new(workspace).is_dir(), "Workspace is unavailable");
        let mut task = Task::new(&request.task_id, agent, title, prompt);
        task.workspace = Some(workspace.to_owned());
        (paths.incoming.join(format!("{}.json", task.id)), task)
    };
    if task.interaction.applied_requests.contains(&request.id) {
        // Recover a crash between persisting a continuation and moving its queue file.
        if request.kind == "message" && !active.contains(&task.id) && task.status != TaskStatus::Incoming
            && crate::queue::fs::read_task(&file)?.status == TaskStatus::Incoming {
            task.status = TaskStatus::Incoming;
            save_task_state(&queues, &file, &task)?;
        }
        return Ok(json!({ "status": if task.interaction.status_change.as_ref().is_some_and(|change| change.request_id == request.id) { "pending" } else { "accepted" },
            "taskId": task.id, "duplicate": true }));
    }
    anyhow::ensure!(matches!(request.kind.as_str(), "status" | "create" | "handoff") || crate::copilot::process::interactive_enabled(),
        "Interactive conversation controls are not enabled");
    match request.kind.as_str() {
        "status" => {
            let target = request.status.context("Target status is required")?;
            anyhow::ensure!(request.expected_status == Some(task.status), "Task state changed; refresh before moving it");
            anyhow::ensure!(task.interaction.status_change.is_none(), "Another workflow change is pending");
            let starts = matches!(target, TaskStatus::Incoming | TaskStatus::InProgress);
            if starts {
                anyhow::ensure!(!task.deferred_pr_owner || task.session_id.is_some(),
                    "Dormant PR ownership can start only through verified prepared PR feedback");
                anyhow::ensure!(!AgentConfig::is_paused(root, &task.agent)?, "Agent is paused by operator");
                if !active.contains(&task.id) && task.status != TaskStatus::Incoming {
                    let metadata = request.metadata.as_ref().context("Reopening requires runner workspace preparation")?;
                    anyhow::ensure!(metadata["dashboardPrepared"] == true, "Reopening requires runner workspace preparation");
                    task.runner_metadata = Some(metadata.clone());
                }
            }
            if active.contains(&task.id) {
                anyhow::ensure!(target != TaskStatus::InProgress, "Task is already running");
                task.interaction.status_change = Some(OperatorStatusChange { request_id: request.id.clone(), target });
                task.interaction.phase = "stopping".into();
                task.add_comment("operator", format!("Requested {target}; stopping this task's execution before changing its queue."));
            } else {
                change_status(&mut task, target);
            }
        }
        "create" => {
            anyhow::ensure!(!existing, "Task already exists");
            task.add_comment("operator", "Work item created and assigned from the dashboard.");
            if let Some(metadata) = &request.metadata {
                task.runner_metadata = Some(metadata.clone());
            }
        }
        "message" => super::operator_message::enqueue(root, &mut task, request, active.contains(&request.task_id))?,
        "interrupt" => {
            anyhow::ensure!(active.contains(&task.id), "No active agent turn exists for this work item");
            task.interaction.paused = true;
            task.interaction.cancel_requested = true;
            task.interaction.resume_requested = false;
            task.interaction.phase = "interrupting".into();
            task.add_comment("operator", "Interrupt requested. Preserve this session and workspace; wait for the next operator message.");
        }
        "handoff" => {
            anyhow::ensure!(active.contains(&task.id) || matches!(task.status, TaskStatus::Incoming | TaskStatus::InProgress),
                "This historical work item no longer owns its workspace; create a new prepared work item");
            let agent = required(&request.agent, "agent", 180)?;
            validate_agent(root, agent)?;
            anyhow::ensure!(agent != task.agent, "This agent already owns the work item");
            anyhow::ensure!(!AgentConfig::is_paused(root, agent)?, "Agent is paused by operator");
            anyhow::ensure!(task.interaction.handoff.is_none(), "Another handoff is already pending");
            let message = required(&request.message, "handoff message", 65536)?;
            task.interaction.handoff = Some(OperatorHandoff {
                id: request.id.clone(), agent: agent.to_owned(), message: message.to_owned(),
            });
            task.add_comment("operator", format!("Requested handoff to {agent} after the current turn: {message}"));
            if !active.contains(&task.id) { apply_handoff(&mut task); }
        }
        _ => anyhow::bail!("Unsupported operator action"),
    }
    task.interaction.applied_requests.push(request.id.clone());
    if existing { save_task_state(&queues, &file, &task)?; } else { write_task(&file, &task)?; }
    let (_, saved) = locate_task(&queues, &request.task_id)?;
    anyhow::ensure!(saved.interaction.applied_requests.contains(&request.id), "Operator write could not be verified");
    Ok(json!({ "status": if saved.interaction.status_change.is_some() { "pending" } else { "accepted" },
        "taskId": saved.id, "action": request.kind }))
}

pub fn change_status(task: &mut Task, target: TaskStatus) {
    if let Some(error) = task.error.take() {
        task.add_comment("spool:supervisor", format!("Previous recorded error before operator transition: {error}"));
    }
    task.status = if target == TaskStatus::InProgress { TaskStatus::Incoming } else { target };
    task.interaction.paused = false;
    task.interaction.cancel_requested = false;
    task.interaction.resume_requested = false;
    task.interaction.handoff = None;
    task.interaction.status_change = None;
    task.interaction.phase = if task.status == TaskStatus::Incoming { "queued" } else { "ended" }.into();
    if task.status == TaskStatus::Incoming && crate::copilot::process::interactive_enabled() { recover_input(task); }
    if task.status == TaskStatus::Failed { task.error = Some("Marked failed by operator".into()); }
    task.add_comment("operator", format!("Moved to {target}. This is an operator disposition, not proof of agent-verified delivery."));
}

pub fn workspace_held(root: &Path, task: &Task) -> Result<bool> {
    let directory = root.join("controls").join("workspace-holds");
    if !directory.try_exists()? { return Ok(false); }
    for entry in std::fs::read_dir(directory)? {
        let path = entry?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") { continue; }
        let value: Value = serde_json::from_slice(&std::fs::read(path)?)?;
        let agent = value["agent"].as_str().context("Invalid workspace reservation agent")?;
        let workspace = value["workspace"].as_str().context("Invalid workspace reservation path")?;
        let matches = (agent == task.agent && (!task.independent_workspace || value["taskId"] == task.id)) || task.workspace.as_deref().is_some_and(|path|
            std::fs::canonicalize(path).ok().zip(std::fs::canonicalize(workspace).ok()).is_some_and(|(a, b)| a == b));
        if matches && !(value["taskId"] == task.id && value["ready"] == true) { return Ok(true); }
    }
    Ok(false)
}

#[path = "operator_handoff.rs"]
mod handoff;
pub use handoff::{apply_handoff, recover_input};

#[path = "operator_requests.rs"]
mod requests;
pub use requests::process_requests;
#[cfg(test)]
#[path = "operator_tests.rs"]
mod status_tests;
