use super::*;
use std::fs::{self, OpenOptions};
use std::io::Write;
use serde_json::json;

fn event(kind: &str, data: Value) -> Value {
    json!({ "type": kind, "timestamp": Utc::now(), "data": data })
}
fn append(file: &std::path::Path, events: &[Value]) -> Result<()> {
    let mut file = OpenOptions::new().append(true).create(true).open(file)?;
    for event in events { writeln!(file, "{event}")?; }
    Ok(())
}
fn final_events(turn: &str) -> Vec<Value> {
    vec![event("assistant.turn_start", json!({"turnId":turn})),
        event("assistant.message", json!({"turnId":turn,"phase":"final_answer","toolRequests":[]})),
        event("assistant.turn_end", json!({"turnId":turn}))]
}
fn fixture(test: impl FnOnce(&std::path::Path, &mut CompletionWatch) -> Result<()>) -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-completion-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root)?;
    let file = root.join("events.jsonl");
    append(&file, &final_events("old"))?;
    let mut watch = CompletionWatch::new(file.clone(), Utc::now())?;
    let result = test(&file, &mut watch);
    fs::remove_dir_all(root)?;
    result
}
#[test]
fn only_a_new_final_answer_with_its_matching_turn_end_confirms_completion() -> Result<()> {
    fixture(|file, watch| {
        assert!(!watch.check()?, "Existing history must not release a new turn");
        append(file, &[
            event("assistant.turn_start", json!({"turnId":"current"})),
            event("assistant.message", json!({"turnId":"current","phase":"commentary","toolRequests":[]})),
            event("assistant.turn_end", json!({"turnId":"current"})),
        ])?;
        assert!(!watch.check()?, "Commentary is not a final answer");
        let events = final_events("final");
        append(file, &events[..2])?;
        assert!(!watch.check()?, "A final answer alone is insufficient");
        append(file, &[event("assistant.turn_end", json!({"turnId":"different"}))])?;
        assert!(!watch.check()?, "Unrelated turn ends cannot release the turn");
        append(file, &events)?;
        assert!(watch.check()?);
        Ok(())
    })
}
#[test]
fn millisecond_provider_events_are_not_older_than_their_current_prompt() -> Result<()> {
    fixture(|file, watch| {
        watch.since = DateTime::parse_from_rfc3339("2026-10-16T22:00:00.123456789Z")?.with_timezone(&Utc);
        for (turn, timestamp, complete) in [
            ("stale", "2026-10-16T22:00:00.122Z", false),
            ("current", "2026-10-16T22:00:00.123Z", true),
        ] {
            let mut events = final_events(turn);
            for event in &mut events { event["timestamp"] = json!(timestamp); }
            append(file, &events)?;
            assert_eq!(watch.check()?, complete, "Provider timestamps are rounded down to milliseconds");
        }
        Ok(())
    })
}
#[test]
fn resumed_activity_and_subagent_final_answers_do_not_release_the_parent() -> Result<()> {
    fixture(|file, watch| {
        let mut events = final_events("child");
        for event in &mut events { event["agentId"] = json!("child-agent"); }
        append(file, &events)?;
        assert!(!watch.check()?);
        append(file, &final_events("parent"))?;
        append(file, &[event("tool.execution_start", json!({"toolCallId":"still-working"}))])?;
        assert!(!watch.check()?);
        append(file, &final_events("parent2"))?;
        append(file, &[event("assistant.turn_start", json!({"turnId":"new-work"}))])?;
        assert!(!watch.check()?);
        Ok(())
    })
}
#[test]
fn partial_new_events_and_truncated_history_never_reuse_stale_completion() -> Result<()> {
    fixture(|file, watch| {
        append(file, &final_events("done"))?;
        assert!(watch.check()?);
        let activity = event("tool.execution_start", json!({"toolCallId":"next"})).to_string();
        OpenOptions::new().append(true).open(file)?.write_all(activity.as_bytes())?;
        assert!(!watch.check()?, "Unfinished newer records must prevent release");
        OpenOptions::new().append(true).open(file)?.write_all(b"\n")?;
        assert!(!watch.check()?);
        fs::write(file, "")?;
        assert!(!watch.check()?);
        append(file, &final_events("after-truncation"))?;
        assert!(watch.check()?);
        Ok(())
    })
}
#[test]
fn malformed_records_are_explicit_errors_not_completion() -> Result<()> {
    fixture(|file, watch| {
        append(file, &final_events("done"))?;
        OpenOptions::new().append(true).open(file)?.write_all(b"not JSON\n")?;
        assert!(watch.check().unwrap_err().to_string().contains("Invalid provider completion event"));
        Ok(())
    })
}
