use super::*;

#[test]
fn task_model_is_captured_without_changing_agent_or_existing_sessions() -> Result<()> {
    let root = std::env::temp_dir();
    let mut task = Task::new("model", "probe", "Task", "Work");
    let agent = AgentConfig::parse("probe", "---\nmodel: agent-model\n---\nRole", Default::default())?;
    assert_eq!(SessionConfig::capture(&root, &task, &agent, None)?.model, "agent-model");
    task.model = Some("preferred-model".into());
    let config = SessionConfig::capture(&root, &task, &agent, None)?;
    assert_eq!(config.model, "preferred-model");
    assert_eq!(agent.model, "agent-model");
    task.session_config = Some(config);
    task.model = Some("later-preference".into());
    let saved: Task = serde_json::from_slice(&serde_json::to_vec(&task)?)?;
    assert_eq!(saved.session_config.unwrap().model, "preferred-model");
    Ok(())
}

#[test]
fn chat_does_not_track_branches_but_runner_preparation_still_verifies_revisions() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-branch-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root)?;
    let git = |args: &[&str]| -> Result<()> {
        let output = std::process::Command::new("git").arg("-C").arg(&root)
            .args(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"]).args(args).output()?;
        anyhow::ensure!(output.status.success(), "Fixture Git failed: {}", String::from_utf8_lossy(&output.stderr));
        Ok(())
    };
    let result = (|| -> Result<()> {
        git(&["init", "-q"])?;
        let task = Task::new("task", "probe", "Task", "Original");
        let agent = AgentConfig::parse("probe", "Role", Default::default())?;
        let config = SessionConfig::capture(&root, &task, &agent, None)?;
        assert!(serde_json::to_value(&config)?.get("branch").is_none());
        git(&["commit", "-q", "--allow-empty", "-m", "Fixture"])?;
        let original = git_head(&root, true)?;
        let commit = git_head(&root, false)?;
        SessionConfig::verify_preparation(&root, &original, &commit)?;
        let mut legacy = serde_json::to_value(&config)?;
        legacy["branch"] = json!(original);
        let restored: SessionConfig = serde_json::from_value(legacy)?;
        git(&["checkout", "-q", "-b", "changed"])?;
        restored.validate(&root, &task)?;
        assert!(SessionConfig::verify_preparation(&root, &original, &commit).is_err());
        assert_eq!(git_head(&root, true)?, "changed");
        SessionConfig::verify_preparation(&root, "changed", &commit)?;
        git(&["commit", "-q", "--allow-empty", "-m", "New revision"])?;
        assert!(SessionConfig::verify_preparation(&root, "changed", &commit).is_err());
        git(&["checkout", "-q", "--detach"])?;
        let detached = SessionConfig::capture(&root, &task, &agent, None)?;
        detached.validate(&root, &task)?;
        git(&["commit", "-q", "--allow-empty", "-m", "Different detached commit"])?;
        detached.validate(&root, &task)?;
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    result
}

#[test]
fn session_settings_ignore_changed_agent_defaults_and_reject_provider_drift() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-session-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root)?;
    let result = (|| -> Result<()> {
        let task = Task::new("original", "probe", "Task", "Never repeat");
        let agent = AgentConfig::parse("probe", "---\nmodel: original-model\nreasoning: low\n---\nRole", Default::default())?;
        let mut config = SessionConfig::capture(&root, &task, &agent, task_mcp(&root, &task, "probe", Some(Path::new("spool"))))?;
        config.validate(&root, &task)?;
        let restored = json!({ "models": { "currentModelId": "original-model" },
            "configOptions": [{ "id": "reasoning_effort", "currentValue": "low" }] });
        config.restored(&restored, true)?;
        let mut wrong_model = restored.clone();
        wrong_model["models"]["currentModelId"] = json!("changed-model");
        assert!(config.restored(&wrong_model, true).is_err());
        let mut wrong_reasoning = restored.clone();
        wrong_reasoning["configOptions"][0]["currentValue"] = json!("high");
        assert!(config.restored(&wrong_reasoning, true).is_err());
        assert_eq!(config.model, "original-model");
        assert_eq!(config.reasoning_effort.as_deref(), Some("low"));
        config.restored(&wrong_model, false)?;
        assert_eq!(config.model, "changed-model", "Legacy sessions adopt the provider's restored settings, not new agent defaults");
        std::fs::create_dir(root.join("other"))?;
        assert!(config.validate(&root.join("other"), &task).is_err());
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    result
}
