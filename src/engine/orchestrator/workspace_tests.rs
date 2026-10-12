use super::*;

#[test]
fn claiming_persists_the_agents_checkout_without_redirecting_prepared_or_resumed_tasks() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-workspace-{}", uuid::Uuid::new_v4()));
    let orch = Orchestrator::new(&root, AppState::new());
    let paths = QueuePaths::new(&orch.queues_dir);
    paths.ensure_dirs()?;
    std::fs::create_dir_all(&orch.agents_dir)?;
    let default = root.join("perf-repository");
    let prepared = root.join("prepared-repository");
    std::fs::create_dir_all(&default)?;
    std::fs::create_dir_all(&prepared)?;
    let role = orch.agents_dir.join("perf.md");
    std::fs::write(&role, format!("---\ndefault_workspace: {}\n---\nInstructions", serde_json::json!(default)))?;
    for (id, workspace, session) in [
        ("new", None, None),
        ("prepared", Some(prepared.to_string_lossy().into_owned()), None),
        ("resumed", None, Some("existing-session".to_owned())),
    ] {
        let mut task = Task::new(id, "perf", "Test", "Work in the assigned repository");
        task.workspace = workspace.clone();
        task.session_id = session.clone();
        write_task(paths.incoming.join(format!("{id}.json")), &task)?;
        let (file, claimed, _) = orch.claim_task("perf", &list_tasks_in_dir(&paths.incoming))?.unwrap();
        let expected = if id == "new" { Some(default.to_string_lossy().into_owned()) } else { workspace };
        assert_eq!(claimed.workspace, expected);
        assert_eq!(read_task(&file)?.workspace, expected);
        assert_eq!(claimed.session_id, session);
        orch.state.write().remove_active_task(id);
        std::fs::remove_file(file)?;
    }

    std::fs::remove_dir_all(&default)?;
    let task = Task::new("missing", "perf", "Test", "No fallback to the project data folder");
    write_task(paths.incoming.join("missing.json"), &task)?;
    assert!(orch.claim_task("perf", &list_tasks_in_dir(&paths.incoming)).is_err());
    assert!(paths.incoming.join("missing.json").exists());
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn independent_agent_checkouts_run_concurrently_but_shared_paths_remain_locked() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-owned-checkouts-{}", uuid::Uuid::new_v4()));
    let orch = Orchestrator::new(&root, AppState::new());
    let paths = QueuePaths::new(&orch.queues_dir);
    paths.ensure_dirs()?;
    std::fs::create_dir_all(&orch.agents_dir)?;
    let (perf, engineer) = (root.join("perf"), root.join("engineer"));
    std::fs::create_dir_all(&perf)?;
    std::fs::create_dir_all(&engineer)?;
    let role = |agent: &str, workspace: &Path| -> Result<()> {
        std::fs::write(orch.agents_dir.join(format!("{agent}.md")),
            format!("---\ndefault_workspace: {}\n---\nInstructions", serde_json::json!(workspace)))?;
        Ok(())
    };
    role("perf", &perf)?;
    role("engineer", &perf)?;
    for agent in ["perf", "engineer"] {
        write_task(paths.incoming.join(format!("{agent}.json")), &Task::new(agent, agent, "Test", "Work"))?;
    }
    assert!(orch.claim_task("perf", &list_tasks_in_dir(&paths.incoming))?.is_some());
    assert!(orch.claim_task("engineer", &list_tasks_in_dir(&paths.incoming))?.is_none());
    role("engineer", &engineer)?;
    let (_, task, _) = orch.claim_task("engineer", &list_tasks_in_dir(&paths.incoming))?.unwrap();
    assert_eq!(task.workspace, Some(engineer.to_string_lossy().into_owned()));
    assert_eq!(orch.state.read().active_workspaces.len(), 2);
    std::fs::remove_dir_all(root)?;
    Ok(())
}
