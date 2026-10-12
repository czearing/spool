use super::*;

#[test]
fn persistent_pause_blocks_claims_without_canceling_active_work() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-pause-{}", uuid::Uuid::new_v4()));
    let orch = Orchestrator::new(&root, AppState::new());
    let paths = QueuePaths::new(&orch.queues_dir);
    paths.ensure_dirs()?;
    std::fs::create_dir_all(root.join("agents"))?;
    std::fs::write(root.join("agents").join("tech-writer.md"), "Fixture")?;
    let task = Task::new("queued", "tech-writer", "Test", "Keep queued");
    write_task(paths.incoming.join("queued.json"), &task)?;
    orch.state.write().set_active_task(&Task::new("already-running", "tech-writer", "Active", "Preserve"));
    crate::commands::handle_pause(&root, "tech-writer", true)?;
    assert_eq!(orch.state.read().active_tasks["already-running"].agent, "tech-writer");
    orch.state.write().remove_active_task("already-running");
    let tasks = list_tasks_in_dir(&paths.incoming);
    assert!(orch.claim_task("tech-writer", &tasks)?.is_none());
    let restarted = Orchestrator::new(&root, AppState::new());
    assert!(restarted.claim_task("tech-writer", &tasks)?.is_none());
    assert!(paths.incoming.join("queued.json").exists());
    crate::commands::handle_pause(&root, "tech-writer", false)?;
    assert!(restarted.claim_task("tech-writer", &tasks)?.is_some());
    assert!(crate::commands::handle_pause(&root, "../escape", true).is_err());
    assert!(crate::commands::handle_pause(&root, "unknown", true).is_err());
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn recovery_refuses_corrupt_and_duplicate_queue_records() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-recovery-{}", uuid::Uuid::new_v4()));
    let orch = Orchestrator::new(&root, AppState::new());
    let paths = QueuePaths::new(&orch.queues_dir);
    paths.ensure_dirs()?;
    let file = paths.in_progress.join("task.json");
    std::fs::write(&file, "{")?;
    assert!(orch.recover_interrupted_tasks().is_err());
    assert_eq!(std::fs::read_to_string(&file)?, "{");
    let task = Task::new("task", "perf", "Test", "Original");
    write_task(&file, &task)?;
    write_task(paths.completed.join("task.json"), &task)?;
    assert!(orch.recover_interrupted_tasks().is_err());
    assert!(file.exists());
    assert!(!paths.incoming.join("task.json").exists());
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn concurrent_claims_serialize_agent_task_and_workspace_ownership() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-claims-{}", uuid::Uuid::new_v4()));
    let orch = Arc::new(Orchestrator::new(&root, AppState::new()));
    let paths = QueuePaths::new(&orch.queues_dir);
    paths.ensure_dirs()?;
    std::fs::create_dir_all(&orch.agents_dir)?;
    for agent in ["perf", "writer"] {
        std::fs::write(orch.agents_dir.join(format!("{agent}.md")), "Fixture")?;
    }
    for index in 0..8 {
        let id = format!("task-{index}");
        let mut task = Task::new(&id, "perf", "Test", "Original");
        task.workspace = Some(root.to_string_lossy().into_owned());
        write_task(paths.incoming.join(format!("{id}.json")), &task)?;
    }
    let tasks = Arc::new(list_tasks_in_dir(&paths.incoming));
    let barrier = Arc::new(std::sync::Barrier::new(16));
    let threads: Vec<_> = (0..16).map(|_| {
        let (orch, tasks, barrier) = (Arc::clone(&orch), Arc::clone(&tasks), Arc::clone(&barrier));
        std::thread::spawn(move || {
            barrier.wait();
            orch.claim_task("perf", &tasks).unwrap().is_some()
        })
    }).collect();
    assert_eq!(threads.into_iter().map(|thread| usize::from(thread.join().unwrap())).sum::<usize>(), 1);
    assert_eq!(list_tasks_in_dir(&paths.in_progress).len(), 1);
    let mut other = Task::new("other", "writer", "Test", "Original");
    other.workspace = Some(root.join(".").to_string_lossy().into_owned());
    write_task(paths.incoming.join("other.json"), &other)?;
    let tasks = list_tasks_in_dir(&paths.incoming);
    assert!(orch.claim_task("writer", &tasks)?.is_none());
    let active = list_tasks_in_dir(&paths.in_progress)[0].1.id.clone();
    orch.state.write().remove_active_task(&active);
    assert!(orch.claim_task("writer", &tasks)?.is_some());
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn independent_pr_sessions_share_a_role_but_never_a_workspace_or_session() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-parallel-{}", uuid::Uuid::new_v4()));
    let orch = Arc::new(Orchestrator::new(&root, AppState::new()));
    let paths = QueuePaths::new(&orch.queues_dir);
    paths.ensure_dirs()?;
    std::fs::create_dir_all(&orch.agents_dir)?;
    std::fs::create_dir_all(root.join(".runner-receipts"))?;
    std::fs::write(orch.agents_dir.join("engineer.md"), "Original role")?;
    let mut candidates = Vec::new();
    for (id, workspace, session) in [
        ("a", "workspace-a", "session-a"), ("b", "workspace-b", "session-b"),
        ("collision", "workspace-b", "session-c"), ("duplicate-session", "workspace-c", "session-b"),
    ] {
        let workspace = root.join(workspace);
        std::fs::create_dir_all(&workspace)?;
        let mut task = Task::new(id, "engineer", "Review continuation", "New feedback only");
        task.workspace = Some(workspace.to_string_lossy().into_owned());
        task.session_id = Some(session.into());
        task.independent_workspace = true;
        write_json(root.join(".runner-receipts").join(format!("task-{id}.json")), &serde_json::json!({
            "runner": "pr-updater", "independentWorkspace": true,
            "preparation": { "ready": true, "repoRoot": workspace },
            "contract": { "identifier": id, "agent": "engineer", "cwd": workspace },
        }))?;
        let file = paths.incoming.join(format!("{id}.json"));
        write_task(&file, &task)?;
        candidates.push((file, task));
    }
    assert!(orch.claim_task("engineer", &candidates[0..1])?.is_some());
    assert!(orch.claim_task("engineer", &candidates[1..2])?.is_some());
    assert_eq!(orch.state.read().active_tasks.len(), 2);
    assert!(orch.claim_task("engineer", &candidates)?.is_none());
    orch.state.write().remove_active_task("a");
    assert_eq!(orch.state.read().active_tasks.len(), 1);
    assert!(orch.claim_task("engineer", &candidates[2..])?.is_none());
    orch.state.write().remove_active_task("b");
    assert!(orch.claim_task("engineer", &candidates[2..3])?.is_some());
    std::fs::remove_dir_all(root)?;
    Ok(())
}
