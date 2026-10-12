use super::*;
use serde_json::json;

fn report(input: u64, read: u64, write: u64, output: u64) -> Value {
    json!({
        "sessionStartTime": "2026-09-23T23:08:24.762Z", "totalUserRequests": 1,
        "tokenDetails": {
            "input": {"tokenCount": input}, "cache_read": {"tokenCount": read},
            "cache_write": {"tokenCount": write}, "output": {"tokenCount": output},
        }
    })
}

#[test]
fn current_cli_reports_include_cached_input() {
    let usage = parse_usage_json(&report(6, 16322, 16412, 30).to_string());
    assert_eq!(usage.input_tokens, 32740);
    assert_eq!(usage.output_tokens, 30);
    assert_eq!(usage.cache_read_tokens, 16322);
    assert_eq!(usage.cache_write_tokens, 16412);
    assert_eq!(usage.turns, 1);
}

#[test]
fn acp_reports_include_cached_tokens_without_increasing_total_input() {
    let usage = parse_usage_json(r#"{"inputTokens":5741,"outputTokens":36,"cachedReadTokens":4864,"cachedWriteTokens":12}"#);
    assert_eq!(usage.input_tokens, 5741);
    assert_eq!(usage.cache_read_tokens, 4864);
    assert_eq!(usage.cache_write_tokens, 12);
}

#[test]
fn resumed_usage_counts_only_new_tokens() -> Result<()> {
    let previous = report(3, 0, 16322, 5).to_string();
    let current = report(6, 16322, 16412, 30).to_string();
    let usage = parse_usage_delta(&current, Some(&previous))?;
    assert_eq!(usage.input_tokens, 16415);
    assert_eq!(usage.output_tokens, 25);
    assert_eq!(usage.cache_read_tokens, 16322);
    assert_eq!(usage.cache_write_tokens, 90);
    assert_eq!(usage.turns, 1);
    Ok(())
}

#[test]
fn a_new_session_does_not_subtract_old_usage() -> Result<()> {
    let previous = report(6, 16322, 16412, 30).to_string();
    let mut current = report(3, 0, 16322, 5);
    current["sessionStartTime"] = json!("2026-09-23T23:09:00Z");
    let usage = parse_usage_delta(&current.to_string(), Some(&previous))?;
    assert_eq!(usage.input_tokens, 16325);
    assert_eq!(usage.cache_read_tokens, 0);
    Ok(())
}

#[test]
fn legacy_per_run_reports_are_not_subtracted() -> Result<()> {
    let report =
        r#"{"inputTokens":20,"outputTokens":10,"cacheReadTokens":5,"cacheWriteTokens":2}"#;
    let usage = parse_usage_delta(report, Some(report))?;
    assert_eq!(usage.input_tokens, 20);
    assert_eq!(usage.output_tokens, 10);
    assert_eq!(usage.cache_read_tokens, 5);
    assert_eq!(usage.cache_write_tokens, 2);
    Ok(())
}

#[test]
fn invalid_or_decreasing_reports_fail_explicitly() {
    assert!(parse_usage_delta("invalid", None).is_err());
    let current = report(3, 0, 16322, 5).to_string();
    let previous = report(6, 16322, 16412, 30).to_string();
    assert!(parse_usage_delta(&current, Some("invalid")).is_err());
    assert!(parse_usage_delta(&current, Some(&previous)).is_err());
}
