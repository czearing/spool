use std::{collections::{BTreeMap, BTreeSet, HashMap}, fs::File, io::{BufRead, BufReader}, path::{Path, PathBuf}};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde_json::Value;
use super::{SessionUsage, UsageRecord, tokens::Tokens};

pub(crate) fn session_root() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("SPOOL_COPILOT_SESSION_ROOT") { return Ok(path.into()); }
    let home = std::env::var_os("COPILOT_HOME").map(PathBuf::from).or_else(||
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(|home| PathBuf::from(home).join(".copilot")))
        .context("Copilot session home is unavailable")?;
    Ok(home.join("session-state"))
}

pub(super) fn read_session(directory: &Path, session: &str) -> Result<SessionUsage> {
    crate::queue::fs::validate_id(session)?;
    let mut reader = BufReader::new(File::open(directory.join(session).join("events.jsonl"))
        .context("Provider model usage history is unavailable")?);
    let (mut initialized, mut start, mut last_end, mut activity) = (false, None, None, false);
    let mut totals = BTreeMap::<String, Tokens>::new();
    let mut records = Vec::new();
    let mut unpriced = BTreeSet::new();
    let mut seen = HashMap::new();
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        if reader.read_until(b'\n', &mut buffer)? == 0 || buffer.last() != Some(&b'\n') { break; }
        anyhow::ensure!(buffer.len() <= 16 * 1024 * 1024, "Provider usage line exceeds 16 MiB");
        let line = std::str::from_utf8(&buffer)?;
        if !["session.start", "session.resume", "assistant.turn_start", "user.message", "session.shutdown"]
            .iter().any(|kind| line.contains(kind)) { continue; }
        let event: Value = serde_json::from_str(line).context("Invalid provider usage event")?;
        if event.get("agentId").is_some_and(|id| !id.is_null()) { continue; }
        let kind = event["type"].as_str().unwrap_or("");
        if !matches!(kind, "session.start" | "session.resume" | "assistant.turn_start" | "user.message" | "session.shutdown") { continue; }
        let at = DateTime::parse_from_rfc3339(event["timestamp"].as_str().context("Missing usage timestamp")?)?.with_timezone(&Utc);
        if kind == "session.start" {
            anyhow::ensure!(!initialized && event["data"]["sessionId"] == session, "Provider session identity mismatch");
            initialized = true;
            start = Some(at);
            continue;
        }
        anyhow::ensure!(initialized, "Provider history has no verified session beginning");
        if kind != "session.shutdown" {
            if !activity { start = Some(at); }
            activity |= kind != "session.resume";
            continue;
        }
        let Some(metrics) = event["data"].get("modelMetrics").and_then(Value::as_object).filter(|metrics| !metrics.is_empty())
            else { activity = true; continue; };
        let current: BTreeMap<_, _> = metrics.iter().map(|(model, value)| {
            anyhow::ensure!(!model.is_empty(), "Missing usage model");
            Ok((model.clone(), Tokens::read(value)?))
        }).collect::<Result<_>>()?;
        let id = event["id"].as_str().filter(|id| !id.is_empty()).context("Missing provider usage identity")?;
        if let Some(previous) = seen.insert(id.to_owned(), (at, current.clone())) {
            anyhow::ensure!(previous == (at, current), "Conflicting provider usage identity");
            continue;
        }
        anyhow::ensure!(last_end.is_none_or(|last| at >= last), "Provider usage timestamps moved backwards");
        anyhow::ensure!(totals.keys().all(|model| current.contains_key(model)), "Provider model history was truncated");
        let since = start.or(last_end).context("Provider usage interval is unknown")?;
        anyhow::ensure!(at >= since, "Invalid provider usage interval");
        for (model, total) in &current {
            let tokens = total.delta(totals.get(model).unwrap_or(&Tokens::default()))?;
            if tokens == Tokens::default() && !records.is_empty() { continue; }
            let cost_usd = tokens.cost(model);
            if cost_usd.is_none() { unpriced.insert(model.clone()); }
            records.push(UsageRecord { id: format!("{id}:{model}"), started_at: since, ended_at: at,
                model: model.clone(), tokens, cost_usd, agent: None });
        }
        totals = current;
        start = None;
        activity = false;
        last_end = Some(at);
    }
    anyhow::ensure!(!records.is_empty(), "Provider did not record per-model token snapshots");
    let mut errors = Vec::new();
    if activity { errors.push("Provider has activity without a model token snapshot; recorded usage is incomplete".to_owned()); }
    if !unpriced.is_empty() { errors.push(format!("No verified local rate for models: {}", unpriced.into_iter().collect::<Vec<_>>().join(", "))); }
    Ok(SessionUsage { records, error: (!errors.is_empty()).then(|| errors.join("; ")) })
}
