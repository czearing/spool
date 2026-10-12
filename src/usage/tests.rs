use super::*;
use serde_json::{json, Value};

fn scratch() -> Result<std::path::PathBuf> {
    let root = std::env::temp_dir().join(format!("spool-usage-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("sessions").join("session-1"))?;
    Ok(root)
}
fn at(day: &str) -> DateTime<Utc> { DateTime::parse_from_rfc3339(&format!("2026-{day}T12:00:00Z")).unwrap().with_timezone(&Utc) }
fn event(id: &str, kind: &str, day: &str, data: Value) -> Value {
    json!({ "id": id, "type": kind, "timestamp": at(day), "data": data })
}
fn metric(input: u64, output: u64, read: u64, write: u64) -> Value {
    json!({ "usage": { "inputTokens": input + read + write, "outputTokens": output,
        "cacheReadTokens": read, "cacheWriteTokens": write } })
}
fn snapshot(id: &str, day: &str, models: Value) -> Value {
    event(id, "session.shutdown", day, json!({ "modelMetrics": models, "totalNanoAiu": 999999999999u64 }))
}
fn history() -> Vec<Value> {
    vec![
        event("start", "session.start", "09-01", json!({"sessionId":"session-1"})),
        snapshot("old", "09-02", json!({"gpt-6-astra":metric(1_000_000, 0, 0, 0)})),
        event("resume", "session.resume", "09-20", json!({})),
        snapshot("middle", "09-20", json!({"gpt-6-astra":metric(1_000_000, 100_000, 0, 0)})),
        event("user", "user.message", "10-01", json!({"content":"PRIVATE"})),
        snapshot("recent", "10-01", json!({"gpt-6-astra":metric(1_000_000, 100_000, 1_000_000, 0)})),
    ]
}
fn write_history(root: &Path, events: &[Value]) -> Result<()> {
    fs::write(root.join("sessions").join("session-1").join("events.jsonl"),
        events.iter().map(|row| format!("{row}\n")).collect::<String>())?;
    Ok(())
}
fn read(root: &Path) -> Result<SessionUsage> { provider::read_session(&root.join("sessions"), "session-1") }

#[test]
fn cumulative_model_tokens_become_dated_costs_without_credit_conversion_or_replay() -> Result<()> {
    let root = scratch()?;
    let mut events = history();
    events.push(events[5].clone());
    events.push(snapshot("duplicate-shutdown", "10-01", events[5]["data"]["modelMetrics"].clone()));
    write_history(&root, &events)?;
    let rows = read(&root)?.records;
    assert_eq!(rows.iter().map(|row| row.cost_usd).collect::<Vec<_>>(), vec![Some(2.5), Some(1.0), Some(1.25)]);
    assert_eq!(rows[2].started_at, at("10-01"));
    assert_eq!(rows[1].started_at, at("09-20"));
    assert!(!serde_json::to_string(&rows)?.contains("PRIVATE"));
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn cache_categories_are_priced_once_and_local_model_rates_are_preserved() -> Result<()> {
    let tokens = tokens::Tokens::read(&metric(100, 20, 50, 30))?;
    assert_eq!(tokens.cost("gpt-6-astra"), Some(0.0005875));
    assert_eq!(tokens.cost("claude-opus-5"), Some(0.0036375));
    assert_eq!(tokens.cost("claude-sonnet-5"), Some(0.0007275));
    assert_eq!(tokens.cost("gemini-3.7-flash"), Some(0.00002225));
    assert_eq!(tokens.cost("future-unknown"), None);
    let mut details = metric(100, 20, 50, 30);
    details["tokenDetails"] = json!({"input":{"tokenCount":100},"output":{"tokenCount":20},
        "cache_read":{"tokenCount":50},"cache_write":{"tokenCount":30}});
    assert_eq!(tokens::Tokens::read(&details)?, tokens);
    details["usage"] = metric(0, 0, 0, 0)["usage"].clone();
    assert_eq!(tokens::Tokens::read(&details)?, tokens);
    details["tokenDetails"]["input"]["tokenCount"] = json!(-1);
    assert!(tokens::Tokens::read(&details).is_err());
    Ok(())
}

#[test]
fn unknown_models_remain_unpriced_and_model_switches_use_each_models_rate() -> Result<()> {
    let root = scratch()?;
    let mut events = history();
    events[5]["data"]["modelMetrics"]["claude-sonnet-5"] = metric(1_000_000, 0, 0, 0);
    events[5]["data"]["modelMetrics"]["unknown"] = metric(1, 1, 0, 0);
    write_history(&root, &events)?;
    let usage = read(&root)?;
    assert!(usage.error.unwrap().contains("unknown"));
    assert_eq!(usage.records.iter().find(|row| row.model == "claude-sonnet-5").unwrap().cost_usd, Some(3.0));
    assert_eq!(usage.records.iter().find(|row| row.model == "unknown").unwrap().cost_usd, None);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn bad_counts_and_conflicting_replays_fail_without_losing_recorded_history() -> Result<()> {
    let root = scratch()?;
    write_history(&root, &history())?;
    let mut ledger = Ledger::default();
    merge(&mut ledger, "session-1", read(&root), |_| Some("engineer".into()))?;
    merge(&mut ledger, "session-1", read(&root), |_| Some("reviewer".into()))?;
    assert!(ledger.sessions["session-1"].records.iter().all(|row| row.agent.as_deref() == Some("engineer")));
    for bad in [json!(-1), json!(1.5), json!(null), json!(1)] {
        let mut events = history();
        events[5]["data"]["modelMetrics"]["gpt-6-astra"]["usage"]["inputTokens"] = bad;
        write_history(&root, &events)?;
        assert!(read(&root).is_err());
    }
    merge(&mut ledger, "session-1", read(&root), |_| None)?;
    assert_eq!(ledger.sessions["session-1"].records.len(), 3);
    assert!(ledger.sessions["session-1"].error.is_some());
    let mut events = history();
    let mut conflicting = events[5].clone();
    conflicting["data"]["modelMetrics"]["gpt-6-astra"] = metric(2_000_000, 100_000, 1_000_000, 0);
    events.push(conflicting); write_history(&root, &events)?;
    assert!(read(&root).is_err());
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn incomplete_turns_and_credit_only_sources_are_explicit() -> Result<()> {
    use std::io::Write;
    let root = scratch()?;
    let mut events = history();
    events.push(event("resume-only", "session.resume", "10-02", json!({})));
    write_history(&root, &events)?;
    assert!(read(&root)?.error.is_none());
    events.push(event("interrupted", "assistant.turn_start", "10-02", json!({})));
    write_history(&root, &events)?;
    fs::OpenOptions::new().append(true).open(root.join("sessions").join("session-1").join("events.jsonl"))?
        .write_all(b"{\"type\":\"session.shutdown\"")?;
    assert!(read(&root)?.error.unwrap().contains("incomplete"));
    write_history(&root, &[events[0].clone(), event("credits", "session.usage_checkpoint", "10-02", json!({"totalNanoAiu":100}))])?;
    assert!(read(&root).is_err());
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn recovery_migrates_without_credit_dollars_and_deduplicates_task_archives() -> Result<()> {
    let root = scratch()?;
    write_history(&root, &history())?;
    let queues = crate::queue::fs::QueuePaths::new(root.join("queues"));
    queues.ensure_dirs()?;
    fs::create_dir_all(queues.base.join(".runner-archive"))?;
    let mut task = Task::new("job", "engineer", "Private title", "PRIVATE");
    task.session_id = Some("session-1".into());
    crate::queue::fs::write_task(queues.completed.join("job.json"), &task)?;
    task.agent = "reviewer".into();
    crate::queue::fs::write_task(queues.base.join(".runner-archive").join("job-old.json"), &task)?;
    fs::create_dir_all(root.join("usage"))?;
    write_json(root.join("usage").join("accounting.json"), &json!({"version":1,"unit":"nano_aiu","unavailableTasks":[],
        "sessions":{"session-1":{"records":[{"agent":"engineer","costUsd":9999}]},
            "missing-session":{"records":[{"agent":"engineer","costUsd":5555}]}}}))?;
    sync::sync_from(&root, &root.join("sessions"))?;
    sync::sync_from(&root, &root.join("sessions"))?;
    let text = fs::read_to_string(root.join("usage").join("accounting.json"))?;
    let ledger: Ledger = serde_json::from_str(&text)?;
    assert_eq!(ledger.version, 2);
    assert_eq!(ledger.sessions["session-1"].records.len(), 3);
    assert!(ledger.sessions["session-1"].records.iter().all(|row| row.agent.is_none()));
    assert!(ledger.sessions["missing-session"].error.is_some());
    assert!(!text.contains("9999") && !text.contains("5555") && !text.contains("PRIVATE"));
    assert!(root.join("usage").join("accounting.credits-v1.json").exists());
    fs::remove_dir_all(root)?;
    Ok(())
}
