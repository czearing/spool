use std::{fs::File, io::{BufRead, BufReader, Read, Seek, SeekFrom}, path::PathBuf};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde_json::Value;
use crate::models::Task;
use super::{Connection, mutate};
use tokio::time::{Duration, Instant};

pub(super) struct CompletionWatch {
    file: PathBuf,
    since: DateTime<Utc>,
    offset: u64,
    turn: Option<String>,
    final_turn: Option<String>,
    complete: bool,
    next_check: Instant,
    monitor_error: Option<String>,
    release_deadline: Option<Instant>,
}

impl CompletionWatch {
    pub(super) fn new(file: PathBuf, since: DateTime<Utc>) -> Result<Self> {
        let offset = match file.metadata() {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(error) => return Err(error.into()),
        };
        Ok(Self { file, since, offset, turn: None, final_turn: None, complete: false,
            next_check: Instant::now(), monitor_error: None, release_deadline: None })
    }

    pub(super) fn check(&mut self) -> Result<bool> {
        let file = File::open(&self.file).context("Provider completion history is unavailable")?;
        if file.metadata()?.len() < self.offset {
            self.offset = 0; self.turn = None; self.final_turn = None; self.complete = false;
        }
        let mut reader = BufReader::new(file);
        reader.seek(SeekFrom::Start(self.offset))?;
        let mut buffer = Vec::new();
        let mut scanned = 0;
        loop {
            buffer.clear();
            let count = (&mut reader).take(16 * 1024 * 1024 + 1).read_until(b'\n', &mut buffer)?;
            anyhow::ensure!(count <= 16 * 1024 * 1024, "Provider completion event exceeds 16 MiB");
            if count == 0 { break; }
            if buffer.last() != Some(&b'\n') { return Ok(false); }
            let event: Value = serde_json::from_slice(&buffer).context("Invalid provider completion event")?;
            self.observe(&event)?;
            self.offset += count as u64;
            scanned += count;
            // Do not act on an old final answer while unread newer activity remains.
            if scanned >= 4 * 1024 * 1024 { return Ok(false); }
        }
        Ok(self.complete)
    }

    pub(super) fn release(&mut self, root: &std::path::Path, task: Task,
        connection: &mut Connection, session: &str) -> Result<Task> {
        anyhow::ensure!(self.release_deadline.is_none_or(|deadline| Instant::now() < deadline),
            "Provider did not acknowledge completed-turn cancellation within 30 seconds; queued messages were not sent");
        let eligible = |task: &Task| !task.interaction.paused && !task.interaction.cancel_requested
            && task.interaction.status_change.is_none() && task.interaction.handoff.is_none()
            && task.interaction.messages.iter().any(|message| message.status == "queued");
        if !eligible(&task) || Instant::now() < self.next_check { return Ok(task); }
        self.next_check = Instant::now() + Duration::from_secs(1);
        match self.check() {
            Ok(true) => {
                let mut requested = false;
                let task = mutate(root, &task.id, |task| {
                    if eligible(task) {
                        task.interaction.cancel_requested = true;
                        task.interaction.resume_requested = true;
                        task.interaction.phase = "interrupting".into();
                        requested = true;
                    }
                    Ok(())
                })?;
                if requested {
                    self.release_deadline = Some(Instant::now() + Duration::from_secs(30));
                    connection.event("session.continuation_requested", serde_json::json!({
                        "sessionId": session, "reason": "Provider recorded a completed final answer; requesting turn release for queued messages",
                    }))?;
                }
                Ok(task)
            }
            Ok(false) => Ok(task),
            Err(error) => {
                let message = format!("Cannot verify provider completion for queued continuation: {error:#}");
                if self.monitor_error.as_ref() != Some(&message) {
                    eprintln!("{message}");
                    connection.event("session.continuation_monitor_error", serde_json::json!({ "message": message }))?;
                    self.monitor_error = Some(message);
                }
                Ok(task)
            }
        }
    }

    fn observe(&mut self, event: &Value) -> Result<()> {
        if event.get("agentId").is_some_and(|id| !id.is_null())
            || event["data"].get("agentId").is_some_and(|id| !id.is_null()) { return Ok(()); }
        let kind = event["type"].as_str().unwrap_or("");
        if !matches!(kind, "user.message" | "assistant.turn_start" | "assistant.message"
            | "assistant.turn_end" | "tool.execution_start") { return Ok(()); }
        let at = DateTime::parse_from_rfc3339(event["timestamp"].as_str().context("Missing completion timestamp")?)?;
        // Provider timestamps have millisecond precision; the cursor excludes existing history.
        if at.timestamp_millis() < self.since.timestamp_millis() { return Ok(()); }
        let data = &event["data"];
        match kind {
            "assistant.turn_start" => {
                self.turn = data["turnId"].as_str().map(str::to_owned);
                self.final_turn = None; self.complete = false;
            }
            "assistant.message" => {
                self.complete = false;
                self.final_turn = if data["phase"] == "final_answer"
                    && data["toolRequests"].as_array().is_some_and(|tools| tools.is_empty())
                    && self.turn.as_deref().is_some_and(|turn| data["turnId"] == turn) {
                    self.turn.clone()
                } else { None };
            }
            "assistant.turn_end" => {
                self.complete = self.final_turn.as_deref().is_some_and(|turn| data["turnId"] == turn);
                self.final_turn = None;
            }
            _ => { self.turn = None; self.final_turn = None; self.complete = false; }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "completion_tests.rs"]
mod tests;
