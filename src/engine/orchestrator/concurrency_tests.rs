use super::*;

fn fixture(limit: &str) -> Result<(PathBuf, Arc<Orchestrator>, Vec<(PathBuf, Task)>)> {
    let root = std::env::temp_dir().join(format!("spool-concurrency-{}", uuid::Uuid::new_v4()));
    let orch = Arc::new(Orchestrator::new(&root, AppState::new()));
    let paths = QueuePaths::new(&orch.queues_dir);
    paths.ensure_dirs()?;
    std::fs::create_dir_all(&orch.agents_dir)?;
    std::fs::write(orch.agents_dir.join("engineer.md"), format!("---\nmax_concurrent_runs: {limit}\n---\nInstructions"))?;
    let mut tasks = Vec::new();
    for index in 0..12 {
        let task = Task::new(&format!("task-{index}"), "engineer", "Test", "Instructions");
        let file = paths.incoming.join(format!("{}.json", task.id));
        write_task(&file, &task)?;
        tasks.push((file, task));
    }
    Ok((root, orch, tasks))
}
#[test]
fn concurrency_limits_are_atomic_and_live_changes_never_cancel_active_runs() -> Result<()> {
    let (root, orch, tasks) = fixture("3")?;
    let tasks = Arc::new(tasks);
    let workers: Vec<_> = (0..12).map(|_| {
        let (orch, tasks) = (Arc::clone(&orch), Arc::clone(&tasks));
        std::thread::spawn(move || orch.claim_task("engineer", &tasks).unwrap().is_some())
    }).collect();
    assert_eq!(workers.into_iter().map(|w| usize::from(w.join().unwrap())).sum::<usize>(), 3);
    let role = orch.agents_dir.join("engineer.md");
    std::fs::write(&role, "---\nmax_concurrent_runs: 1\n---\nInstructions")?;
    assert!(orch.claim_task("engineer", &tasks)?.is_none());
    assert_eq!(orch.state.read().active_tasks.len(), 3);
    let ids: Vec<_> = orch.state.read().active_tasks.keys().cloned().collect();
    for id in ids { orch.state.write().remove_active_task(&id); }
    assert!(orch.claim_task("engineer", &tasks)?.is_some());
    assert!(orch.claim_task("engineer", &tasks)?.is_none());
    std::fs::write(&role, "---\nmax_concurrent_runs: null\n---\nInstructions")?;
    let mut count = 0;
    while orch.claim_task("engineer", &tasks)?.is_some() { count += 1; }
    assert_eq!(count, 8);
    std::fs::remove_dir_all(root)?;
    Ok(())
}
#[test]
fn unlimited_concurrency_still_respects_workspace_and_session_ownership() -> Result<()> {
    let (root, orch, mut tasks) = fixture("unlimited")?;
    for (file, task) in &mut tasks {
        task.workspace = Some(root.to_string_lossy().into_owned());
        task.session_id = Some("shared-session".into());
        write_task(file, task)?;
    }
    assert!(orch.claim_task("engineer", &tasks)?.is_some());
    assert!(orch.claim_task("engineer", &tasks)?.is_none());
    assert_eq!(orch.state.read().active_tasks.len(), 1);
    std::fs::remove_dir_all(root)?;
    Ok(())
}
#[test]
fn new_and_deleted_agent_definitions_are_discovered_without_recovery_or_restart() -> Result<()> {
    let (root, orch, tasks) = fixture("1")?;
    orch.refresh_agents()?;
    assert!(orch.state.read().agents.contains_key("engineer"));
    orch.claim_task("engineer", &tasks)?;
    std::fs::write(orch.agents_dir.join("new-role.md"), "Instructions")?;
    orch.refresh_agents()?;
    assert!(orch.state.read().agents.contains_key("new-role"));
    assert_eq!(orch.state.read().active_tasks.len(), 1);
    std::fs::remove_file(orch.agents_dir.join("new-role.md"))?;
    orch.refresh_agents()?;
    assert!(!orch.state.read().agents.contains_key("new-role"));
    assert_eq!(orch.state.read().active_tasks.len(), 1);
    std::fs::remove_dir_all(root)?;
    Ok(())
}
