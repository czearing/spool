use std::path::Path;
use anyhow::{Context, Result};
use crate::models::{AgentConfig, Task, TaskStatus};
use crate::models::task::{ChatReturn, OperatorMessage};
use super::operator::OperatorRequest;

#[cfg(test)]
#[path = "operator_message_tests.rs"]
mod tests;

pub(super) fn enqueue(root: &Path, task: &mut Task, request: &OperatorRequest, active: bool) -> Result<()> {
    let text = request.message.as_deref().context("message is required")?;
    anyhow::ensure!(!text.trim().is_empty() && text.len() <= 65536 && !text.contains('\0'), "Invalid message");
    anyhow::ensure!(task.interaction.status_change.is_none() && task.interaction.handoff.is_none(),
        "Another workflow change is pending");
    super::prepared_message::apply(root, task, request, active)?;
    let historical = matches!(task.status, TaskStatus::Completed | TaskStatus::Failed);
    if historical {
        anyhow::ensure!(task.session_id.is_some() || (request.metadata.is_some() &&
            crate::automation::eligible(root, task)?),
            "No saved provider session or verified deferred PR owner exists; cannot restore this conversation");
        AgentConfig::from_file(root.join("agents").join(format!("{}.md", task.agent)))?;
        let cwd = task.workspace.as_deref().map(Path::new).unwrap_or(root);
        anyhow::ensure!(cwd.is_absolute() && cwd.is_dir(), "Session workspace is unavailable");
        if let Some(config) = &task.session_config { config.validate(cwd, task)?; }
        task.interaction.chat_return = if request.metadata.is_none() {
            Some(ChatReturn { status: task.status, error: task.error.clone() })
        } else { None };
    }
    task.interaction.messages.push(OperatorMessage {
        id: request.id.clone(), text: text.to_owned(), status: "queued".into(),
        created_at: request.created_at, session_id: None, error: None,
    });
    task.add_comment("operator", text);
    if !active {
        if let Some(error) = task.error.take() {
            task.add_comment("spool:supervisor", format!("Operator requested continuation after recorded failure: {error}"));
        }
        task.status = TaskStatus::Incoming;
        task.provider = None;
        task.interaction.paused = false;
        task.interaction.cancel_requested = false;
        task.interaction.resume_requested = false;
        task.interaction.phase = "queued".into();
    } else if task.interaction.cancel_requested {
        task.interaction.resume_requested = true;
    } else {
        task.interaction.paused = false;
    }
    Ok(())
}
