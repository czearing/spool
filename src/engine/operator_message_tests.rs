use super::*;
use crate::models::task::OperatorStatusChange;
use serde_json::json;

#[test]
fn messages_reopen_both_terminal_states_without_replaying_history_or_unpausing_agents() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-message-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("agents"))?;
    std::fs::write(root.join("agents/probe.md"), "Original agent")?;
    std::fs::create_dir_all(root.join("controls/paused"))?;
    std::fs::write(root.join("controls/paused/probe"), "Operator pause")?;
    let result = (|| -> Result<()> {
        for status in [TaskStatus::Completed, TaskStatus::Failed] {
            let mut task = Task::new(status.to_string(), "probe", "Original", "Original assignment");
            task.status = status; task.session_id = Some(format!("session-{status}"));
            task.error = Some("Previous failure".into());
            task.interaction.cancel_requested = true; task.interaction.paused = true;
            task.cost.cache_read_tokens = 100;
            let request: OperatorRequest = serde_json::from_value(json!({
                "id": format!("followup-{status}"), "kind": "message", "taskId": task.id,
                "message": "Only this new message", "createdAt": chrono::Utc::now(),
            }))?;
            let mut saved = task.clone();
            enqueue(&root, &mut saved, &request, false)?;
            assert_eq!(saved.status, TaskStatus::Incoming);
            assert_eq!(saved.session_id, task.session_id);
            assert_eq!(saved.prompt, task.prompt);
            assert_eq!(saved.cost.cache_read_tokens, 100);
            assert_eq!(saved.interaction.messages.len(), 1);
            assert_eq!(saved.interaction.messages[0].text, "Only this new message");
            assert!(!saved.interaction.paused && !saved.interaction.cancel_requested);
            assert!(saved.error.is_none());
            assert_eq!(saved.interaction.chat_return.as_ref().unwrap().status, status);
            assert_eq!(saved.interaction.chat_return.as_ref().unwrap().error, task.error);
            assert!(AgentConfig::is_paused(&root, "probe")?);
        }
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    result
}

#[test]
fn unsafe_resume_rejects_before_acceptance_and_active_completion_races_keep_the_message() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-message-guard-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("agents"))?;
    std::fs::write(root.join("agents/probe.md"), "Probe")?;
    let result = (|| -> Result<()> {
        let mut task = Task::new("original", "probe", "Original", "Original prompt");
        task.status = TaskStatus::Completed;
        let request: OperatorRequest = serde_json::from_value(json!({
            "id": "followup", "kind": "message", "taskId": task.id, "message": "Follow-up", "createdAt": chrono::Utc::now(),
        }))?;
        assert!(enqueue(&root, &mut task, &request, false).is_err());
        task.session_id = Some("saved".into());
        task.workspace = Some(root.join("missing").to_string_lossy().into_owned());
        assert!(enqueue(&root, &mut task, &request, false).is_err());
        task.workspace = None;
        task.interaction.status_change = Some(OperatorStatusChange { request_id: "move".into(), target: TaskStatus::Failed });
        assert!(enqueue(&root, &mut task, &request, true).is_err());
        assert!(task.interaction.messages.is_empty());
        task.interaction.status_change = None;
        enqueue(&root, &mut task, &request, true)?;
        assert_eq!(task.status, TaskStatus::Completed, "Settlement still owns the active execution");
        assert_eq!(task.interaction.messages[0].status, "queued");
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    result
}

#[test]
fn native_followups_wait_for_workspace_admission_for_every_runner() -> Result<()> {
    use crate::copilot::SessionConfig;
    use crate::queue::fs::{locate_task, write_task, QueuePaths};
    let root = std::env::temp_dir().join(format!("spool-review-followup-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("agents"))?;
    std::fs::write(root.join("agents/probe.md"), "Reviewer")?;
    let paths = QueuePaths::new(root.join("queues"));
    paths.ensure_dirs()?;
    let result = (|| -> Result<()> {
        for (runner, status) in ["pr-reviewer", "pr-updater", "perf"].into_iter()
            .flat_map(|runner| [TaskStatus::Completed, TaskStatus::Failed].map(|status| (runner, status))) {
            let mut task = Task::new(format!("{runner}-{status}"), "probe", "Original review", "Original assignment");
            task.status = status;
            task.session_id = Some("original-session".into());
            task.runner_metadata = Some(json!({ "runner": runner, "preparation": {
                "prId": 7, "commit": "original-revision"
            }}));
            let mut config = SessionConfig::capture(&root, &task,
                &AgentConfig::from_file(root.join("agents/probe.md"))?, None)?;
            config.provider = Some(serde_json::from_value(json!({
                "command": std::env::current_exe()?, "args": [], "workingDirectory": "/workspaces/1JS"
            }))?);
            task.session_config = Some(config);
            let request: OperatorRequest = serde_json::from_value(json!({
                "id": format!("followup-{status}"), "kind": "message", "taskId": task.id,
                "message": "Test using Storybook", "createdAt": chrono::Utc::now()
            }))?;
            enqueue(&root, &mut task, &request, false)?;
            assert_eq!(task.status, TaskStatus::Failed, "Do not launch ACP against a workspace awaiting admission");
            assert_eq!(task.interaction.phase, "waiting_preparation");
            assert_eq!(task.interaction.messages[0].status, "queued");
            assert_eq!(task.interaction.messages[0].text, "Test using Storybook");
            assert_eq!(task.session_id.as_deref(), Some("original-session"));
            assert_eq!(task.prompt, "Original assignment");
            assert_eq!(task.runner_metadata.as_ref().unwrap()["preparation"]["commit"], "original-revision");
            assert_eq!(task.interaction.chat_return.as_ref().unwrap().status, status);
            write_task(paths.failed.join(format!("{}.json", task.id)), &task)?;
            let admitted: OperatorRequest = serde_json::from_value(json!({
                "id": format!("admit-{runner}-{status}"), "kind": "status", "taskId": task.id,
                "status": "in_progress", "expectedStatus": "failed",
                "metadata": { "dashboardPrepared": true }, "createdAt": chrono::Utc::now()
            }))?;
            super::super::operator::apply_request(&root, &admitted, &Default::default())?;
            let (_, restored) = locate_task(&paths.base, &task.id)?;
            assert_eq!(restored.status, TaskStatus::Incoming);
            assert_eq!(restored.interaction.chat_return.as_ref().unwrap().status, status);
            assert_eq!(restored.interaction.messages[0].text, "Test using Storybook");
        }
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    result
}

#[test]
fn retry_repairs_a_crash_between_task_write_and_queue_move_without_duplicate_messages() -> Result<()> {
    use crate::queue::fs::{locate_task, write_task, QueuePaths};
    use super::super::operator::apply_request;
    let root = std::env::temp_dir().join(format!("spool-message-crash-{}", uuid::Uuid::new_v4()));
    let paths = QueuePaths::new(root.join("queues"));
    paths.ensure_dirs()?;
    let result = (|| -> Result<()> {
        let mut task = Task::new("original", "probe", "Original", "Original prompt");
        task.session_id = Some("saved".into());
        task.interaction.applied_requests.push("message".into());
        task.interaction.messages.push(OperatorMessage {
            id: "message".into(), text: "New text".into(), status: "queued".into(),
            created_at: chrono::Utc::now(), session_id: None, error: None,
        });
        write_task(paths.completed.join("original.json"), &task)?;
        let request: OperatorRequest = serde_json::from_value(json!({
            "id": "message", "kind": "message", "taskId": "original", "message": "New text", "createdAt": chrono::Utc::now(),
        }))?;
        assert_eq!(apply_request(&root, &request, &Default::default())?["duplicate"], true);
        let (path, restored) = locate_task(&paths.base, "original")?;
        assert_eq!(path, paths.incoming.join("original.json"));
        assert_eq!(restored.interaction.messages.len(), 1);
        assert!(!paths.completed.join("original.json").exists());
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    result
}
