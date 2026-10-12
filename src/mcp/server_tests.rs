    use super::*;
    use crate::models::Task;

    #[test]
    fn registration_is_bound_to_current_creator_and_prepared_branch() -> Result<()> {
        let root = std::env::temp_dir().join(format!("spool-registration-{}", uuid::Uuid::new_v4()));
        let queues = root.join("queues");
        let paths = QueuePaths::new(&queues);
        paths.ensure_dirs()?;
        std::fs::create_dir_all(root.join(".runner-receipts"))?;
        let mut task = Task::new("TASK-123", "perf", "Original", "Original brief");
        task.workspace = Some(root.to_string_lossy().into_owned());
        task.session_id = Some("provider-session".into());
        write_task(paths.in_progress.join("TASK-123.json"), &task)?;
        write_json(root.join(".runner-receipts").join("task-TASK-123.json"),
            &json!({ "preparation": { "ready": true, "branch": "user/fixture" } }))?;
        let server = McpServer::new(&queues, Some("perf".into()), Some(task.id.clone()));
        let args = json!({ "pr_id": "123", "url": "https://dev.azure.com/office/OC/_git/office-bohemia/pullrequest/123", "branch": "user/fixture" });
        let record = server.register_pr(&args)?;
        assert_eq!(record["taskId"], task.id);
        assert_eq!(record["agent"], "perf");
        assert_eq!(record["sessionId"], "provider-session");
        assert_eq!(server.register_pr(&args)?, record);
        let mut wrong = args.clone();
        wrong["branch"] = json!("wrong");
        assert!(server.register_pr(&wrong).is_err());
        let impostor = McpServer::new(&queues, Some("software-engineer".into()), Some(task.id));
        assert!(impostor.register_pr(&args).is_err());
        std::fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn current_task_can_be_read_after_each_status_transition() -> Result<()> {
        let root = std::env::temp_dir().join(format!("spool-readback-{}", uuid::Uuid::new_v4()));
        let paths = QueuePaths::new(&root);
        paths.ensure_dirs()?;
        for status in ["completed", "failed", "incoming", "in_progress"] {
            let mut task = Task::new(&format!("TASK-{status}"), "perf", "Fixture", "Original prompt");
            task.status = TaskStatus::InProgress;
            write_task(paths.in_progress.join(format!("{}.json", task.id)), &task)?;
            let server = McpServer::new(&root, Some("perf".into()), Some(task.id.clone()));
            assert_ne!(server.execute_tool("spool_add_comment", json!({"comment": "Verified result"}))["isError"], true);
            assert_ne!(server.execute_tool("spool_update_task_status", json!({"status": status}))["isError"], true);
            let response = server.execute_tool("spool_get_task", json!({}));
            assert_ne!(response["isError"], true, "{response}");
            let returned: Task = serde_json::from_str(response["content"][0]["text"].as_str().unwrap())?;
            assert_eq!(returned.id, task.id);
            assert_eq!(returned.status.to_string(), status);
            assert_eq!(returned.comments[0].message, "Verified result");
        }
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
        assert_eq!(server.execute_tool("spool_get_task", json!({}))["isError"], true);
        write_task(paths.completed.join("TASK-1.json"), &task)?;
        std::fs::write(paths.in_progress.join("TASK-1.json"), "{")?;
        assert_eq!(server.execute_tool("spool_get_task", json!({}))["isError"], true);
        write_task(paths.in_progress.join("TASK-1.json"), &task)?;
        assert_eq!(server.execute_tool("spool_get_task", json!({}))["isError"], true);
        std::fs::remove_file(paths.in_progress.join("TASK-1.json"))?;
        write_task(paths.completed.join("TASK-1.json"), &Task::new("WRONG", "perf", "Fixture", "Wrong"))?;
        assert_eq!(server.execute_tool("spool_get_task", json!({}))["isError"], true);
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
        for args in [json!({}), json!({"status": null}), json!({"status": "done"})] {
            assert_eq!(server.execute_tool("spool_update_task_status", args)["isError"], true);
            assert!(file.exists());
            assert!(!paths.completed.join("TASK-1.json").exists());
        }
        std::fs::remove_dir_all(root)?;
        Ok(())
    }
