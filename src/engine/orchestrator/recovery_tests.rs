use super::*;
use crate::copilot::parser::CopilotUsageStats;

#[tokio::test]
async fn scheduler_failure_is_visible_and_persisted() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-scheduler-failure-{}", uuid::Uuid::new_v4()));
    let state = AppState::new();
    let orch = Arc::new(Orchestrator::new(&root, Arc::clone(&state)));
    let (_tx, rx) = mpsc::channel(1);
    assert!(orch.run_supervised(rx).await.is_err());
    assert!(state.read().scheduler_error.as_ref().unwrap().contains("SCHEDULER FAILED"));
    let saved: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("controls").join("scheduler-error.json"))?)?;
    assert!(saved["error"].as_str().unwrap().contains("not being dispatched"));
    QueuePaths::new(root.join("queues")).ensure_dirs()?;
    let orch = Arc::new(Orchestrator::new(&root, Arc::clone(&state)));
    let (tx, rx) = mpsc::channel(1);
    tx.send(()).await?;
    orch.run_supervised(rx).await?;
    assert!(state.read().scheduler_error.is_none());
    assert!(!root.join("controls").join("scheduler-error.json").exists());
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn bundle_settlement_rechecks_completion_but_preserves_operator_disposition() -> Result<()> {
    use crate::models::task::OperatorStatusChange;
    let root = std::env::temp_dir().join(format!("spool-bundle-settlement-{}", uuid::Uuid::new_v4()));
    let orch = Orchestrator::new(&root, AppState::new());
    let paths = QueuePaths::new(&orch.queues_dir);
    paths.ensure_dirs()?;
    for (id, status, operator) in [
        ("implicit", TaskStatus::InProgress, false),
        ("invalidated", TaskStatus::Completed, false),
        ("operator", TaskStatus::InProgress, true),
    ] {
        let mut task = Task::new(id, "perf", "Original", "Preserve");
        task.acceptance = Some(serde_json::json!({"kind": "bundle-v2", "version": 2}));
        task.status = status;
        if operator {
            task.interaction.status_change = Some(OperatorStatusChange {
                request_id: "operator-close".into(), target: TaskStatus::Completed,
            });
        }
        write_task(paths.status_dir(status).join(format!("{id}.json")), &task)?;
        orch.settle_execution(id, "perf", "gpt-5.4", Ok(CopilotExecutionResult {
            exit_code: 0, session_id: "original-session".into(),
            usage: CopilotUsageStats::default(),
        }))?;
        let expected = if operator { TaskStatus::Completed } else { TaskStatus::Failed };
        let saved = read_task(paths.status_dir(expected).join(format!("{id}.json")))?;
        assert_eq!(saved.status, expected);
        assert!(saved.acceptance.is_some());
        if !operator { assert!(saved.error.is_some()); }
    }
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn recovery_finishes_pending_operator_moves_from_every_queue() -> Result<()> {
    use crate::models::task::OperatorStatusChange;
    let root = std::env::temp_dir().join(format!("spool-status-recovery-{}", uuid::Uuid::new_v4()));
    let orch = Orchestrator::new(&root, AppState::new());
    let paths = QueuePaths::new(&orch.queues_dir);
    paths.ensure_dirs()?;
    for (index, source) in [TaskStatus::Incoming, TaskStatus::InProgress, TaskStatus::Completed, TaskStatus::Failed].into_iter().enumerate() {
        let id = format!("task-{index}");
        let mut task = Task::new(&id, "perf", "Original title", "Original prompt");
        task.status = source;
        task.cost.input_tokens = 123;
        task.interaction.status_change = Some(OperatorStatusChange {
            request_id: format!("move-{index}"), target: TaskStatus::Completed,
        });
        write_task(paths.status_dir(source).join(format!("{id}.json")), &task)?;
    }
    orch.recover_interrupted_tasks()?;
    orch.recover_interrupted_tasks()?;
    assert!(list_tasks_in_dir(&paths.incoming).is_empty());
    assert!(list_tasks_in_dir(&paths.in_progress).is_empty());
    assert!(list_tasks_in_dir(&paths.failed).is_empty());
    let recovered = list_tasks_in_dir(&paths.completed);
    assert_eq!(recovered.len(), 4);
    for (_, task) in recovered {
        assert_eq!(task.status, TaskStatus::Completed);
        assert_eq!(task.prompt, "Original prompt");
        assert_eq!(task.cost.input_tokens, 123);
        assert!(task.interaction.status_change.is_none());
        assert_eq!(task.comments.len(), 1);
    }
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn failed_operator_stop_cannot_report_completion() -> Result<()> {
    use crate::models::task::OperatorStatusChange;
    let root = std::env::temp_dir().join(format!("spool-stop-failure-{}", uuid::Uuid::new_v4()));
    let orch = Orchestrator::new(&root, AppState::new());
    let paths = QueuePaths::new(&orch.queues_dir);
    paths.ensure_dirs()?;
    std::fs::create_dir_all(root.join("controls").join("results"))?;
    let mut task = Task::new("task", "perf", "Original", "Preserve");
    task.interaction.status_change = Some(OperatorStatusChange {
        request_id: "move".into(), target: TaskStatus::Completed,
    });
    write_task(paths.in_progress.join("task.json"), &task)?;
    orch.settle_execution("task", "perf", "gpt-5.4", Err(anyhow::anyhow!("Cannot stop task process")))?;
    assert!(!paths.completed.join("task.json").exists());
    let saved = read_task(paths.failed.join("task.json"))?;
    assert!(saved.error.unwrap().contains("Cannot stop"));
    let receipt: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("controls").join("results").join("move.json"))?)?;
    assert_eq!(receipt["result"]["status"], "failed");
    std::fs::remove_dir_all(root)?;
    Ok(())
}
