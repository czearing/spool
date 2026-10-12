use super::*;
use crate::engine::operator_message::enqueue;
use crate::models::task::OperatorMessage;
use crate::queue::fs::{write_task, QueuePaths};

fn fixture() -> Result<(PathBuf, Task, OperatorRequest)> {
    let root = std::env::temp_dir().join(format!("spool-prepared-message-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("agents"))?;
    std::fs::write(root.join("agents/probe.md"), "Probe")?;
    let mut task = Task::new("original", "probe", "Original title", "Original assignment");
    task.status = TaskStatus::Completed;
    task.session_id = Some("saved-session".into());
    task.workspace = Some(root.to_string_lossy().into_owned());
    let request = serde_json::from_value(json!({
        "id": "followup", "kind": "message", "taskId": task.id,
        "message": "Only this new feedback", "createdAt": chrono::Utc::now(),
        "metadata": { "key": "pr-feedback", "agent": task.agent, "sessionId": task.session_id,
            "expectedUpdatedAt": task.updated_at, "workspace": root, "metadata": {
                "runner": "pr-updater",
                "preparation": { "ready": true, "repoRoot": root, "branch": "fixture", "commit": "verified" },
                "contract": { "submissionId": "pr-feedback", "identifier": task.id, "agent": task.agent,
                    "cwd": root, "branch": "fixture", "fingerprint": "fresh-feedback" }
            }
        }
    }))?;
    Ok((root, task, request))
}

#[test]
fn prepared_feedback_preserves_original_conversation_and_commits_metadata_with_message() -> Result<()> {
    let (root, mut task, request) = fixture()?;
    let original = task.clone();
    let result = (|| -> Result<()> {
        enqueue(&root, &mut task, &request, false)?;
        assert_eq!(task.prompt, original.prompt);
        assert_eq!(task.session_id, original.session_id);
        assert_eq!(task.status, TaskStatus::Incoming);
        assert_eq!(task.interaction.messages.len(), 1);
        assert_eq!(task.interaction.messages[0].text, request.message.as_ref().unwrap().as_str());
        assert_eq!(task.metadata(&root)?.unwrap()["contract"]["fingerprint"], "fresh-feedback");
        let paths = QueuePaths::new(root.join("queues"));
        paths.ensure_dirs()?;
        write_task(paths.incoming.join("original.json"), &task)?;
        let saved = crate::queue::fs::read_task(paths.incoming.join("original.json"))?;
        assert_eq!(saved.runner_metadata, task.runner_metadata);
        assert_eq!(saved.interaction.messages.len(), 1);
        assert!(!root.join(".runner-receipts").exists(), "Acceptance must not depend on a separate metadata write");
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    result
}

#[test]
fn deferred_owner_only_starts_for_verified_prepared_pr_feedback() -> Result<()> {
    let (root, mut task, mut request) = fixture()?;
    let result = (|| -> Result<()> {
        task.session_id = None;
        task.deferred_pr_owner = true;
        request.metadata.as_mut().unwrap()["sessionId"] = Value::Null;
        request.metadata.as_mut().unwrap()["metadata"]["contract"]["prId"] = json!("42");
        let context = json!({ "originKind": "spool_automation", "deferred": true,
            "taskId": task.id, "agent": task.agent, "branch": "fixture", "workspace": root });
        let owner = json!({ "originKind": "spool_automation", "deferred": true, "verified": true,
            "taskId": task.id, "agent": task.agent, "branch": "fixture", "workspace": root,
            "sessionId": null, "prId": "42", "prUrl": "https://example.invalid/pullrequest/42",
            "originId": uuid::Uuid::new_v4() });
        std::fs::create_dir_all(root.join(".runner-receipts/creator-contexts"))?;
        std::fs::create_dir_all(root.join(".runner-receipts/native-creators"))?;
        crate::queue::fs::write_json(root.join(".runner-receipts/creator-contexts/original.json"), &context)?;
        crate::queue::fs::write_json(root.join(".runner-receipts/native-creators/original.json"), &owner)?;
        let mut ordinary = task.clone();
        ordinary.deferred_pr_owner = false;
        assert!(enqueue(&root, &mut ordinary, &request, false).is_err());
        let mut chat = request.clone(); chat.metadata = None;
        assert!(enqueue(&root, &mut task.clone(), &chat, false).is_err());
        for field in ["prId", "branch"] {
            let mut wrong = request.clone();
            wrong.metadata.as_mut().unwrap()["metadata"]["contract"][field] = json!("wrong");
            assert!(enqueue(&root, &mut task.clone(), &wrong, false).is_err());
        }
        enqueue(&root, &mut task, &request, false)?;
        assert_eq!(task.status, TaskStatus::Incoming);
        assert!(task.session_id.is_none());
        assert_eq!(task.turns, 0);
        assert_eq!(task.interaction.messages.len(), 1);
        assert_eq!(task.interaction.messages[0].text, "Only this new feedback");
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    result
}

#[test]
fn prepared_feedback_rejects_stale_identity_unverified_metadata_and_pending_delivery() -> Result<()> {
    let (root, task, request) = fixture()?;
    let result = (|| -> Result<()> {
        for field in ["agent", "sessionId", "expectedUpdatedAt", "workspace"] {
            let mut changed = request.clone();
            changed.metadata.as_mut().unwrap()[field] = json!("not-the-original");
            assert!(enqueue(&root, &mut task.clone(), &changed, false).is_err(), "{field}");
        }
        for field in ["ready", "repoRoot", "branch", "commit"] {
            let mut changed = request.clone();
            changed.metadata.as_mut().unwrap()["metadata"]["preparation"][field] = Value::Null;
            assert!(enqueue(&root, &mut task.clone(), &changed, false).is_err(), "{field}");
        }
        for field in ["submissionId", "identifier", "agent", "cwd", "branch"] {
            let mut changed = request.clone();
            changed.metadata.as_mut().unwrap()["metadata"]["contract"][field] = json!("wrong");
            assert!(enqueue(&root, &mut task.clone(), &changed, false).is_err(), "{field}");
        }
        assert!(enqueue(&root, &mut task.clone(), &request, true).is_err());
        for status in ["queued", "delivering", "delivery_uncertain"] {
            let mut changed = task.clone();
            changed.interaction.messages.push(OperatorMessage { id: "pending".into(), text: "Keep this input".into(),
                status: status.into(), created_at: chrono::Utc::now(), session_id: None, error: None });
            assert!(enqueue(&root, &mut changed, &request, false).is_err(), "{status}");
        }
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    result
}

#[test]
fn prepared_metadata_cannot_change_acceptance_and_ordinary_chat_preserves_current_contract() -> Result<()> {
    let (root, mut task, mut request) = fixture()?;
    let result = (|| -> Result<()> {
        task.acceptance = Some(json!({ "kind": "bundle-v2", "version": 2 }));
        task.runner_metadata = Some(json!({ "preparation": { "branch": "fixture" } }));
        request.metadata.as_mut().unwrap()["metadata"]["acceptance"] = json!({ "kind": "replaced" });
        assert!(enqueue(&root, &mut task.clone(), &request, false).is_err());
        request.metadata.as_mut().unwrap()["metadata"]["acceptance"] = task.acceptance.clone().unwrap();
        enqueue(&root, &mut task, &request, false)?;
        let metadata = task.runner_metadata.clone();
        request.metadata = None;
        request.id = "chat".into();
        request.message = Some("A normal chat question".into());
        enqueue(&root, &mut task, &request, false)?;
        assert_eq!(task.runner_metadata, metadata);
        assert_eq!(task.interaction.messages.len(), 2);
        assert_eq!(task.prompt, "Original assignment");
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    result
}

#[test]
#[ignore = "Bridge integration fixture: set SPOOL_CONTROL_FIXTURE_ROOT to an isolated fixture root"]
fn process_fixture_requests() -> Result<()> {
    let root = PathBuf::from(std::env::var("SPOOL_CONTROL_FIXTURE_ROOT")?);
    anyhow::ensure!(root.is_absolute() && root.join("native-control-fixture").is_file(), "Not an isolated control fixture");
    anyhow::ensure!(crate::copilot::process::interactive_enabled(), "Fixture requires interactive mode");
    super::super::operator::process_requests(&root, &Default::default())
}

#[test]
fn verified_workspace_migration_keeps_provider_settings_and_requires_provenance() -> Result<()> {
    let (root, mut task, mut request) = fixture()?;
    let result = (|| -> Result<()> {
        let destination = root.join("assigned");
        std::fs::create_dir_all(&destination)?;
        let config = crate::copilot::SessionConfig {
            model: "original-model".into(), reasoning_effort: Some("low".into()),
            workspace: root.to_string_lossy().into_owned(), agent: task.agent.clone(),
            mcp: Some(json!({ "keep": "original tools" })),
        };
        task.session_config = Some(config.clone());
        let prepared = request.metadata.as_mut().unwrap();
        prepared["workspace"] = json!(destination);
        prepared["metadata"]["preparation"]["repoRoot"] = json!(destination);
        prepared["metadata"]["contract"]["cwd"] = json!(destination);
        assert!(enqueue(&root, &mut task.clone(), &request, false).is_err());
        request.metadata.as_mut().unwrap()["metadata"]["workspaceMigration"] = json!({
            "reason": "assigned_agent_workspace", "previousWorkspace": root, "assignedWorkspace": destination,
        });
        enqueue(&root, &mut task, &request, false)?;
        let migrated = task.session_config.unwrap();
        assert_eq!(migrated.model, config.model);
        assert_eq!(migrated.reasoning_effort, config.reasoning_effort);
        assert_eq!(migrated.mcp, config.mcp);
        assert_eq!(PathBuf::from(migrated.workspace), std::fs::canonicalize(destination)?);
        assert_eq!(task.prompt, "Original assignment");
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    result
}
