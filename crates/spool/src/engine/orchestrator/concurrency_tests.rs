use super::*;

fn fixture(limit: &str) -> Result<(PathBuf, Arc<Orchestrator>, Vec<(PathBuf, Task)>)> {
    let root = std::env::temp_dir().join(format!("spool-concurrency-{}", uuid::Uuid::new_v4()));
    let orch = Arc::new(Orchestrator::new(&root, AppState::new()));
    let paths = QueuePaths::new(&orch.queues_dir);
    paths.ensure_dirs()?;
    std::fs::create_dir_all(&orch.agents_dir)?;
    std::fs::write(
        orch.agents_dir.join("engineer.md"),
        format!("---\nmax_concurrent_runs: {limit}\n---\nInstructions"),
    )?;
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
fn operator_chat_dispatches_while_agent_automation_stays_paused_and_ownership_is_preserved(
) -> Result<()> {
    use crate::models::task::{ChatReturn, OperatorMessage};
    let (root, orch, mut tasks) = fixture("unlimited")?;
    let result = (|| -> Result<()> {
        std::fs::create_dir_all(root.join("controls/paused"))?;
        std::fs::write(root.join("controls/paused/engineer"), "Operator pause")?;
        for index in [1, 2, 3, 4] {
            let task = &mut tasks[index].1;
            task.workspace = Some(root.to_string_lossy().into_owned());
            task.session_id = Some(format!("session-{index}"));
            task.interaction.messages.push(OperatorMessage {
                id: format!("message-{index}"),
                text: "Direct operator message".into(),
                status: "queued".into(),
                created_at: chrono::Utc::now(),
                session_id: None,
                error: None,
            });
            if index != 2 {
                task.interaction.chat_return = Some(ChatReturn {
                    status: TaskStatus::Completed,
                    error: None,
                });
            }
            if index == 3 {
                task.interaction.paused = true;
            }
            write_task(&tasks[index].0, &tasks[index].1)?;
        }
        let (_, claimed, _) = orch
            .claim_task("engineer", &tasks)?
            .expect("Direct chat must not wait behind paused automation");
        assert_eq!(claimed.id, tasks[1].1.id);
        assert!(AgentConfig::is_paused(&root, "engineer")?);
        assert!(tasks[0].0.exists(), "Ordinary automation remains queued");
        assert!(
            tasks[2].0.exists(),
            "A queued message without a direct-chat return is not an override"
        );
        assert!(
            tasks[3].0.exists(),
            "An explicitly paused task must remain paused"
        );
        assert!(
            orch.claim_task("engineer", &tasks)?.is_none(),
            "The other chat cannot steal the active workspace"
        );
        assert_eq!(orch.state.read().active_tasks.len(), 1);
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    result
}
#[test]
fn invalid_workspaces_fail_explicitly_without_blocking_the_next_task() -> Result<()> {
    for invalid in ["missing", "relative", "file"] {
        let (root, orch, mut tasks) = fixture("1")?;
        let result = (|| -> Result<()> {
            let workspace = match invalid {
                "relative" => PathBuf::from("relative-workspace"),
                "file" => {
                    let file = root.join("not-a-directory");
                    std::fs::write(&file, "fixture")?;
                    file
                }
                _ => root.join("missing"),
            };
            tasks[0].1.workspace = Some(workspace.to_string_lossy().into_owned());
            tasks[0].1.session_id = Some("preserved-session".into());
            write_task(&tasks[0].0, &tasks[0].1)?;
            tasks[1].1.workspace = Some(root.to_string_lossy().into_owned());
            write_task(&tasks[1].0, &tasks[1].1)?;
            let claimed = orch
                .claim_task("engineer", &tasks)?
                .expect("Valid task must still dispatch");
            assert_eq!(claimed.1.id, tasks[1].1.id);
            assert_eq!(orch.state.read().active_tasks.len(), 1);
            let paths = QueuePaths::new(&orch.queues_dir);
            assert!(!tasks[0].0.exists());
            let failed = read_task(paths.failed.join(format!("{}.json", tasks[0].1.id)))?;
            assert_eq!(failed.status, TaskStatus::Failed);
            assert_eq!(failed.session_id, tasks[0].1.session_id);
            assert_eq!(failed.workspace, tasks[0].1.workspace);
            assert_eq!(failed.interaction.phase, "ended");
            assert!(failed
                .error
                .as_deref()
                .unwrap()
                .contains("Agent workspace is unavailable"));
            assert!(failed
                .comments
                .last()
                .unwrap()
                .message
                .contains("Prepare the workspace before retrying"));
            assert!(
                orch.claim_task("engineer", &tasks)?.is_none(),
                "Concurrency limit must remain enforced"
            );
            Ok(())
        })();
        std::fs::remove_dir_all(root)?;
        result?;
    }
    Ok(())
}
#[test]
fn concurrency_limits_are_atomic_and_live_changes_never_cancel_active_runs() -> Result<()> {
    let (root, orch, tasks) = fixture("3")?;
    let tasks = Arc::new(tasks);
    let workers: Vec<_> = (0..12)
        .map(|_| {
            let (orch, tasks) = (Arc::clone(&orch), Arc::clone(&tasks));
            std::thread::spawn(move || orch.claim_task("engineer", &tasks).unwrap().is_some())
        })
        .collect();
    assert_eq!(
        workers
            .into_iter()
            .map(|w| usize::from(w.join().unwrap()))
            .sum::<usize>(),
        3
    );
    let role = orch.agents_dir.join("engineer.md");
    std::fs::write(&role, "---\nmax_concurrent_runs: 1\n---\nInstructions")?;
    assert!(orch.claim_task("engineer", &tasks)?.is_none());
    assert_eq!(orch.state.read().active_tasks.len(), 3);
    let ids: Vec<_> = orch.state.read().active_tasks.keys().cloned().collect();
    for id in ids {
        orch.state.write().remove_active_task(&id);
    }
    assert!(orch.claim_task("engineer", &tasks)?.is_some());
    assert!(orch.claim_task("engineer", &tasks)?.is_none());
    std::fs::write(&role, "---\nmax_concurrent_runs: null\n---\nInstructions")?;
    let mut count = 0;
    while orch.claim_task("engineer", &tasks)?.is_some() {
        count += 1;
    }
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
    std::fs::remove_file(orch.agents_dir.join("engineer.md"))?;
    orch.refresh_agents()?;
    assert!(!orch.state.read().agents.contains_key("engineer"));
    assert_eq!(
        orch.state.read().active_tasks.len(),
        1,
        "Deleting a role must not destroy its active job"
    );
    assert!(
        orch.claim_task("engineer", &tasks).is_err(),
        "Deleted roles cannot claim queued work"
    );
    assert!(
        !orch.agents_dir.join("engineer.md").exists(),
        "Queued work must not recreate its deleted role"
    );
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[tokio::test]
async fn operator_requests_wake_the_scheduler_without_waiting_for_its_poll() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-control-wake-{}", uuid::Uuid::new_v4()));
    let orch = Arc::new(Orchestrator::new(&root, AppState::new()));
    let paths = QueuePaths::new(&orch.queues_dir);
    paths.ensure_dirs()?;
    std::fs::create_dir_all(&orch.agents_dir)?;
    let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
    let scheduler = tokio::spawn(
        Arc::clone(&orch)
            .run_loop_with_control_interval(shutdown_rx, tokio::time::Duration::from_secs(30)),
    );
    let result = tokio::time::timeout(tokio::time::Duration::from_secs(5), async {
        while !root.join("controls/capabilities.json").exists() {
            tokio::time::sleep(tokio::time::Duration::from_millis(5)).await;
        }
        let started = std::time::Instant::now();
        for index in 0..12 {
            let id = format!("probe-{index}");
            let mut task = Task::new(&id, "fixture", "Fixture", "No provider is launched");
            task.status = TaskStatus::InProgress;
            write_task(paths.in_progress.join(format!("{id}.json")), &task)?;
            write_json(
                root.join("controls/requests").join(format!("{id}.json")),
                &serde_json::json!({
                    "id": id, "kind": "status", "taskId": id, "expectedStatus": "in_progress",
                    "status": "failed", "createdAt": chrono::Utc::now(),
                }),
            )?;
        }
        for index in 0..12 {
            let result = root
                .join("controls/results")
                .join(format!("probe-{index}.json"));
            while !result.exists() {
                tokio::time::sleep(tokio::time::Duration::from_millis(5)).await;
            }
            let receipt: serde_json::Value = serde_json::from_slice(&std::fs::read(result)?)?;
            assert_eq!(receipt["result"]["status"], "accepted");
            assert_eq!(
                read_task(paths.failed.join(format!("probe-{index}.json")))?.status,
                TaskStatus::Failed
            );
        }
        eprintln!(
            "Durably processed 12 operator requests in {:?} without the polling timer",
            started.elapsed()
        );
        Ok::<_, anyhow::Error>(())
    })
    .await;
    shutdown_tx.send(()).await?;
    scheduler.await??;
    std::fs::remove_dir_all(root)?;
    result??;
    Ok(())
}

#[tokio::test]
async fn queue_bursts_coalesce_scans_without_losing_the_latest_work() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-dispatch-burst-{}", uuid::Uuid::new_v4()));
    let orch = Arc::new(Orchestrator::new(&root, AppState::new()));
    let paths = QueuePaths::new(&orch.queues_dir);
    paths.ensure_dirs()?;
    std::fs::create_dir_all(&orch.agents_dir)?;
    // A malformed role records one diagnostic per scan without launching a provider.
    std::fs::write(
        orch.agents_dir.join("broken.md"),
        "---\nmax_concurrent_runs: 0\n---\nFixture",
    )?;
    let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
    let scheduler = tokio::spawn(Arc::clone(&orch).run_loop(shutdown_rx));
    let result = tokio::time::timeout(tokio::time::Duration::from_secs(5), async {
        while !root.join("controls").join("capabilities.json").exists() {
            tokio::time::sleep(tokio::time::Duration::from_millis(5)).await;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
        orch.state.write().recent_logs.clear();
        for index in 0..100 {
            std::fs::write(paths.completed.join(format!("burst-{index}.json")), "{}")?;
        }
        std::fs::write(orch.agents_dir.join("latest.md"), "Fixture")?;
        let mut latest = Task::new("latest", "latest", "Fixture", "No provider is launched");
        latest.interaction.paused = true;
        write_task(paths.incoming.join("latest.json"), &latest)?;
        std::thread::sleep(std::time::Duration::from_millis(100));
        let started = std::time::Instant::now();
        while !orch.state.read().agents.contains_key("latest") {
            tokio::time::sleep(tokio::time::Duration::from_millis(1)).await;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        let scans = orch
            .state
            .read()
            .recent_logs
            .iter()
            .filter(|log| log.contains("Cannot load agent"))
            .count();
        assert!(orch.state.read().active_tasks.is_empty());
        assert!(
            read_task(paths.incoming.join("latest.json"))?
                .interaction
                .paused
        );
        Ok::<_, anyhow::Error>((scans, started.elapsed()))
    })
    .await;
    shutdown_tx.send(()).await?;
    scheduler.await??;
    std::fs::remove_dir_all(root)?;
    let (scans, elapsed) = result??;
    eprintln!("100-file queue burst: {scans} dispatch scans, drained in {elapsed:?}");
    anyhow::ensure!(
        (1..=4).contains(&scans),
        "A queue burst triggered {scans} redundant dispatch scans"
    );
    Ok(())
}
