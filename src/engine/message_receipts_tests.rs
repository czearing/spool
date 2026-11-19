use super::*;
use crate::models::task::OperatorMessage;
use crate::queue::fs::{read_task, write_task, QueuePaths};
use serde_json::json;

fn fixture(case: &str) -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-message-receipt-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let queues = QueuePaths::new(root.join("queues"));
        queues.ensure_dirs()?;
        std::fs::create_dir_all(root.join("logs"))?;
        let session = uuid::Uuid::new_v4().to_string();
        let other = uuid::Uuid::new_v4().to_string();
        let history = root.join("history");
        std::fs::create_dir_all(history.join(&session))?;
        std::fs::create_dir_all(history.join(&other))?;
        let mut task = Task::new("original", "engineer", "Original task", "Do not replay");
        task.session_id = Some(session.clone());
        task.interaction.phase = "running".into();
        task.interaction.messages.push(OperatorMessage {
            id: "original-message".into(),
            text: "Make the priority table".into(),
            status: "delivery_uncertain".into(),
            created_at: "2026-11-19T01:07:17Z".parse()?,
            session_id: Some(session.clone()),
            error: Some("Interrupted".into()),
        });
        task.interaction.messages.push(OperatorMessage {
            id: "followup".into(),
            text: "Keep going".into(),
            status: "delivered".into(),
            created_at: "2026-11-19T01:07:28Z".parse()?,
            session_id: Some(session.clone()),
            error: None,
        });
        let file = queues.in_progress.join("original.json");
        write_task(&file, &task)?;
        let mut saved: Value = serde_json::from_slice(&std::fs::read(&file)?)?;
        saved["future_field"] = json!({"preserve":true});
        write_json(&file, &saved)?;
        let events = [
            json!({"type":"session.start","timestamp":"2026-11-19T01:07:18Z","data":{"sessionId":session,"taskId":"original"}}),
            json!({"type":"user.message","timestamp":"2026-11-19T01:07:18Z","data":{"messageId":"original-message","content":"Make the priority table"}}),
            json!({"type":"session.turn_end","timestamp":"2026-11-19T01:07:29Z","data":{"sessionId":session,"stopReason":"cancelled"}}),
            json!({"type":"user.message","timestamp":"2026-11-19T01:07:30Z","data":{"messageId":"followup","content":"Keep going"}}),
        ];
        let log = events
            .iter()
            .map(|event| format!("{event}\n"))
            .collect::<String>();
        std::fs::write(root.join("logs/original.log"), log)?;
        let mut receipt = json!({"type":"user.message","timestamp":"2026-11-19T01:07:24Z",
            "data":{"content":"Autopilot objective: Make the priority table","agentMode":"autopilot"}});
        match case {
            "later" => receipt["timestamp"] = "2026-11-19T01:07:31Z".into(),
            "earlier" => receipt["timestamp"] = "2026-11-19T01:07:16Z".into(),
            "subagent" => receipt["agentId"] = "child".into(),
            "injected" => receipt["data"]["source"] = "system".into(),
            "other-text" => {
                receipt["data"]["content"] = "Autopilot objective: Different instructions".into()
            }
            "reply-only" => receipt["type"] = "assistant.message".into(),
            "ordinary" => {
                receipt["data"]["agentMode"] = "interactive".into();
                receipt["data"]["content"] = "Make the priority table".into();
            }
            _ => {}
        }
        let content = if case == "incomplete" {
            receipt.to_string()
        } else {
            format!("{receipt}\n")
        };
        std::fs::write(
            history
                .join(if case == "other-session" {
                    &other
                } else {
                    &session
                })
                .join("events.jsonl"),
            content,
        )?;
        let expected = usize::from(matches!(case, "saved" | "ordinary"));
        assert_eq!(
            reconcile_with_history(&root, "original", &history)?,
            expected,
            "{case}"
        );
        let actual: Value = serde_json::from_slice(&std::fs::read(&file)?)?;
        let mut expected_value = saved;
        if expected > 0 {
            expected_value["interaction"]["messages"][0]["status"] = "delivered".into();
            expected_value["interaction"]["messages"][0]["error"] = Value::Null;
            expected_value["updated_at"] = actual["updated_at"].clone();
        }
        assert_eq!(
            actual, expected_value,
            "{case}: workflow state or unrelated history changed"
        );
        assert_eq!(
            reconcile_with_history(&root, "original", &history)?,
            0,
            "{case}: repair must be idempotent"
        );
        assert_eq!(read_task(file)?.interaction.messages.len(), 2);
        assert!(
            !root.join("controls/requests").exists(),
            "Recovery must never enqueue or resend input"
        );
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    result
}

#[test]
fn repairs_a_saved_input_interrupted_before_a_reply_without_resending() -> Result<()> {
    fixture("saved")?;
    fixture("ordinary")
}

#[test]
fn never_uses_later_replies_or_another_input_session_or_source_as_delivery_proof() -> Result<()> {
    for case in [
        "later",
        "earlier",
        "subagent",
        "injected",
        "other-text",
        "reply-only",
        "other-session",
        "incomplete",
    ] {
        fixture(case)?;
    }
    Ok(())
}
