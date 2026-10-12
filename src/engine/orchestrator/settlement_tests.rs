use super::*;
use crate::copilot::parser::CopilotUsageStats;

#[test]
fn settlement_preserves_latest_comments_ledger_and_queue_disposition() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-settlement-{}", uuid::Uuid::new_v4()));
    let orch = Orchestrator::new(&root, AppState::new());
    let paths = QueuePaths::new(&orch.queues_dir);
    paths.ensure_dirs()?;
    for (index, status) in [TaskStatus::InProgress, TaskStatus::Incoming, TaskStatus::Completed, TaskStatus::Failed].into_iter().enumerate() {
        let id = format!("task-{index}");
        let mut task = Task::new(&id, "perf", "Test", "Original");
        task.add_comment("perf", "Comment written by MCP");
        task.cost.input_tokens = 100;
        task.cost.total_cost_usd = 2.0;
        task.turns = 4;
        write_task(paths.status_dir(status).join(format!("{id}.json")), &task)?;
        orch.settle_execution(&id, "perf", "gpt-5.4", Ok(CopilotExecutionResult {
            exit_code: 0, session_id: "provider-session".into(),
            usage: CopilotUsageStats { input_tokens: 20, output_tokens: 10, turns: 2, ..Default::default() },
        }))?;
        let expected = if status == TaskStatus::InProgress { TaskStatus::Completed } else { status };
        let saved = read_task(paths.status_dir(expected).join(format!("{id}.json")))?;
        assert_eq!(saved.status, expected);
        assert_eq!(saved.comments[0].message, "Comment written by MCP");
        assert_eq!(saved.cost.input_tokens, 120);
        assert_eq!(saved.cost.total_cost_usd, 2.0, "Legacy estimates must not receive invented new charges");
        assert_eq!(saved.turns, 6);
        assert_eq!(saved.session_id.as_deref(), Some("provider-session"));
    }
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn execution_failures_preserve_latest_task_instead_of_stale_launch_snapshot() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-failed-settlement-{}", uuid::Uuid::new_v4()));
    let orch = Orchestrator::new(&root, AppState::new());
    let paths = QueuePaths::new(&orch.queues_dir);
    paths.ensure_dirs()?;
    for exit_code in [None, Some(7)] {
        let mut task = Task::new("failure", "perf", "Test", "Original");
        task.add_comment("perf", "Diagnostic evidence");
        write_task(paths.in_progress.join("failure.json"), &task)?;
        let outcome = match exit_code {
            None => Err(anyhow::anyhow!("CLI launch failed")),
            Some(code) => Ok(CopilotExecutionResult { exit_code: code, session_id: "session".into(), usage: Default::default() }),
        };
        orch.settle_execution("failure", "perf", "gpt-5.4", outcome)?;
        let file = paths.failed.join("failure.json");
        let saved = read_task(&file)?;
        assert_eq!(saved.status, TaskStatus::Failed);
        assert_eq!(saved.comments[0].message, "Diagnostic evidence");
        assert!(saved.error.is_some());
        std::fs::remove_file(file)?;
    }
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn runner_owned_tasks_require_explicit_completion_not_a_successful_process_exit() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-explicit-result-{}", uuid::Uuid::new_v4()));
    let orch = Orchestrator::new(&root, AppState::new());
    let paths = QueuePaths::new(&orch.queues_dir);
    paths.ensure_dirs()?;
    std::fs::create_dir_all(root.join(".runner-receipts"))?;
    for (id, status) in [("implicit", TaskStatus::InProgress), ("explicit", TaskStatus::Completed), ("failed", TaskStatus::Failed)] {
        let mut task = Task::new(id, "perf", "Test", "Publish and record the result");
        task.add_comment("perf", "Evidence retained");
        write_task(paths.status_dir(status).join(format!("{id}.json")), &task)?;
        std::fs::write(root.join(".runner-receipts").join(format!("task-{id}.json")), "{}")?;
        orch.settle_execution(id, "perf", "gpt-5.4", Ok(CopilotExecutionResult {
            exit_code: 0, session_id: "original-session".into(), usage: Default::default(),
        }))?;
        let expected = if status == TaskStatus::InProgress { TaskStatus::Failed } else { status };
        let saved = read_task(paths.status_dir(expected).join(format!("{id}.json")))?;
        assert_eq!(saved.status, expected);
        assert_eq!(saved.session_id.as_deref(), Some("original-session"));
        assert_eq!(saved.comments[0].message, "Evidence retained");
        if id == "implicit" {
            assert!(saved.error.as_deref().unwrap().contains("explicit"));
        }
    }
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn explicit_completion_policy_preserves_operator_controls_and_handoffs() -> Result<()> {
    use crate::models::task::{OperatorHandoff, OperatorMessage};
    let root = std::env::temp_dir().join(format!("spool-controlled-result-{}", uuid::Uuid::new_v4()));
    let orch = Orchestrator::new(&root, AppState::new());
    let paths = QueuePaths::new(&orch.queues_dir);
    paths.ensure_dirs()?;
    std::fs::create_dir_all(root.join(".runner-receipts"))?;
    for id in ["paused", "message", "operator-handoff", "mcp-handoff"] {
        let mut task = Task::new(id, "perf", "Test", "Original brief");
        let status = if id == "mcp-handoff" { TaskStatus::Incoming } else { TaskStatus::InProgress };
        match id {
            "paused" => task.interaction.paused = true,
            "message" => task.interaction.messages.push(OperatorMessage {
                id: "follow-up".into(), text: "Continue".into(), status: "queued".into(),
                created_at: chrono::Utc::now(), session_id: None, error: None,
            }),
            "operator-handoff" => task.interaction.handoff = Some(OperatorHandoff {
                id: "handoff".into(), agent: "writer".into(), message: "Continue with the original evidence".into(),
            }),
            "mcp-handoff" => task.agent = "writer".into(),
            _ => unreachable!(),
        }
        write_task(paths.status_dir(status).join(format!("{id}.json")), &task)?;
        std::fs::write(root.join(".runner-receipts").join(format!("task-{id}.json")), "{}")?;
        orch.settle_execution(id, "perf", "gpt-5.4", Ok(CopilotExecutionResult {
            exit_code: 0, session_id: "original-session".into(), usage: Default::default(),
        }))?;
        let expected = if id == "paused" { TaskStatus::InProgress } else { TaskStatus::Incoming };
        let saved = read_task(paths.status_dir(expected).join(format!("{id}.json")))?;
        assert_eq!(saved.status, expected);
        assert!(saved.error.is_none());
        assert_eq!(saved.session_id.as_deref(), Some("original-session"));
        if id.ends_with("handoff") { assert_eq!(saved.agent, "writer"); }
    }
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn claiming_uses_the_current_role_and_holds_work_when_the_role_is_missing() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-role-refresh-{}", uuid::Uuid::new_v4()));
    let orch = Orchestrator::new(&root, AppState::new());
    let paths = QueuePaths::new(&orch.queues_dir);
    paths.ensure_dirs()?;
    std::fs::create_dir_all(&orch.agents_dir)?;
    let role = orch.agents_dir.join("perf.md");
    std::fs::write(&role, "Original instructions")?;
    orch.state.write().agents.insert("perf".into(), AgentConfig::from_file(&role)?);
    let task = Task::new("updated-role", "perf", "Test", "Do work");
    write_task(paths.incoming.join("updated-role.json"), &task)?;
    std::fs::remove_file(&role)?;
    assert!(orch.claim_task("perf", &list_tasks_in_dir(&paths.incoming)).is_err());
    assert!(paths.incoming.join("updated-role.json").exists());
    std::fs::write(&role, "---\nmodel: fixture-model\n---\nCorrected instructions")?;
    let (_, _, executing_role) = orch.claim_task("perf", &list_tasks_in_dir(&paths.incoming))?.unwrap();
    assert_eq!(executing_role.system_prompt, "Corrected instructions");
    assert_eq!(executing_role.model, "fixture-model");
    let state = orch.state.read();
    assert_eq!(state.agents["perf"].system_prompt, "Corrected instructions");
    assert_eq!(state.agents["perf"].model, "fixture-model");
    drop(state);
    let next = Task::new("next-role", "perf", "Test", "Next task");
    write_task(paths.incoming.join("next-role.json"), &next)?;
    std::fs::write(&role, "Later instructions")?;
    assert!(orch.claim_task("perf", &list_tasks_in_dir(&paths.incoming))?.is_none());
    assert_eq!(executing_role.system_prompt, "Corrected instructions");
    orch.state.write().remove_active_task("updated-role");
    let (_, _, next_role) = orch.claim_task("perf", &list_tasks_in_dir(&paths.incoming))?.unwrap();
    assert_eq!(next_role.system_prompt, "Later instructions");
    std::fs::remove_dir_all(root)?;
    Ok(())
}
