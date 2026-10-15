use std::path::Path;
use anyhow::{Context, Result};
use crate::models::Task;
use super::operator::OperatorRequest;

pub(super) fn resolve(root: &Path, task: &mut Task, request: &OperatorRequest, active: bool) -> Result<()> {
    let metadata = request.metadata.as_ref().and_then(|value| value.as_object())
        .context("Message recovery requires a message identity and decision")?;
    anyhow::ensure!(metadata.len() == 2, "Invalid message recovery fields");
    let id = metadata.get("messageId").and_then(|value| value.as_str()).context("Message identity is required")?;
    crate::queue::fs::validate_id(id)?;
    let decision = metadata.get("decision").and_then(|value| value.as_str()).context("Recovery decision is required")?;
    anyhow::ensure!(matches!(decision, "retry" | "dismiss"), "Choose retry or dismiss");
    let index = task.interaction.messages.iter().position(|message| message.id == id)
        .context("Message not found")?;
    anyhow::ensure!(task.interaction.messages[index].status == "delivery_uncertain",
        "This message's delivery state changed; refresh before resolving it");
    if decision == "retry" {
        let mut message = request.clone();
        message.kind = "message".into();
        message.metadata = None;
        message.message = Some(task.interaction.messages[index].text.clone());
        super::operator_message::enqueue(root, task, &message, active)?;
    }
    // Keep the original uncertainty and text for audit; do not claim delivery.
    task.interaction.messages[index].status = if decision == "retry" { "retried" } else { "dismissed" }.into();
    task.add_comment("operator", format!("Resolved uncertain message {id}: {}.",
        if decision == "retry" { "explicitly requested one resend" } else { "left unsent; delivery remains unconfirmed" }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{TaskStatus, task::OperatorMessage};
    use crate::queue::fs::{locate_task, write_task, QueuePaths};
    use serde_json::json;

    #[test]
    fn decisions_are_explicit_atomic_and_idempotent_without_replaying_history() -> Result<()> {
        let root = std::env::temp_dir().join(format!("spool-message-resolution-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("agents"))?;
        std::fs::write(root.join("agents/probe.md"), "Probe")?;
        let paths = QueuePaths::new(root.join("queues"));
        paths.ensure_dirs()?;
        let result = (|| -> Result<()> {
            for decision in ["retry", "dismiss"] {
                let mut task = Task::new(decision, "probe", "Original", "Never replay assignment");
                task.status = TaskStatus::Completed;
                task.session_id = Some("preserved-session".into());
                task.interaction.messages.push(OperatorMessage {
                    id: "uncertain".into(), text: "Only this message".into(), status: "delivery_uncertain".into(),
                    created_at: chrono::Utc::now(), session_id: task.session_id.clone(), error: Some("Original uncertainty".into()),
                });
                write_task(paths.completed.join(format!("{decision}.json")), &task)?;
                let request: OperatorRequest = serde_json::from_value(json!({
                    "id": format!("resolve-{decision}"), "kind": "resolve_message", "taskId": decision,
                    "metadata": { "messageId": "uncertain", "decision": decision }, "createdAt": chrono::Utc::now(),
                }))?;
                // Test the control directly to avoid changing the process-wide interactive setting.
                resolve(&root, &mut task, &request, false)?;
                task.interaction.applied_requests.push(request.id.clone());
                write_task(paths.completed.join(format!("{decision}.json")), &task)?;
                super::super::operator::apply_request(&root, &request, &Default::default())?;
                let (file, saved) = locate_task(&paths.base, decision)?;
                assert_eq!(saved.session_id.as_deref(), Some("preserved-session"));
                assert_eq!(saved.prompt, "Never replay assignment");
                assert_eq!(saved.interaction.messages[0].error.as_deref(), Some("Original uncertainty"));
                if decision == "retry" {
                    assert_eq!(file, paths.incoming.join("retry.json"));
                    assert_eq!(saved.interaction.messages[0].status, "retried");
                    assert_eq!(saved.interaction.messages.len(), 2);
                    assert_eq!(saved.interaction.messages[1].text, "Only this message");
                    assert_eq!(saved.interaction.messages[1].id, request.id);
                } else {
                    assert_eq!(file, paths.completed.join("dismiss.json"));
                    assert_eq!(saved.interaction.messages[0].status, "dismissed");
                    assert_eq!(saved.interaction.messages.len(), 1);
                }
                let mut changed = request.clone();
                changed.id = "another-decision".into();
                let mut saved = saved;
                assert!(resolve(&root, &mut saved, &changed, false).is_err());
            }
            Ok(())
        })();
        std::fs::remove_dir_all(root)?;
        result
    }

    #[test]
    fn unsafe_resends_and_non_uncertain_messages_are_rejected_without_changing_history() -> Result<()> {
        let root = std::env::temp_dir().join(format!("spool-message-resolution-guards-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("agents"))?;
        std::fs::write(root.join("agents/probe.md"), "Probe")?;
        let result = (|| -> Result<()> {
            let mut task = Task::new("original", "probe", "Original", "Never replay");
            task.status = TaskStatus::Completed;
            task.interaction.messages.push(OperatorMessage {
                id: "uncertain".into(), text: "New input".into(), status: "delivery_uncertain".into(),
                created_at: chrono::Utc::now(), session_id: None, error: Some("Unconfirmed".into()),
            });
            let request: OperatorRequest = serde_json::from_value(json!({
                "id": "resolve", "kind": "resolve_message", "taskId": task.id,
                "metadata": { "messageId": "uncertain", "decision": "retry" }, "createdAt": chrono::Utc::now(),
            }))?;
            for unsafe_workspace in [false, true] {
                if unsafe_workspace {
                    task.session_id = Some("saved".into());
                    task.workspace = Some(root.join("missing").to_string_lossy().into_owned());
                }
                let before = serde_json::to_value(&task)?;
                assert!(resolve(&root, &mut task, &request, false).is_err());
                assert_eq!(serde_json::to_value(&task)?, before);
            }
            for state in ["queued", "delivering", "delivered", "failed", "retried", "dismissed"] {
                task.interaction.messages[0].status = state.into();
                let before = serde_json::to_value(&task)?;
                for decision in ["retry", "dismiss"] {
                    let mut invalid = request.clone();
                    invalid.metadata = Some(json!({ "messageId": "uncertain", "decision": decision }));
                    assert!(resolve(&root, &mut task, &invalid, false).is_err());
                    assert_eq!(serde_json::to_value(&task)?, before);
                }
            }
            task.interaction.messages[0].status = "delivery_uncertain".into();
            task.interaction.paused = true;
            task.interaction.cancel_requested = true;
            let mut dismiss = request.clone();
            dismiss.metadata = Some(json!({ "messageId": "missing", "decision": "dismiss" }));
            assert!(resolve(&root, &mut task, &dismiss, false).is_err());
            dismiss.metadata = Some(json!({ "messageId": "uncertain", "decision": "dismiss" }));
            resolve(&root, &mut task, &dismiss, false)?;
            assert_eq!(task.status, TaskStatus::Completed);
            assert!(task.interaction.paused && task.interaction.cancel_requested);
            assert_eq!(task.interaction.messages.len(), 1);
            assert_eq!(task.interaction.messages[0].status, "dismissed");
            Ok(())
        })();
        std::fs::remove_dir_all(root)?;
        result
    }
}
