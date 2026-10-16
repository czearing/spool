mod provider;
mod sync;
mod rates;
mod tokens;
mod migration;
#[cfg(test)]
mod tests;

use std::{collections::{BTreeMap, BTreeSet}, fs, path::Path};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use crate::{models::Task, queue::fs::{validate_id, write_json}};
pub use sync::sync_project;
pub(crate) use provider::session_root;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub id: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: DateTime<Utc>,
    pub model: String,
    pub tokens: tokens::Tokens,
    pub cost_usd: Option<f64>,
    pub agent: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub records: Vec<UsageRecord>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    pub version: u32,
    pub unit: String,
    #[serde(default)]
    pub currency: Option<String>,
    pub updated_at: DateTime<Utc>,
    pub sessions: BTreeMap<String, SessionUsage>,
    pub unavailable_tasks: BTreeSet<String>,
}
impl Default for Ledger {
    fn default() -> Self {
        Self { version: 2, unit: "model_tokens".into(), currency: Some("USD".into()), updated_at: Utc::now(),
            sessions: BTreeMap::new(), unavailable_tasks: BTreeSet::new() }
    }
}

fn update(root: &Path, apply: impl FnOnce(&mut Ledger) -> Result<()>) -> Result<()> {
    let directory = root.join("usage");
    fs::create_dir_all(&directory)?;
    let lock = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .open(directory.join("accounting.lock"))?;
    lock.lock().context("Cannot lock usage accounting")?;
    let path = directory.join("accounting.json");
    let mut ledger: Ledger = match fs::read(&path) {
        Ok(bytes) => migration::read(&directory, &bytes)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ledger::default(),
        Err(error) => return Err(error.into()),
    };
    anyhow::ensure!(ledger.version == 2 && ledger.unit == "model_tokens", "Unsupported usage ledger");
    anyhow::ensure!(ledger.currency.as_deref().is_none_or(|currency| currency == "USD"), "Unsupported usage currency");
    apply(&mut ledger)?;
    ledger.currency = Some("USD".into());
    for session in ledger.sessions.values_mut() {
        for record in &mut session.records {
            record.cost_usd = record.tokens.cost(&record.model);
        }
    }
    ledger.updated_at = Utc::now();
    write_json(path, &ledger)
}

fn merge(ledger: &mut Ledger, session: &str, records: Result<SessionUsage>,
    attribution: impl Fn(&UsageRecord) -> Option<String>) -> Result<()> {
    let saved = ledger.sessions.entry(session.into()).or_default();
    let records = records.and_then(|mut usage| {
            let previous: BTreeMap<_, _> = saved.records.iter().map(|row| (row.id.as_str(), row)).collect();
            for row in &mut usage.records {
                if let Some(old) = previous.get(row.id.as_str()) {
                    anyhow::ensure!(old.tokens == row.tokens && old.model == row.model && old.started_at == row.started_at &&
                        old.ended_at == row.ended_at, "Provider changed a recorded usage checkpoint");
                    row.agent = old.agent.clone().or_else(|| attribution(row));
                } else { row.agent = attribution(row); }
            }
            anyhow::ensure!(saved.records.iter().all(|old| usage.records.iter().any(|row| row.id == old.id)),
                "Provider usage history was truncated; existing accounting is retained");
            Ok(usage)
    });
    match records {
        Ok(usage) => {
            if let Some(error) = &usage.error { eprintln!("Usage incomplete for session {session}: {error}"); }
            *saved = usage;
        }
        Err(error) => {
            let message = format!("{error:#}");
            eprintln!("Usage unavailable for session {session}: {message}");
            saved.error = Some(message);
        }
    }
    Ok(())
}

pub fn capture_task(root: &Path, task: &Task, started_at: DateTime<Utc>) -> Result<()> {
    let (_, latest) = crate::queue::fs::locate_task(&root.join("queues"), &task.id)?;
    if let Some(session) = latest.session_id {
        capture(root, task, &session, started_at)
    } else {
        eprintln!("Usage unavailable for task {}: no provider session was recorded", task.id);
        update(root, |ledger| {
            ledger.unavailable_tasks.insert(format!("{}:{}", task.id, task.created_at.to_rfc3339()));
            Ok(())
        })
    }
}

pub fn capture(root: &Path, task: &Task, session: &str, started_at: DateTime<Utc>) -> Result<()> {
    validate_id(session)?;
    let records = provider::read_session(&provider::session_root()?, session);
    update(root, |ledger| {
        merge(ledger, session, records, |record| (record.started_at >= started_at).then(|| task.agent.clone()))?;
        ledger.unavailable_tasks.remove(&format!("{}:{}", task.id, task.created_at.to_rfc3339()));
        Ok(())
    })
}
