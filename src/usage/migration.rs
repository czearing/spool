use super::*;
use serde_json::Value;

pub(super) fn read(directory: &Path, bytes: &[u8]) -> Result<Ledger> {
    let value: Value = serde_json::from_slice(bytes).context("Invalid usage ledger")?;
    if value["version"] != 1 { return serde_json::from_value(value).context("Invalid model usage ledger"); }
    anyhow::ensure!(value["unit"] == "nano_aiu", "Unsupported legacy usage ledger");
    let sessions = value["sessions"].as_object().context("Invalid legacy sessions")?;
    let backup = directory.join("accounting.credits-v1.json");
    if !backup.exists() { write_json(&backup, &value)?; }
    Ok(Ledger {
        sessions: sessions.keys().map(|session| (session.clone(), SessionUsage {
            records: Vec::new(), error: Some("Model token history has not been recovered; legacy credit conversion is excluded".into()),
        })).collect(),
        unavailable_tasks: serde_json::from_value(value["unavailableTasks"].clone())?,
        ..Ledger::default()
    })
}

pub(super) fn previous_agents(root: &Path) -> Result<BTreeMap<String, BTreeSet<String>>> {
    let bytes = match fs::read(root.join("usage").join("accounting.credits-v1.json")) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error.into()),
    };
    let ledger: Value = serde_json::from_slice(&bytes)?;
    let mut result = BTreeMap::new();
    for (session, usage) in ledger["sessions"].as_object().context("Invalid legacy sessions")? {
        let agents = usage["records"].as_array().context("Invalid legacy intervals")?.iter()
            .filter_map(|record| record["agent"].as_str().map(str::to_owned)).collect();
        result.insert(session.clone(), agents);
    }
    Ok(result)
}
