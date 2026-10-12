use std::path::{Path, PathBuf};
use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use crate::models::{AgentConfig, Task, TaskStatus};
use super::operator::OperatorRequest;
use crate::queue::fs::{read_task, QueuePaths};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreparedMessage {
    key: String,
    session_id: Option<String>,
    expected_updated_at: chrono::DateTime<chrono::Utc>,
    agent: String,
    workspace: String,
    metadata: Value,
}

fn same_path(a: &str, b: &str) -> bool {
    let normalize = |value: &str| {
        let path = match std::fs::canonicalize(value) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => PathBuf::from(value),
            Err(_) => return None,
        };
        #[cfg(windows)]
        let path = PathBuf::from(path.to_string_lossy().to_lowercase());
        Some(path)
    };
    normalize(a).zip(normalize(b)).is_some_and(|(a, b)| a == b)
}

pub(super) fn apply(root: &Path, task: &mut Task, request: &OperatorRequest, active: bool) -> Result<()> {
    let Some(value) = &request.metadata else { return Ok(()); };
    let prepared: PreparedMessage = serde_json::from_value(value.clone()).context("Invalid prepared message")?;
    anyhow::ensure!(!active && matches!(task.status, TaskStatus::Completed | TaskStatus::Failed),
        "Prepared continuation requires an idle terminal task");
    anyhow::ensure!(!AgentConfig::is_paused(root, &task.agent)?, "Agent is paused by operator");
    anyhow::ensure!(prepared.agent == task.agent && task.session_id == prepared.session_id,
        "Prepared continuation must preserve its agent and session");
    if prepared.session_id.is_none() {
        anyhow::ensure!(crate::automation::eligible(root, task)?, "No original or deferred PR owner exists");
        let owner: Value = serde_json::from_slice(&std::fs::read(root.join(".runner-receipts/native-creators").join(format!("{}.json", task.id)))?)?;
        anyhow::ensure!(prepared.metadata["runner"] == "pr-updater" &&
            prepared.metadata["contract"]["prId"] == owner["prId"] &&
            prepared.metadata["contract"]["branch"] == owner["branch"],
            "A deferred owner can start only through its verified PR contract");
    }
    anyhow::ensure!(task.updated_at == prepared.expected_updated_at, "Task changed after runner preparation");
    anyhow::ensure!(!prepared.key.trim().is_empty() && prepared.key.len() <= 4096, "Invalid submission key");
    anyhow::ensure!(!task.interaction.messages.iter().any(|message|
        matches!(message.status.as_str(), "queued" | "delivering" | "delivery_uncertain")),
        "Original conversation has pending or uncertain input; runner continuation held");
    let cwd = Path::new(&prepared.workspace);
    anyhow::ensure!(cwd.is_absolute() && cwd.is_dir(), "Prepared workspace is unavailable");
    let metadata = &prepared.metadata;
    anyhow::ensure!(metadata.is_object(), "Runner metadata must be an object");
    let preparation = &metadata["preparation"];
    let branch = preparation["branch"].as_str().filter(|s| !s.is_empty()).context("Prepared branch is required")?;
    let commit = preparation["commit"].as_str().filter(|s| !s.is_empty()).context("Prepared commit is required")?;
    anyhow::ensure!(preparation["ready"] == true &&
        preparation["repoRoot"].as_str().is_some_and(|path| same_path(path, &prepared.workspace)),
        "Runner workspace preparation is not verified");
    crate::copilot::SessionConfig::verify_preparation(cwd, branch, commit)?;
    if metadata["runner"] == "pr-updater" {
        let contract = &metadata["contract"];
        anyhow::ensure!(contract["submissionId"] == prepared.key && contract["identifier"] == task.id &&
            contract["agent"] == task.agent && contract["branch"] == branch &&
            contract["cwd"].as_str().is_some_and(|path| same_path(path, &prepared.workspace)),
            "PR contract does not match its original task and prepared workspace");
    }
    let previous = task.metadata(root)?;
    if let Some(acceptance) = &task.acceptance {
        anyhow::ensure!(metadata.get("acceptance").is_none_or(|value| value == acceptance),
            "Continuation cannot replace the original acceptance contract");
        anyhow::ensure!(previous.as_ref().is_some_and(|value| value["preparation"]["branch"] == branch),
            "Continuation cannot replace the original bundle branch");
    } else {
        anyhow::ensure!(metadata.get("acceptance").is_none_or(Value::is_null),
            "Continuation cannot introduce an acceptance contract");
    }
    let old_workspace = task.workspace.as_deref().unwrap_or_else(|| root.to_str().unwrap_or(""));
    if !same_path(old_workspace, &prepared.workspace) {
        let migration = &metadata["workspaceMigration"];
        let assigned = migration["reason"] == "assigned_agent_workspace" &&
            migration["assignedWorkspace"].as_str().is_some_and(|path| same_path(path, &prepared.workspace));
        anyhow::ensure!((assigned || migration["reason"] == "isolated_pr_workspace") &&
            (migration["previousWorkspace"].as_str().is_some_and(|path| same_path(path, old_workspace)) ||
                (assigned && migration["originalWorkspace"].as_str().is_some_and(|path| same_path(path, old_workspace)))),
            "Spool continuation must preserve its workspace unless migration is verified");
        if let Some(config) = &mut task.session_config {
            config.workspace = std::fs::canonicalize(cwd)?.to_string_lossy().into_owned();
        }
    }
    if metadata["independentWorkspace"] == true {
        anyhow::ensure!(metadata["runner"] == "pr-updater", "Independent continuation requires a PR contract");
    }
    let queues = QueuePaths::new(root.join("queues"));
    for directory in [&queues.incoming, &queues.in_progress] {
        if !directory.try_exists()? { continue; }
        for entry in std::fs::read_dir(directory)? {
            let file = entry?.path();
            if file.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
            let other = read_task(&file)?;
            if other.id == task.id { continue; }
            anyhow::ensure!(!((task.session_id.is_some() && other.session_id == task.session_id) ||
                other.workspace.as_deref().is_some_and(|path| same_path(path, &prepared.workspace)) ||
                (other.agent == task.agent && metadata["independentWorkspace"] != true)),
                "Workspace/agent/session is owned by Spool task {}; preparation held", other.id);
        }
    }
    task.workspace = Some(prepared.workspace);
    task.independent_workspace = metadata["independentWorkspace"] == true;
    let mut receipt = metadata.clone();
    receipt["key"] = json!(prepared.key);
    receipt["taskId"] = json!(task.id);
    receipt["phase"] = json!("published");
    receipt["publishedAt"] = json!(chrono::Utc::now());
    if let Some(acceptance) = &task.acceptance { receipt["acceptance"] = acceptance.clone(); }
    receipt.as_object_mut().unwrap().remove("payload");
    receipt.as_object_mut().unwrap().remove("previous");
    task.runner_metadata = Some(receipt);
    Ok(())
}

#[cfg(test)]
#[path = "prepared_message_tests.rs"]
mod tests;
