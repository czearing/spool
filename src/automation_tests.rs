use super::*;

#[test]
fn reservation_is_idempotent_dormant_and_requires_an_exact_real_git_revision() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-reservation-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("agents"))?;
    std::fs::write(root.join("agents/probe.md"), "Fix safe prose.")?;
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&workspace)?;
    let result = (|| -> Result<()> {
        let git = |args: &[&str]| -> Result<String> {
            let output = std::process::Command::new("git").args(args).current_dir(&workspace).output()?;
            anyhow::ensure!(output.status.success(), "Git fixture failed");
            Ok(String::from_utf8(output.stdout)?.trim().into())
        };
        let path = workspace.to_str().unwrap();
        assert!(reserve(&root, "owner", "probe", "Prose", path, "fixture", &"a".repeat(40)).is_err());
        git(&["init", "-b", "fixture"])?;
        git(&["config", "user.name", "Fixture"])?;
        git(&["config", "user.email", "fixture@example.invalid"])?;
        std::fs::write(workspace.join("a.ts"), "// Safe prose.\n")?;
        git(&["add", "."])?; git(&["commit", "-m", "fixture"])?;
        let commit = git(&["rev-parse", "HEAD"])?;
        let first = reserve(&root, "owner", "probe", "Prose", path, "fixture", &commit)?;
        assert_eq!(first, reserve(&root, "owner", "probe", "Prose", path, "fixture", &commit)?);
        let (_, task) = locate_task(&root.join("queues"), "owner")?;
        assert_eq!(task.status, TaskStatus::Completed);
        assert!(task.session_id.is_none() && task.provider.is_none() && task.session_config.is_none());
        assert_eq!(task.turns, 0);
        assert_eq!(std::fs::read_dir(root.join("queues/incoming"))?.count(), 0);
        let request = serde_json::from_value(json!({ "id":"move","kind":"status","taskId":"owner",
            "expectedStatus":"completed","status":"in_progress","createdAt":chrono::Utc::now(),
            "metadata": { "dashboardPrepared":true } }))?;
        assert!(crate::engine::operator::apply_request(&root, &request, &Default::default()).is_err());
        assert_eq!(locate_task(&root.join("queues"), "owner")?.1.status, TaskStatus::Completed);
        assert!(reserve(&root, "owner", "probe", "Prose", path, "wrong", &commit).is_err());
        assert!(reserve(&root, "other", "probe", "Prose", path, "fixture", "invalid").is_err());
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    result
}

#[test]
fn deferred_owner_requires_native_proof_and_binds_only_one_real_session() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-deferred-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join(".runner-receipts/creator-contexts"))?;
    std::fs::create_dir_all(root.join(".runner-receipts/native-creators"))?;
    let result = (|| -> Result<()> {
        let mut task = Task::new("original", "probe", "Automation", "Correct prose.");
        task.workspace = Some(root.to_string_lossy().into_owned());
        task.status = TaskStatus::Completed;
        assert!(!eligible(&root, &task)?);
        task.deferred_pr_owner = true;
        assert!(eligible(&root, &task).is_err());
        let context = json!({ "originKind": "spool_automation", "deferred": true,
            "taskId": task.id, "agent": task.agent, "branch": "user/prose", "workspace": root });
        write_json(root.join(".runner-receipts/creator-contexts/original.json"), &context)?;
        let owner = json!({ "originKind": "spool_automation", "deferred": true, "verified": true,
            "taskId": task.id, "agent": task.agent, "branch": "user/prose", "workspace": root,
            "sessionId": null, "prId": "42", "prUrl": "https://example.invalid/pullrequest/42",
            "originId": uuid::Uuid::new_v4() });
        let file = root.join(".runner-receipts/native-creators/original.json");
        write_json(&file, &owner)?;
        assert!(eligible(&root, &task)?);
        let session = uuid::Uuid::new_v4().to_string();
        assert!(bind_session(&root, &task, &session).is_err());
        task.session_id = Some(session.clone());
        bind_session(&root, &task, &session)?;
        assert_eq!(read(&file)?["sessionId"], session);
        assert_eq!(read(&file)?["deferred"], false);
        bind_session(&root, &task, &session)?;
        assert!(bind_session(&root, &task, &uuid::Uuid::new_v4().to_string()).is_err());
        assert!(!eligible(&root, &task)?);
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    result
}
