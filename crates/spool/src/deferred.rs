use crate::models::{AgentConfig, Task, TaskStatus};
use crate::queue::fs::{locate_task, validate_id, write_json, write_task, QueuePaths, TaskGuard};
use anyhow::Result;
use serde_json::{json, Value};
use std::path::Path;

pub fn reserve(
    root: &Path,
    id: &str,
    agent: &str,
    title: &str,
    prompt: &str,
    workspace: &str,
) -> Result<Value> {
    validate_id(id)?;
    AgentConfig::pause_path(root, agent)?;
    let role = AgentConfig::from_file(root.join("agents").join(format!("{agent}.md")))?;
    anyhow::ensure!(role.name == agent, "Invalid agent");
    anyhow::ensure!(
        !title.trim().is_empty() && title.len() <= 400 && !prompt.trim().is_empty(),
        "A reserved task requires a title and prompt"
    );
    let cwd = Path::new(workspace);
    anyhow::ensure!(
        cwd.is_absolute() && cwd.is_dir(),
        "Reserved workspace is unavailable"
    );
    let queues = QueuePaths::new(root.join("queues"));
    queues.ensure_dirs()?;
    let _guard = TaskGuard::acquire(&queues.base, id)?;
    let exists = [
        TaskStatus::Incoming,
        TaskStatus::InProgress,
        TaskStatus::Completed,
        TaskStatus::Failed,
    ]
    .iter()
    .any(|status| {
        queues
            .status_dir(*status)
            .join(format!("{id}.json"))
            .exists()
    });
    if exists {
        let (_, task) = locate_task(&queues.base, id)?;
        anyhow::ensure!(
            eligible(&task)?
                && task.status == TaskStatus::Completed
                && task.agent == agent
                && task.prompt == prompt
                && task.workspace.as_deref().is_some_and(
                    |path| std::fs::canonicalize(path).ok() == std::fs::canonicalize(cwd).ok()
                ),
            "Reservation belongs to a different or already activated task"
        );
    } else {
        let mut task = Task::new(id, agent, title, prompt);
        task.workspace = Some(workspace.to_owned());
        task.status = TaskStatus::Completed;
        task.deferred_session = true;
        write_task(queues.completed.join(format!("{id}.json")), &task)?;
    }
    let file = root
        .join("controls")
        .join("executions")
        .join(format!("{id}.json"));
    std::fs::create_dir_all(file.parent().unwrap())?;
    write_json(
        &file,
        &json!({ "version": 1, "taskId": id, "agent": agent,
        "sessionId": null, "workspace": workspace, "projectRoot": root, "deferred": true }),
    )?;
    Ok(json!({ "taskId": id, "contextFile": file, "deferred": true }))
}

pub fn eligible(task: &Task) -> Result<bool> {
    if !task.deferred_session || task.session_id.is_some() {
        return Ok(false);
    }
    anyhow::ensure!(
        task.turns == 0 && task.session_config.is_none() && task.provider.is_none(),
        "Reserved task already has execution history"
    );
    Ok(true)
}

#[cfg(test)]
#[path = "deferred_tests.rs"]
mod tests;
