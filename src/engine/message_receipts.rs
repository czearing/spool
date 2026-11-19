use crate::models::Task;
use crate::queue::fs::{locate_task, validate_id, write_json, TaskGuard};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs::File,
    io::{BufRead, BufReader, Read},
    path::Path,
};

struct Attempt {
    session: String,
    started: DateTime<Utc>,
    ended: DateTime<Utc>,
    messages: Vec<(Option<String>, String)>,
}

fn events(file: &Path, mut observe: impl FnMut(Value)) -> Result<()> {
    let file = match File::open(file) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let mut reader = BufReader::new(file);
    loop {
        let mut line = Vec::new();
        let count = (&mut reader)
            .take(16 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut line)?;
        anyhow::ensure!(
            count <= 16 * 1024 * 1024,
            "Message receipt event exceeds 16 MiB"
        );
        if line.last() != Some(&b'\n') {
            break;
        }
        if let Ok(value) = serde_json::from_slice(&line) {
            observe(value);
        }
    }
    Ok(())
}

fn attempts(root: &Path, task: &Task) -> Result<Vec<Attempt>> {
    let mut session = None;
    let mut current: Option<Attempt> = None;
    let mut attempts = Vec::new();
    events(
        &root.join("logs").join(format!("{}.log", task.id)),
        |event| {
            let Some(at) = event["timestamp"]
                .as_str()
                .and_then(|at| at.parse::<DateTime<Utc>>().ok())
            else {
                return;
            };
            let data = &event["data"];
            match event["type"].as_str() {
                Some("session.start") => {
                    if let Some(mut attempt) = current.take() {
                        attempt.ended = at;
                        attempts.push(attempt);
                    }
                    session = (data["taskId"] == task.id)
                        .then(|| data["sessionId"].as_str().map(str::to_owned))
                        .flatten();
                }
                Some("user.message") => {
                    let (Some(session), Some(text)) = (&session, data["content"].as_str()) else {
                        return;
                    };
                    let attempt = current.get_or_insert_with(|| Attempt {
                        session: session.clone(),
                        started: at,
                        ended: Utc::now(),
                        messages: Vec::new(),
                    });
                    attempt.messages.push((
                        data["messageId"].as_str().map(str::to_owned),
                        text.to_owned(),
                    ));
                }
                Some("session.turn_end")
                    if session
                        .as_deref()
                        .is_some_and(|session| data["sessionId"] == session) =>
                {
                    if let Some(mut attempt) = current.take() {
                        attempt.ended = at;
                        attempts.push(attempt);
                    }
                }
                _ => {}
            }
        },
    )?;
    if let Some(attempt) = current {
        attempts.push(attempt);
    }
    attempts.retain(|attempt| {
        task.interaction.messages.iter().any(|message| {
            message.status == "delivery_uncertain"
                && message.session_id.as_deref() == Some(&attempt.session)
                && attempt
                    .messages
                    .iter()
                    .any(|(id, text)| id.as_deref() == Some(&message.id) && text == &message.text)
        })
    });
    Ok(attempts)
}

pub fn reconcile(root: &Path, id: &str) -> Result<usize> {
    reconcile_with_history(root, id, &crate::usage::session_root()?)
}

fn reconcile_with_history(root: &Path, id: &str, history: &Path) -> Result<usize> {
    validate_id(id)?;
    let queues = root.join("queues");
    let task = {
        let _guard = TaskGuard::acquire(&queues, id)?;
        locate_task(&queues, id)?.1
    };
    if task
        .session_config
        .as_ref()
        .is_some_and(|config| config.provider.is_some())
    {
        return Ok(0);
    }
    let mut confirmed = HashSet::new();
    for attempt in attempts(root, &task)? {
        uuid::Uuid::parse_str(&attempt.session).context("Invalid message receipt session")?;
        let prompt = attempt
            .messages
            .iter()
            .map(|(_, text)| text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let objective = format!("Autopilot objective: {}", prompt.trim());
        events(
            &history.join(&attempt.session).join("events.jsonl"),
            |event| {
                if event["type"] != "user.message"
                    || !event["agentId"].is_null()
                    || !event["data"]["agentId"].is_null()
                    || !event["data"]["source"].is_null()
                {
                    return;
                }
                let Some(at) = event["timestamp"]
                    .as_str()
                    .and_then(|at| at.parse::<DateTime<Utc>>().ok())
                else {
                    return;
                };
                if at < attempt.started || at > attempt.ended {
                    return;
                }
                let data = &event["data"];
                let expected = if data["agentMode"] == "autopilot" {
                    objective.as_str()
                } else {
                    prompt.as_str()
                };
                if data["content"].as_str() == Some(expected) {
                    for (id, _) in &attempt.messages {
                        if let Some(id) = id {
                            confirmed.insert(id.clone());
                        }
                    }
                }
            },
        )?;
    }
    if confirmed.is_empty() {
        return Ok(0);
    }
    let _guard = TaskGuard::acquire(&queues, id)?;
    let (file, _) = locate_task(&queues, id)?;
    // Preserve unknown fields and workflow state when repairing records owned by older daemons.
    let mut value: Value = serde_json::from_slice(&std::fs::read(&file)?)?;
    let mut changed = 0;
    if let Some(messages) = value["interaction"]["messages"].as_array_mut() {
        for message in messages {
            let previous = task
                .interaction
                .messages
                .iter()
                .find(|saved| message["id"] == saved.id);
            if message["status"] == "delivery_uncertain"
                && previous.is_some_and(|saved| {
                    confirmed.contains(&saved.id)
                        && message["text"] == saved.text
                        && message["session_id"].as_str() == saved.session_id.as_deref()
                })
            {
                message["status"] = "delivered".into();
                message["error"] = Value::Null;
                changed += 1;
            }
        }
    }
    if changed > 0 {
        value["updated_at"] = Utc::now().to_rfc3339().into();
        write_json(file, &value)?;
    }
    Ok(changed)
}

#[cfg(test)]
#[path = "message_receipts_tests.rs"]
mod tests;
