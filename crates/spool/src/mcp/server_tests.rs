use super::*;
use crate::models::Task;

#[test]
fn agent_discovery_returns_an_mcp_structured_object_and_retains_text_list() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-agent-discovery-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("agents"))?;
    std::fs::write(root.join("agents/engineer.md"), "Engineering instructions")?;
    let server = McpServer::new(root.join("queues"), Some("engineer".into()), None);
    let response = server.execute_tool("spool_list_agents", json!({}));
    assert_ne!(response["isError"], true, "{response}");
    assert!(response["structuredContent"].is_object(), "{response}");
    let text: Value = serde_json::from_str(response["content"][0]["text"].as_str().unwrap())?;
    assert_eq!(response["structuredContent"]["agents"], text);
    assert_eq!(text.as_array().unwrap().len(), 1);
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn delegation_rejects_unavailable_workspaces_without_enqueuing_tasks() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-delegation-{}", uuid::Uuid::new_v4()));
    let paths = QueuePaths::new(root.join("queues"));
    paths.ensure_dirs()?;
    let result = (|| -> Result<()> {
        let server = McpServer::new(&paths.base, Some("engineer".into()), None);
        let file = root.join("not-a-directory");
        std::fs::write(&file, "fixture")?;
        for workspace in [root.join("missing"), PathBuf::from("relative"), file] {
            let response = server.execute_tool(
                "spool_create_task",
                json!({
                    "agent": "engineer", "title": "Delegated", "prompt": "Original instructions",
                    "workspace": workspace,
                }),
            );
            assert_eq!(response["isError"], true);
            assert!(response["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("Agent workspace is unavailable"));
            assert_eq!(std::fs::read_dir(&paths.incoming)?.count(), 0);
        }
        let response = server.execute_tool("spool_create_task", json!({
                "agent": "engineer", "title": "Delegated", "prompt": "Original instructions", "workspace": root,
            }));
        assert_ne!(response["isError"], true, "{response}");
        assert_eq!(std::fs::read_dir(&paths.incoming)?.count(), 1);
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    result
}

#[test]
fn publication_registration_is_not_a_spool_tool() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-registration-{}", uuid::Uuid::new_v4()));
    let queues = root.join("queues");
    let paths = QueuePaths::new(&queues);
    paths.ensure_dirs()?;
    let mut task = Task::new("TASK-123", "perf", "Original", "Original brief");
    task.workspace = Some(root.to_string_lossy().into_owned());
    task.session_id = Some("provider-session".into());
    write_task(paths.in_progress.join("TASK-123.json"), &task)?;
    let server = McpServer::new(&queues, Some("perf".into()), Some(task.id.clone()));
    let args = json!({ "pr_id": "123", "url": "https://dev.azure.com/office/OC/_git/office-bohemia/pullrequest/123", "branch": "user/fixture" });
    let response = server.execute_tool("spool_register_pr", args);
    assert_eq!(response["isError"], true);
    assert!(response["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Unknown tool"));
    assert!(!root.join(".runner-receipts").exists());
    assert_eq!(
        read_task(paths.in_progress.join("TASK-123.json"))?.session_id,
        task.session_id
    );
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn current_task_can_be_read_after_each_status_transition() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-readback-{}", uuid::Uuid::new_v4()));
    let paths = QueuePaths::new(&root);
    paths.ensure_dirs()?;
    for status in ["completed", "failed", "incoming", "in_progress"] {
        let mut task = Task::new(
            &format!("TASK-{status}"),
            "perf",
            "Fixture",
            "Original prompt",
        );
        task.status = TaskStatus::InProgress;
        task.add_comment("fixture", "Existing evidence");
        write_task(paths.in_progress.join(format!("{}.json", task.id)), &task)?;
        let server = McpServer::new(&root, Some("perf".into()), Some(task.id.clone()));
        assert_ne!(
            server.execute_tool("spool_update_task_status", json!({"status": status}))["isError"],
            true
        );
        let response = server.execute_tool("spool_get_task", json!({}));
        assert_ne!(response["isError"], true, "{response}");
        let returned: Task =
            serde_json::from_str(response["content"][0]["text"].as_str().unwrap())?;
        assert_eq!(returned.id, task.id);
        assert_eq!(returned.status.to_string(), status);
        assert_eq!(returned.comments.len(), 1);
        assert_eq!(returned.comments[0].message, "Existing evidence");
        if status == "failed" {
            assert_eq!(returned.failure_origin.as_ref().unwrap().source, "agent");
            assert_eq!(
                returned.failure_origin.as_ref().unwrap().error,
                returned.error
            );
        } else {
            assert!(returned.failure_origin.is_none());
        }
    }
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn running_session_can_correct_an_early_terminal_status() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-status-recovery-{}", uuid::Uuid::new_v4()));
    let paths = QueuePaths::new(root.join("queues"));
    paths.ensure_dirs()?;
    for recovered in ["in_progress", "completed"] {
        let mut task = Task::new(
            format!("TASK-{recovered}"),
            "perf",
            "Fixture",
            "Original prompt",
        );
        task.status = TaskStatus::InProgress;
        task.interaction.phase = "running".into();
        task.session_id = Some("original-session".into());
        write_task(paths.in_progress.join(format!("{}.json", task.id)), &task)?;
        let server = McpServer::new(&paths.base, Some("perf".into()), Some(task.id.clone()));
        let failed = server.execute_tool(
            "spool_update_task_status",
            json!({"status": "failed", "error": "Temporary browser failure"}),
        );
        assert_ne!(failed["isError"], true, "{failed}");
        assert!(paths.failed.join(format!("{}.json", task.id)).exists());
        let result = server.execute_tool("spool_update_task_status", json!({"status": recovered}));
        assert_ne!(result["isError"], true, "{result}");
        let returned = server.read_current_task()?;
        assert_eq!(returned.status.to_string(), recovered);
        assert_eq!(returned.prompt, task.prompt);
        assert_eq!(returned.session_id, task.session_id);
        assert!(!paths.failed.join(format!("{}.json", task.id)).exists());
        if recovered == "completed" {
            assert!(returned.error.is_none());
        }
    }
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn terminal_status_cannot_be_changed_after_the_session_ends_or_by_another_agent() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-status-ended-{}", uuid::Uuid::new_v4()));
    let paths = QueuePaths::new(root.join("queues"));
    paths.ensure_dirs()?;
    let mut task = Task::new("TASK-1", "perf", "Fixture", "Original prompt");
    task.status = TaskStatus::Failed;
    task.interaction.phase = "ended".into();
    let file = paths.failed.join("TASK-1.json");
    write_task(&file, &task)?;
    let server = McpServer::new(&paths.base, Some("perf".into()), Some(task.id.clone()));
    assert_eq!(
        server.execute_tool("spool_update_task_status", json!({"status":"completed"}))["isError"],
        true
    );
    task.interaction.phase = "running".into();
    write_task(&file, &task)?;
    let other = McpServer::new(&paths.base, Some("other".into()), Some(task.id.clone()));
    assert_eq!(
        other.execute_tool("spool_update_task_status", json!({"status":"completed"}))["isError"],
        true
    );
    assert_eq!(server.read_current_task()?.status, TaskStatus::Failed);
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn current_task_readback_rejects_corruption_duplicates_and_wrong_identity() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-readback-errors-{}", uuid::Uuid::new_v4()));
    let paths = QueuePaths::new(&root);
    paths.ensure_dirs()?;
    let task = Task::new("TASK-1", "perf", "Fixture", "Original");
    let server = McpServer::new(&root, Some("perf".into()), Some(task.id.clone()));
    assert_eq!(
        server.execute_tool("spool_get_task", json!({}))["isError"],
        true
    );
    write_task(paths.completed.join("TASK-1.json"), &task)?;
    std::fs::write(paths.in_progress.join("TASK-1.json"), "{")?;
    assert_eq!(
        server.execute_tool("spool_get_task", json!({}))["isError"],
        true
    );
    write_task(paths.in_progress.join("TASK-1.json"), &task)?;
    assert_eq!(
        server.execute_tool("spool_get_task", json!({}))["isError"],
        true
    );
    std::fs::remove_file(paths.in_progress.join("TASK-1.json"))?;
    write_task(
        paths.completed.join("TASK-1.json"),
        &Task::new("WRONG", "perf", "Fixture", "Wrong"),
    )?;
    assert_eq!(
        server.execute_tool("spool_get_task", json!({}))["isError"],
        true
    );
    let traversal = McpServer::new(&root, Some("perf".into()), Some("../TASK-1".into()));
    assert!(traversal.read_current_task().is_err());
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn completion_requires_an_explicit_status_argument() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-status-required-{}", uuid::Uuid::new_v4()));
    let paths = QueuePaths::new(&root);
    paths.ensure_dirs()?;
    let task = Task::new("TASK-1", "perf", "Fixture", "Original");
    let file = paths.in_progress.join("TASK-1.json");
    write_task(&file, &task)?;
    let server = McpServer::new(&root, Some("perf".into()), Some(task.id.clone()));
    for args in [
        json!({}),
        json!({"status": null}),
        json!({"status": "done"}),
    ] {
        assert_eq!(
            server.execute_tool("spool_update_task_status", args)["isError"],
            true
        );
        assert!(file.exists());
        assert!(!paths.completed.join("TASK-1.json").exists());
    }
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[tokio::test]
async fn comment_api_is_not_exposed_and_cannot_mutate_tasks() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-no-comments-{}", uuid::Uuid::new_v4()));
    let paths = QueuePaths::new(&root);
    paths.ensure_dirs()?;
    let mut task = Task::new("TASK-1", "perf", "Fixture", "Original");
    task.status = TaskStatus::InProgress;
    let file = paths.in_progress.join("TASK-1.json");
    write_task(&file, &task)?;
    let original = std::fs::read(&file)?;
    let server = McpServer::new(&root, Some("perf".into()), Some(task.id.clone()));
    let response = server
        .handle_request(JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "tools/list".into(),
            params: None,
        })
        .await
        .unwrap()
        .result
        .unwrap();
    let tools = response["tools"].as_array().unwrap();
    assert!(tools.iter().all(|tool| tool["name"] != "spool_add_comment"));
    let status = tools
        .iter()
        .find(|tool| tool["name"] == "spool_update_task_status")
        .unwrap();
    assert!(status["inputSchema"]["properties"].get("comment").is_none());
    assert_eq!(status["inputSchema"]["additionalProperties"], false);
    assert_eq!(
        server.execute_tool("spool_add_comment", json!({"comment": "Obsolete"}))["isError"],
        true
    );
    assert_eq!(
        server.execute_tool(
            "spool_update_task_status",
            json!({"status": "completed", "comment": "Obsolete"})
        )["isError"],
        true
    );
    assert_eq!(std::fs::read(&file)?, original);
    std::fs::remove_dir_all(root)?;
    Ok(())
}
