use super::*;

pub(super) async fn run_session(
    connection: &mut Connection,
    runner: &CopilotRunner,
    root: &Path,
    cwd: &Path,
    initial: &Task,
    agent: &AgentConfig,
    config: &mut SessionConfig,
    log_tx: Option<tokio::sync::mpsc::Sender<String>>,
) -> Result<CopilotExecutionResult> {
    let (change_tx, mut task_changes) = tokio::sync::mpsc::channel(1);
    let _task_watcher = crate::queue::watcher::QueueWatcher::start_task(
        root.join("queues"),
        &initial.id,
        change_tx,
    )
    .map_err(|error| {
        eprintln!(
            "Task watcher failed for {}: {error:#}; periodic polling remains enabled",
            initial.id
        );
        error
    })
    .ok();
    let accounting_start = chrono::Utc::now();
    let provider_cwd = config
        .provider
        .as_ref()
        .map(|provider| provider.working_directory.clone());
    let cwd = provider_cwd.as_deref().map(Path::new).unwrap_or(cwd);
    // Remote initialization includes Codespace wake-up, authentication and MCP gateway startup.
    let startup_deadline = Duration::from_secs(if config.provider.is_some() { 900 } else { 120 });
    let capabilities = connection.call_with_timeout("initialize", json!({
        "protocolVersion": 1, "clientCapabilities": {}, "clientInfo": { "name": "spool", "version": "0.1.0" },
    }), false, startup_deadline).await?;
    let session = if let Some(id) = &initial.session_id {
        anyhow::ensure!(
            capabilities["agentCapabilities"]["loadSession"] == true,
            "Provider does not support session restoration"
        );
        connection
            .call(
                "session/load",
                json!({ "sessionId": id, "cwd": cwd, "mcpServers": [] }),
                true,
            )
            .await?
    } else {
        connection
            .call(
                "session/new",
                json!({ "cwd": cwd, "mcpServers": [] }),
                false,
            )
            .await?
    };
    let session_id = initial
        .session_id
        .clone()
        .or_else(|| session["sessionId"].as_str().map(str::to_owned))
        .context("Provider did not return a session identity")?;
    anyhow::ensure!(
        session["sessionId"]
            .as_str()
            .is_none_or(|id| id == session_id),
        "Provider restored a different session; continuation refused"
    );
    if initial.session_id.is_some() {
        config.restored(&session, initial.session_config.is_some())?;
    } else if session["models"]["currentModelId"].as_str() != Some(config.model.as_str()) {
        connection
            .call(
                "session/set_config_option",
                json!({
                    "sessionId": session_id, "configId": "model", "value": config.model,
                }),
                false,
            )
            .await?;
    } else {
        config.restored(&session, false)?;
    }
    let task = mutate(root, &initial.id, |task| {
        task.session_id = Some(session_id.clone());
        task.session_config = Some(config.clone());
        Ok(())
    })?;
    runner.execution_context(&task, &session_id)?;
    connection.event(
        "session.start",
        json!({ "sessionId": session_id, "taskId": initial.id }),
    )?;
    if let Some(tx) = &log_tx {
        tx.send(format!("[{}] Interactive session {session_id}", agent.name))
            .await?;
    }
    let initial_prompt = if config.autopilot {
        initial.prompt.clone()
    } else {
        work_item_prompt(initial, agent)
    };
    let mut first = initial.session_id.is_none();
    anyhow::ensure!(
        first
            || initial
                .interaction
                .messages
                .iter()
                .any(|message| message.status == "queued"),
        "Restored session has no pending message; original assignment will not be replayed"
    );
    let mut usage = CopilotUsageStats::default();
    let mut exit_code = 0;
    let retention = super::idle::retention(root, config)?;
    let mut idle_since = None;
    let mut autopilot_active = session["modes"]["currentModeId"]
        .as_str()
        .is_some_and(|mode| mode.ends_with("#autopilot"));
    loop {
        let task = {
            let _guard = TaskGuard::acquire(&root.join("queues"), &initial.id)?;
            locate_task(&root.join("queues"), &initial.id)?.1
        };
        if task.agent != agent.name
            || task.interaction.handoff.is_some()
            || task.interaction.status_change.is_some()
        {
            break;
        }
        if idle_since.is_some() && (task.interaction.paused || task.interaction.cancel_requested) {
            break;
        }
        if task.interaction.paused {
            if task.interaction.phase != "paused" || task.interaction.cancel_requested {
                mutate(root, &initial.id, |task| {
                    task.status = crate::models::TaskStatus::InProgress;
                    if task.interaction.cancel_requested {
                        task.interaction.paused = !task.interaction.resume_requested;
                        task.interaction.cancel_requested = false;
                        task.interaction.resume_requested = false;
                    }
                    task.interaction.phase = if task.interaction.paused {
                        "paused"
                    } else {
                        "queued"
                    }
                    .into();
                    Ok(())
                })?;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                Some(_) = task_changes.recv() => {}
            }
            continue;
        }
        let messages: Vec<_> = task
            .interaction
            .messages
            .iter()
            .filter(|message| message.status == "queued")
            .cloned()
            .collect();
        if !first && messages.is_empty() {
            let Some(policy) = &retention else {
                break;
            };
            match super::idle::should_yield(root, &task, policy) {
                Ok(false) => {}
                outcome => {
                    if let Err(error) = outcome {
                        connection.event(
                            "session.idle_unavailable",
                            json!({ "message": error.to_string() }),
                        )?;
                    }
                    break;
                }
            }
            if let Some(since) = idle_since {
                if policy.duration.is_some_and(|duration| {
                    tokio::time::Instant::now().duration_since(since) >= duration
                }) {
                    break;
                }
            } else {
                if !super::idle::mark_idle(root, &initial.id)? {
                    break;
                }
                idle_since = Some(tokio::time::Instant::now());
                connection.event("session.idle", json!({ "sessionId": session_id }))?;
            }
            tokio::select! {
                line = connection.output.next_line() => {
                    let Ok(Some(line)) = line else { break; };
                    let Ok(value) = serde_json::from_str::<Value>(&line) else { break; };
                    if value["method"] == "session/request_permission" {
                        connection.send(json!({ "jsonrpc": "2.0", "id": value["id"],
                            "result": { "outcome": { "outcome": "cancelled" } } })).await?;
                        break;
                    }
                    connection.incoming(&value, false).await?;
                }
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                Some(_) = task_changes.recv() => {}
            }
            continue;
        }
        idle_since = None;
        let mut prompt = Vec::new();
        if first {
            if !config.autopilot || !initial.deferred_session || messages.is_empty() {
                prompt.push(json!({ "type": "text", "text": initial_prompt }));
                connection.event("user.message", json!({ "content": initial_prompt }))?;
            }
            first = false;
        }
        for message in &messages {
            prompt.push(json!({ "type": "text", "text": message.text }));
            connection.event(
                "user.message",
                json!({ "content": message.text, "messageId": message.id }),
            )?;
        }
        if config.autopilot {
            prompt = autopilot::prompt(&prompt)?;
        }
        let ids: Vec<_> = messages.iter().map(|message| message.id.clone()).collect();
        mutate(root, &initial.id, |task| {
            task.status = crate::models::TaskStatus::InProgress;
            if task.interaction.chat_return.is_some() {
                task.error = None;
            }
            task.interaction.phase = "running".into();
            for message in &mut task.interaction.messages {
                if ids.contains(&message.id) {
                    message.status = "delivering".into();
                    message.session_id = Some(session_id.clone());
                }
            }
            Ok(())
        })?;
        let history = if config.provider.is_none() {
            Some(
                crate::usage::session_root()?
                    .join(&session_id)
                    .join("events.jsonl"),
            )
        } else {
            None
        };
        let mut completion_watch =
            super::completion::CompletionWatch::new(history, chrono::Utc::now())?;
        let request_id = connection
            .request(
                "session/prompt",
                json!({ "sessionId": session_id, "prompt": prompt }),
            )
            .await?;
        usage.turns += 1;
        let mut clock = interval(Duration::from_millis(100));
        let mut cancelled = false;
        let mut interrupted_for_message = false;
        let mut acknowledged = false;
        let mut autopilot_response = String::new();
        let mut completion_calls = std::collections::HashMap::<String, String>::new();
        let mut completion = None;
        let stop = loop {
            tokio::select! {
                line = connection.output.next_line() => {
                    let value: Value = serde_json::from_str(&line?.context("Provider closed during a turn")?)?;
                    if value.get("method").is_none() && value["id"].as_u64() == Some(request_id) {
                        if value.get("error").is_some() {
                            mutate(root, &initial.id, |task| {
                                for message in &mut task.interaction.messages {
                                    if ids.contains(&message.id) && message.status == "delivering" {
                                        message.status = "failed".into(); message.error = Some(value["error"].to_string());
                                    }
                                }
                                Ok(())
                            })?;
                            anyhow::bail!("Provider rejected the turn: {}", value["error"]);
                        }
                        if config.autopilot && autopilot_response.contains("Failed to run /autopilot:") {
                            anyhow::bail!("Provider rejected the Autopilot objective: {}", autopilot_response.trim());
                        }
                        anyhow::ensure!(!config.autopilot || autopilot_active || value["result"]["stopReason"] == "cancelled",
                            "Provider did not activate the Autopilot objective");
                        if let Some(tokens) = value["result"].get("usage").filter(|value| value.is_object()) {
                            connection.event("session.usage", json!({ "sessionId": session_id, "usage": tokens }))?;
                            let tokens = crate::copilot::parser::parse_usage_json(&tokens.to_string());
                            usage.input_tokens += tokens.input_tokens;
                            usage.output_tokens += tokens.output_tokens;
                            usage.cache_read_tokens += tokens.cache_read_tokens;
                            usage.cache_write_tokens += tokens.cache_write_tokens;
                        } else {
                            mutate(root, &initial.id, |task| { task.interaction.usage_unavailable = true; Ok(()) })?;
                        }
                        break value["result"]["stopReason"].as_str().unwrap_or("unknown").to_owned();
                    }
                    if value["method"] == "session/update" && value["params"]["update"]["sessionUpdate"] == "current_mode_update" {
                        autopilot_active = value["params"]["update"]["currentModeId"].as_str().is_some_and(|mode| mode.ends_with("#autopilot"));
                    }
                    if config.autopilot && value["method"] == "session/update" &&
                        value["params"]["update"]["sessionUpdate"] == "agent_message_chunk" {
                        if let Some(text) = value["params"]["update"]["content"]["text"].as_str() {
                            autopilot_response.push_str(text);
                        }
                    }
                    if value["method"] == "session/update" && value["params"]["sessionId"] == session_id {
                        let update = &value["params"]["update"];
                        if let Some(id) = update["toolCallId"].as_str() {
                            if update["sessionUpdate"] == "tool_call" && update["title"] == "task_complete" {
                                if let Some(summary) = update["rawInput"]["summary"].as_str().filter(|s| !s.trim().is_empty()) {
                                    completion_calls.insert(id.to_owned(), summary.to_owned());
                                }
                            } else if update["sessionUpdate"] == "tool_call_update" &&
                                matches!(update["status"].as_str(), Some("completed" | "failed")) {
                                if let Some(summary) = completion_calls.remove(id) {
                                    if update["status"] == "completed" && update["rawOutput"]["isError"] != true {
                                        completion = Some(summary);
                                    }
                                }
                            }
                        }
                    }
                    if cancelled && value["method"] == "session/request_permission" {
                        connection.send(json!({ "jsonrpc": "2.0", "id": value["id"],
                            "result": { "outcome": { "outcome": "cancelled" } } })).await?;
                    } else {
                        connection.incoming(&value, false).await?;
                    }
                    if !acknowledged && value["method"] == "session/update" &&
                        matches!(value["params"]["update"]["sessionUpdate"].as_str(),
                            Some("agent_message_chunk" | "tool_call" | "user_message_chunk")) {
                        mutate(root, &initial.id, |task| {
                            for message in &mut task.interaction.messages {
                                if ids.contains(&message.id) { message.status = "delivered".into(); }
                            }
                            Ok(())
                        })?;
                        acknowledged = true;
                    }
                }
                _ = async {
                    tokio::select! {
                        _ = clock.tick() => {}
                        Some(_) = task_changes.recv() => {}
                    }
                } => {
                    let task = {
                        let _guard = TaskGuard::acquire(&root.join("queues"), &initial.id)?;
                        locate_task(&root.join("queues"), &initial.id)?.1
                    };
                    let task = completion_watch.release(root, task, connection, &session_id)?;
                    if (task.interaction.cancel_requested || task.interaction.status_change.is_some()) && !cancelled {
                        let pending_message = task.interaction.messages.iter().any(|message| message.status == "queued");
                        connection.send(json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": session_id } })).await?;
                        cancelled = true;
                        interrupted_for_message = pending_message && !task.interaction.paused;
                        if interrupted_for_message {
                            mutate(root, &initial.id, |task| {
                                if task.interaction.status_change.is_none() {
                                    task.interaction.phase = "interrupting".into();
                                }
                                Ok(())
                            })?;
                        }
                    }
                }
            }
        };
        connection.event(
            "session.turn_end",
            json!({ "stopReason": stop, "sessionId": session_id }),
        )?;
        if config.provider.is_none() {
            if let Err(error) = crate::usage::capture(root, initial, &session_id, accounting_start)
            {
                connection.event(
                    "usage.error",
                    json!({ "message": format!("Cannot persist provider usage: {error:#}") }),
                )?;
            }
        }
        mutate(root, &initial.id, |task| {
            let interrupted = cancelled || stop != "end_turn" || task.interaction.cancel_requested;
            for message in &mut task.interaction.messages {
                if ids.contains(&message.id) && message.status == "delivering" {
                    message.status = if stop == "end_turn" {
                        "delivered"
                    } else {
                        "delivery_uncertain"
                    }
                    .into();
                }
            }
            if task.interaction.status_change.is_none()
                && (stop == "cancelled" || task.interaction.cancel_requested)
            {
                task.status = crate::models::TaskStatus::InProgress;
                let resume_for_message = interrupted_for_message && !task.interaction.paused;
                task.interaction.paused =
                    !(task.interaction.resume_requested || resume_for_message);
                task.interaction.cancel_requested = false;
                task.interaction.resume_requested = false;
                task.interaction.phase = if task.interaction.paused {
                    "paused"
                } else {
                    "queued"
                }
                .into();
            }
            if let Some(summary) = completion.as_deref().filter(|_| !interrupted) {
                if task.status == crate::models::TaskStatus::InProgress
                    && task.error.is_none()
                    && task.agent == agent.name
                    && task.session_id.as_deref() == Some(session_id.as_str())
                    && task.provider.as_ref().map(|lease| &lease.token)
                        == initial.provider.as_ref().map(|lease| &lease.token)
                    && !task.interaction.paused
                    && task.interaction.status_change.is_none()
                    && task.interaction.handoff.is_none()
                    && task.interaction.chat_return.is_none()
                    && !task
                        .interaction
                        .messages
                        .iter()
                        .any(|message| message.status == "queued")
                {
                    crate::engine::task_result::update(
                        root,
                        task,
                        &agent.name,
                        crate::models::TaskStatus::Completed,
                        Some(summary),
                        None,
                    )?;
                }
            }
            Ok(())
        })?;
        if !matches!(stop.as_str(), "end_turn" | "cancelled") {
            connection.event(
                "session.error",
                json!({ "message": format!("Provider stopped with {stop}") }),
            )?;
            exit_code = 1;
            break;
        }
    }
    connection.event(
        "session.end",
        json!({ "sessionId": session_id, "exitCode": exit_code }),
    )?;
    Ok(CopilotExecutionResult {
        session_id,
        exit_code,
        usage,
    })
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
