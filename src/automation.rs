use std::path::Path;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use crate::models::{AgentConfig, Task, TaskStatus};
use crate::queue::fs::{locate_task, read_task, write_json, write_task, QueuePaths, TaskGuard, validate_id};

fn read(file: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(&std::fs::read(file)?)?)
}

fn same_path(left: &str, right: &str) -> bool {
    std::fs::canonicalize(left).ok().zip(std::fs::canonicalize(right).ok())
        .is_some_and(|(a, b)| a == b)
}

pub fn reserve(root: &Path, id: &str, agent: &str, title: &str, workspace: &str, branch: &str, commit: &str) -> Result<Value> {
    validate_id(id)?;
    AgentConfig::pause_path(root, agent)?;
    let role = AgentConfig::from_file(root.join("agents").join(format!("{agent}.md")))?;
    anyhow::ensure!(role.name == agent && agent != "pr-reviewer" && !agent.starts_with("pr-updater"), "Invalid original owner");
    anyhow::ensure!(!title.trim().is_empty() && title.len() <= 400, "Invalid owner title");
    let cwd = Path::new(workspace);
    anyhow::ensure!(cwd.is_absolute() && cwd.join(".git").exists() &&
        commit.len() == 40 && commit.bytes().all(|c| c.is_ascii_hexdigit()), "Owner repository/revision is unavailable");
    crate::copilot::SessionConfig::verify_preparation(cwd, branch, commit)?;
    let queues = QueuePaths::new(root.join("queues"));
    queues.ensure_dirs()?;
    let _guard = TaskGuard::acquire(&queues.base, id)?;
    let context_file = root.join(".runner-receipts/creator-contexts").join(format!("{id}.json"));
    std::fs::create_dir_all(root.join(".runner-receipts/native-creators"))?;
    let existing = [TaskStatus::Incoming, TaskStatus::InProgress, TaskStatus::Completed, TaskStatus::Failed]
        .iter().any(|status| queues.status_dir(*status).join(format!("{id}.json")).exists());
    let task = if existing {
        let (_, task) = locate_task(&queues.base, id)?;
        anyhow::ensure!(task.deferred_pr_owner && task.agent == agent && task.session_id.is_none() &&
            task.session_config.is_none() && task.provider.is_none() && task.turns == 0 && task.status == TaskStatus::Completed &&
            task.workspace.as_deref().is_some_and(|path| same_path(path, workspace)),
            "Reservation belongs to a different or already activated owner");
        task
    } else {
        let mut task = Task::new(id, agent, title, "Automated prose-only PR creation.");
        task.workspace = Some(workspace.to_owned());
        task.status = TaskStatus::Completed;
        task.deferred_pr_owner = true;
        task.add_comment("spool:automation", "Dormant PR owner reserved without executing an agent.");
        write_task(queues.completed.join(format!("{id}.json")), &task)?;
        task
    };
    let context = json!({
        "version": 2, "originKind": "spool_automation", "taskId": id, "agent": agent,
        "sessionId": null, "workspace": workspace, "branch": branch, "commit": commit,
        "nativeRoot": root, "receiptDirectory": root.join(".runner-receipts/native-creators"),
        "originalPrompt": task.prompt, "deferred": true,
    });
    if context_file.exists() {
        anyhow::ensure!(read(&context_file)? == context, "Reservation cannot be rebound to another branch or revision");
    } else {
        std::fs::create_dir_all(context_file.parent().unwrap())?;
        write_json(&context_file, &context)?;
    }
    Ok(json!({ "taskId": id, "contextFile": context_file, "deferred": true }))
}

pub fn eligible(root: &Path, task: &Task) -> Result<bool> {
    if !task.deferred_pr_owner || task.session_id.is_some() { return Ok(false); }
    anyhow::ensure!(task.turns == 0 && task.session_config.is_none() && task.provider.is_none(),
        "Deferred owner already has execution history");
    let context = read(&root.join(".runner-receipts/creator-contexts").join(format!("{}.json", task.id)))?;
    let owner = read(&root.join(".runner-receipts/native-creators").join(format!("{}.json", task.id)))?;
    anyhow::ensure!(context["originKind"] == "spool_automation" && context["deferred"] == true &&
        context["taskId"] == task.id && context["agent"] == task.agent &&
        owner["originKind"] == "spool_automation" && owner["verified"] == true && owner["deferred"] == true &&
        owner["taskId"] == task.id && owner["agent"] == task.agent && owner["sessionId"].is_null() &&
        owner["branch"] == context["branch"] &&
        owner["prId"].as_str().is_some_and(|id| !id.is_empty() && id.bytes().all(|c| c.is_ascii_digit())) &&
        owner["prUrl"].as_str().is_some_and(|url| url.starts_with("https://")) &&
        owner["originId"].as_str().is_some_and(|id| uuid::Uuid::parse_str(id).is_ok()) &&
        task.workspace.as_deref().zip(context["workspace"].as_str()).is_some_and(|(a, b)| same_path(a, b)) &&
        owner["workspace"].as_str().zip(context["workspace"].as_str()).is_some_and(|(a, b)| same_path(a, b)),
        "Deferred owner lacks verified native creation evidence");
    Ok(true)
}

pub fn bind_session(root: &Path, task: &Task, session_id: &str) -> Result<()> {
    if !task.deferred_pr_owner { return Ok(()); }
    let file = root.join(".runner-receipts/native-creators").join(format!("{}.json", task.id));
    let mut owner = read(&file)?;
    anyhow::ensure!(owner["originKind"] == "spool_automation" && owner["verified"] == true &&
        owner["taskId"] == task.id && owner["agent"] == task.agent &&
        task.session_id.as_deref() == Some(session_id), "Session does not belong to this automated PR owner");
    if !owner["sessionId"].is_null() {
        anyhow::ensure!(owner["sessionId"] == session_id, "Original session cannot be replaced");
        return Ok(());
    }
    anyhow::ensure!(owner["deferred"] == true, "PR owner is not awaiting its first session");
    owner["sessionId"] = json!(session_id);
    owner["deferred"] = json!(false);
    owner["activatedAt"] = json!(chrono::Utc::now());
    write_json(file, &owner)?;
    Ok(())
}

#[cfg(test)]
#[path = "automation_tests.rs"]
mod tests;
