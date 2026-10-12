use super::*;

#[test]
fn task_mcp_is_registered_in_host_configuration_with_exact_task_scope() -> Result<()> {
    let root = std::env::temp_dir().join("spool mcp config");
    let binary = root.join("spool.exe");
    let runner = CopilotRunner::new(root.join("logs"));
    let task = Task::new("TASK-current", "reviewer", "Review", "Original prompt");
    let agent = AgentConfig::parse("reviewer", "Original role", PathBuf::new())?;
    let mut command = Command::new("copilot");
    runner.configure_task_mcp(&mut command, &task, &agent, Some(&binary))?;
    let args: Vec<_> = command.as_std().get_args().collect();
    assert_eq!(args.len(), 2);
    assert_eq!(args[0], "--additional-mcp-config");
    let config: serde_json::Value = serde_json::from_str(args[1].to_str().unwrap())?;
    let server = &config["mcpServers"]["spool"];
    assert_eq!(server["type"], "local");
    assert_eq!(server["command"], serde_json::json!(binary));
    assert_eq!(server["args"], serde_json::json!([
        "--root", root, "mcp", "--agent", "reviewer", "--task", "TASK-current"
    ]));
    assert_eq!(server["tools"], serde_json::json!(["*"]));
    Ok(())
}

#[test]
fn initial_prompt_contains_the_complete_role_and_work_item_without_fetch_instructions() -> Result<()> {
    let agent = AgentConfig::parse("reviewer", "# Original role\nPost verified findings.", PathBuf::new())?;
    let mut task = Task::new("original", "reviewer", "Review", &"Full work item\n".repeat(10000));
    assert_eq!(work_item_prompt(&task, &agent), format!("{}\n\n{}", agent.system_prompt, task.prompt));
    task.add_comment("reviewer", "Earlier verified findings\nPreserve this exact text");
    let prompt = work_item_prompt(&task, &agent);
    assert_eq!(prompt, format!("{}\n\n{}", agent.system_prompt, task.prompt));
    assert!(!prompt.contains("## Work item history"));
    assert!(!prompt.contains(&task.comments[0].message));
    assert_eq!(task.comments.len(), 1);
    assert!(!prompt.contains("Call spool_get_task first"));
    assert!(!prompt.contains("Execute your current Spool work item"));
    task.session_id = Some("original-provider-session".into());
    assert_eq!(work_item_prompt(&task, &agent), task.prompt);
    assert!(!work_item_prompt(&task, &agent).contains(&agent.system_prompt));
    assert!(!work_item_prompt(&task, &agent).contains(&task.comments[0].message));
    Ok(())
}

#[test]
fn creator_context_uses_persisted_task_identity_and_prepared_workspace() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-origin-{}", uuid::Uuid::new_v4()));
    let workspace = root.join("workspace");
    let records = root.join(".runner-receipts");
    fs::create_dir_all(&workspace)?;
    fs::create_dir_all(&records)?;
    let result = (|| -> Result<()> {
        let mut task = Task::new("TASK-original", "perf", "Original task", "Original prompt");
        task.workspace = Some(workspace.to_string_lossy().into_owned());
        let session = uuid::Uuid::new_v4().to_string();
        task.session_id = Some(session.clone());
        write_json(records.join("task-TASK-original.json"), &serde_json::json!({
            "preparation": { "ready": true, "repoRoot": workspace, "branch": "user/original" }
        }))?;
        let runner = CopilotRunner::new(root.join("logs"));
        let file = runner.creator_context(&task, &session)?;
        let context: serde_json::Value = serde_json::from_slice(&fs::read(&file)?)?;
        assert_eq!(context["taskId"], "TASK-original");
        assert_eq!(context["agent"], "perf");
        assert_eq!(context["sessionId"], session);
        assert_eq!(context["branch"], "user/original");
        assert_eq!(context["workspace"], task.workspace.clone().unwrap());
        assert_eq!(context["receiptDirectory"], records.join("native-creators").to_string_lossy().as_ref());
        assert!(runner.creator_context(&task, &uuid::Uuid::new_v4().to_string()).is_err());

        write_json(records.join("task-TASK-original.json"), &serde_json::json!({
            "preparation": { "ready": false, "repoRoot": workspace, "branch": "user/original" }
        }))?;
        let file = runner.creator_context(&task, &session)?;
        let context: serde_json::Value = serde_json::from_slice(&fs::read(file)?)?;
        assert!(context["branch"].is_null());
        Ok(())
    })();
    fs::remove_dir_all(&root)?;
    result
}

#[cfg(all(test, windows))]
mod launch_tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn npm_launch_avoids_shell_and_preserves_multiline_arguments() {
        let root = std::env::temp_dir().join(format!("spool-launch-{}", Uuid::new_v4()));
        let loader = root.join("node_modules").join("@github").join("copilot").join("npm-loader.js");
        fs::create_dir_all(loader.parent().unwrap()).unwrap();
        fs::write(&loader, "").unwrap();
        let mut command = resolve_windows_command(&[root.clone()]).unwrap();
        let prompt = "line one\n\"quoted\" & echo this must remain inert";
        command.arg("-p").arg(prompt).arg("--allow-all").current_dir(&root);
        assert_eq!(command.as_std().get_program(), "node.exe");
        assert_eq!(command.as_std().get_args().nth(2).unwrap(), prompt);
        assert_eq!(command.as_std().get_current_dir(), Some(root.as_path()));
        fs::remove_dir_all(root).unwrap();
    }
}
