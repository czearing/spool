use super::*;
use crate::engine::operator::{change_status, OperatorRequest};
use crate::engine::operator_message::enqueue;
use serde_json::json;

fn fixture() -> Result<(PathBuf, Orchestrator, QueuePaths, Task, OperatorRequest)> {
    let root = std::env::temp_dir().join(format!("spool-chat-settlement-{}", uuid::Uuid::new_v4()));
    let orch = Orchestrator::new(&root, AppState::new());
    let paths = QueuePaths::new(root.join("queues"));
    paths.ensure_dirs()?;
    std::fs::create_dir_all(root.join("agents"))?;
    std::fs::write(root.join("agents/probe.md"), "Fixture role")?;
    let mut task = Task::new("original", "probe", "Original work", "Keep the original assignment");
    task.status = TaskStatus::Completed;
    task.session_id = Some("original-session".into());
    task.runner_metadata = Some(json!({ "runner": "pr-updater", "key": "original-result" }));
    let request = serde_json::from_value(json!({ "id": "chat", "kind": "message", "taskId": task.id,
        "message": "Explain the result", "createdAt": chrono::Utc::now() }))?;
    Ok((root, orch, paths, task, request))
}

fn success() -> Result<CopilotExecutionResult> {
    Ok(CopilotExecutionResult { exit_code: 0, session_id: "original-session".into(), usage: Default::default() })
}

#[test]
fn completed_and_failed_work_keep_their_prior_outcome_after_an_ordinary_reply() -> Result<()> {
    for status in [TaskStatus::Completed, TaskStatus::Failed] {
        let (root, orch, paths, mut task, request) = fixture()?;
        task.status = status;
        task.error = (status == TaskStatus::Failed).then(|| "Original workflow failure".into());
        task.acceptance = Some(json!({ "historical": "Do not rerun old acceptance for a chat reply" }));
        let original = task.clone();
        enqueue(&root, &mut task, &request, false)?;
        task.interaction.messages[0].status = "delivered".into();
        write_task(paths.in_progress.join("original.json"), &task)?;
        orch.settle_execution(&task.id, "probe", "model", success())?;
        let saved = read_task(paths.status_dir(status).join("original.json"))?;
        assert_eq!(saved.status, status);
        assert_eq!(saved.error, original.error);
        assert_eq!(saved.runner_metadata, original.runner_metadata);
        assert_eq!(saved.acceptance, original.acceptance);
        assert_eq!(saved.session_id, original.session_id);
        assert_eq!(saved.prompt, original.prompt);
        assert!(saved.interaction.chat_return.is_none());
        assert_eq!(saved.interaction.phase, "ended");
        std::fs::remove_dir_all(root)?;
    }
    Ok(())
}

#[test]
fn paused_and_queued_chat_preserve_the_return_outcome_until_the_last_reply_finishes() -> Result<()> {
    for paused in [false, true] {
        let (root, orch, paths, mut task, request) = fixture()?;
        enqueue(&root, &mut task, &request, false)?;
        task.interaction.paused = paused;
        if paused { task.interaction.messages[0].status = "delivered".into(); }
        write_task(paths.in_progress.join("original.json"), &task)?;
        orch.settle_execution(&task.id, "probe", "model", success())?;
        let pending = if paused { &paths.in_progress } else { &paths.incoming };
        let file = pending.join("original.json");
        let mut saved = read_task(&file)?;
        assert!(saved.error.is_none());
        assert_eq!(saved.interaction.chat_return.as_ref().unwrap().status, TaskStatus::Completed);
        std::fs::remove_file(file)?;
        saved.interaction.paused = false;
        saved.interaction.messages[0].status = "delivered".into();
        write_task(paths.in_progress.join("original.json"), &saved)?;
        orch.settle_execution(&saved.id, "probe", "model", success())?;
        assert_eq!(read_task(paths.completed.join("original.json"))?.status, TaskStatus::Completed);
        std::fs::remove_dir_all(root)?;
    }
    Ok(())
}

#[test]
fn provider_failures_are_not_hidden_by_a_successful_previous_workflow() -> Result<()> {
    for launch_error in [false, true] {
        let (root, orch, paths, mut task, request) = fixture()?;
        enqueue(&root, &mut task, &request, false)?;
        write_task(paths.in_progress.join("original.json"), &task)?;
        let outcome = if launch_error { Err(anyhow::anyhow!("Provider launch failed")) }
            else { Ok(CopilotExecutionResult { exit_code: 7, session_id: "original-session".into(), usage: Default::default() }) };
        orch.settle_execution(&task.id, "probe", "model", outcome)?;
        let saved = read_task(paths.failed.join("original.json"))?;
        assert!(saved.error.as_deref().unwrap().contains(if launch_error { "launch failed" } else { "code 7" }));
        assert!(saved.interaction.chat_return.is_none());
        std::fs::remove_dir_all(root)?;
    }
    Ok(())
}

#[test]
fn messages_during_automation_do_not_bypass_explicit_results_and_operator_status_wins() -> Result<()> {
    let (root, orch, paths, mut task, request) = fixture()?;
    task.status = TaskStatus::InProgress;
    enqueue(&root, &mut task, &request, true)?;
    assert!(task.interaction.chat_return.is_none());
    task.interaction.messages[0].status = "delivered".into();
    write_task(paths.in_progress.join("original.json"), &task)?;
    orch.settle_execution(&task.id, "probe", "model", success())?;
    assert!(read_task(paths.failed.join("original.json"))?.error.unwrap().contains("explicit task result"));
    task.status = TaskStatus::Completed;
    enqueue(&root, &mut task, &request, false)?;
    change_status(&mut task, TaskStatus::Failed);
    assert!(task.interaction.chat_return.is_none());
    assert_eq!(task.status, TaskStatus::Failed);
    std::fs::remove_dir_all(root)?;
    Ok(())
}
