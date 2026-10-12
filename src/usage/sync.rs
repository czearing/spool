use super::*;
use crate::queue::fs::QueuePaths;
use serde_json::Value;

pub fn sync_project(root: &Path) -> Result<()> {
    sync_from(root, &provider::session_root()?)
}

pub(super) fn sync_from(root: &Path, session_root: &Path) -> Result<()> {
    update(root, |_| Ok(()))?;
    let queues = QueuePaths::new(root.join("queues"));
    let mut sessions: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut missing = BTreeSet::new();
    let mut uncertain = BTreeSet::new();
    for directory in [&queues.incoming, &queues.in_progress, &queues.completed, &queues.failed, &queues.base.join(".runner-archive")] {
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let path = entry?.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") { continue; }
            let task: Value = serde_json::from_slice(&fs::read(&path)?)?;
            let id = task["id"].as_str().context("Missing task identity for usage")?;
            validate_id(id)?;
            if let Some(session) = task["session_id"].as_str().filter(|id| !id.is_empty()) {
                validate_id(session)?;
                let agents = sessions.entry(session.into()).or_default();
                if let Some(agent) = task["agent"].as_str() { validate_id(agent)?; agents.insert(agent.into()); }
                if task["comments"].as_array().is_some_and(|comments| comments.iter().any(|comment|
                    comment["author"].as_str().is_some_and(|author| author.starts_with("handoff:")))) {
                    uncertain.insert(session.to_owned());
                }
            } else if directory != &queues.incoming {
                let created = task["created_at"].as_str().map(DateTime::parse_from_rfc3339).transpose()?
                    .map(|at| at.with_timezone(&Utc).to_rfc3339()).unwrap_or_else(|| "unknown".into());
                missing.insert(format!("{id}:{created}"));
            }
        }
    }
    for (session, previous) in migration::previous_agents(root)? {
        sessions.entry(session).or_default().extend(previous);
    }
    let records: Vec<_> = sessions.iter().map(|(session, agents)| {
        let agent = (agents.len() == 1 && !uncertain.contains(session)).then(|| agents.iter().next().unwrap().clone());
        (session, agent, provider::read_session(session_root, session))
    }).collect();
    update(root, |ledger| {
        for (session, agent, records) in records {
            merge(ledger, session, records, |_| agent.clone())?;
        }
        ledger.unavailable_tasks = missing;
        Ok(())
    })
}
