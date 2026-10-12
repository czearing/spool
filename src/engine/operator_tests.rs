use super::*;
use crate::queue::fs::read_task;

#[test]
fn creation_and_assignment_preserve_task_instructions_and_session() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-assignment-{}", uuid::Uuid::new_v4()));
    let paths = QueuePaths::new(root.join("queues"));
    paths.ensure_dirs()?;
    std::fs::create_dir_all(root.join("agents"))?;
    for agent in ["first", "second"] {
        std::fs::write(root.join("agents").join(format!("{agent}.md")), "Fixture")?;
    }
    let result = (|| -> Result<()> {
        let create: OperatorRequest = serde_json::from_value(json!({
            "id": "create", "kind": "create", "taskId": "original", "agent": "first",
            "title": "Created task", "prompt": "Original instructions", "workspace": root,
            "createdAt": chrono::Utc::now(),
        }))?;
        assert_eq!(apply_request(&root, &create, &HashSet::new())?["status"], "accepted");
        let (file, mut task) = locate_task(&paths.base, "original")?;
        task.session_id = Some(uuid::Uuid::new_v4().to_string());
        write_task(&file, &task)?;
        let assign: OperatorRequest = serde_json::from_value(json!({
            "id": "assign", "kind": "handoff", "taskId": "original", "agent": "second",
            "message": "Assigned from Tasks", "createdAt": chrono::Utc::now(),
        }))?;
        assert_eq!(apply_request(&root, &assign, &HashSet::new())?["status"], "accepted");
        let saved = locate_task(&paths.base, "original")?.1;
        assert_eq!(saved.agent, "second");
        assert_eq!(saved.session_id, task.session_id);
        assert_eq!(saved.prompt, task.prompt);
        assert_eq!(saved.workspace, task.workspace);
        assert_eq!(saved.status, TaskStatus::Incoming);
        assert_eq!(apply_request(&root, &assign, &HashSet::new())?["duplicate"], true);
        assert_eq!(locate_task(&paths.base, "original")?.1.comments.len(), saved.comments.len());
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    result
}

#[test]
fn assignment_waits_for_active_turn_and_rejects_overlapping_requests() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-active-assignment-{}", uuid::Uuid::new_v4()));
    let paths = QueuePaths::new(root.join("queues"));
    paths.ensure_dirs()?;
    std::fs::create_dir_all(root.join("agents"))?;
    std::fs::write(root.join("agents").join("second.md"), "Fixture")?;
    let result = (|| -> Result<()> {
        let mut task = Task::new("original", "first", "Task", "Original instructions");
        task.status = TaskStatus::InProgress;
        task.session_id = Some(uuid::Uuid::new_v4().to_string());
        write_task(paths.in_progress.join("original.json"), &task)?;
        let mut assign: OperatorRequest = serde_json::from_value(json!({
            "id": "assign", "kind": "handoff", "taskId": "original", "agent": "second",
            "message": "Assigned from Tasks", "createdAt": chrono::Utc::now(),
        }))?;
        let active = HashSet::from([task.id.clone()]);
        apply_request(&root, &assign, &active)?;
        let mut saved = locate_task(&paths.base, "original")?.1;
        assert_eq!(saved.agent, "first");
        assert_eq!(saved.status, TaskStatus::InProgress);
        assert_eq!(saved.interaction.handoff.as_ref().unwrap().agent, "second");
        assign.id = "overlapping".into();
        assert!(apply_request(&root, &assign, &active).is_err());
        apply_handoff(&mut saved);
        assert_eq!(saved.agent, "second");
        assert_eq!(saved.status, TaskStatus::Incoming);
        assert_eq!(saved.session_id, task.session_id);
        assert_eq!(saved.prompt, task.prompt);
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    result
}

#[test]
fn status_moves_are_authoritative_idempotent_and_preserve_original_work() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-status-{}", uuid::Uuid::new_v4()));
    let paths = QueuePaths::new(root.join("queues"));
    paths.ensure_dirs()?;
    std::fs::create_dir_all(root.join("agents"))?;
    std::fs::create_dir_all(root.join(".runner-receipts"))?;
    std::fs::write(root.join("agents").join("fixture.md"), "Fixture")?;
    let outcome = (|| -> Result<()> {
        let mut task = Task::new("original", "fixture", "Task", "Preserved instructions");
        task.session_id = Some(uuid::Uuid::new_v4().to_string());
        task.cost.input_tokens = 123;
        write_task(paths.in_progress.join("original.json"), &task)?;
        let request: OperatorRequest = serde_json::from_value(json!({
            "id": "move", "kind": "status", "taskId": task.id, "status": "completed",
            "expectedStatus": "in_progress", "createdAt": chrono::Utc::now(),
        }))?;
        let active = HashSet::from([task.id.clone()]);
        assert_eq!(apply_request(&root, &request, &active)?["status"], "pending");
        assert!(paths.in_progress.join("original.json").exists());
        assert!(!paths.completed.join("original.json").exists());
        assert_eq!(apply_request(&root, &request, &active)?["status"], "pending");
        let mut saved = read_task(paths.in_progress.join("original.json"))?;
        assert_eq!(saved.comments.len(), 1);
        assert_eq!(saved.session_id, task.session_id);
        change_status(&mut saved, TaskStatus::Completed);
        save_task_state(&paths.base, &paths.in_progress.join("original.json"), &saved)?;
        assert_eq!(apply_request(&root, &request, &HashSet::new())?["status"], "accepted");
        assert_eq!(saved.cost.input_tokens, 123);
        assert_eq!(saved.prompt, task.prompt);
        let mut reopen = request.clone();
        reopen.id = "reopen".into();
        reopen.status = Some(TaskStatus::InProgress);
        assert!(apply_request(&root, &reopen, &HashSet::new()).is_err(), "Stale source status must fail");
        reopen.expected_status = Some(TaskStatus::Completed);
        assert!(apply_request(&root, &reopen, &HashSet::new()).is_err(), "Historical work requires preparation");
        reopen.metadata = Some(json!({ "dashboardPrepared": true }));
        assert_eq!(apply_request(&root, &reopen, &HashSet::new())?["status"], "accepted");
        let saved = locate_task(&paths.base, "original")?.1;
        assert_eq!(saved.status, TaskStatus::Incoming, "Only actual dispatch may claim in-progress");
        assert_eq!(saved.session_id, task.session_id);
        assert_eq!(saved.cost.input_tokens, 123);
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    outcome
}
