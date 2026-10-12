use super::*;

pub(super) async fn run_session(
    connection: &mut Connection, runner: &CopilotRunner, root: &Path, cwd: &Path, initial: &Task,
    agent: &AgentConfig, config: &mut SessionConfig, log_tx: Option<tokio::sync::mpsc::Sender<String>>,
) -> Result<CopilotExecutionResult> {
    let accounting_start = chrono::Utc::now();
    let capabilities = connection.call("initialize", json!({
        "protocolVersion": 1, "clientCapabilities": {}, "clientInfo": { "name": "spool", "version": "0.1.0" },
    }), false).await?;
    let session = if let Some(id) = &initial.session_id {
        anyhow::ensure!(capabilities["agentCapabilities"]["loadSession"] == true, "Provider does not support session restoration");
        connection.call("session/load", json!({ "sessionId": id, "cwd": cwd, "mcpServers": [] }), true).await?
    } else {
        connection.call("session/new", json!({ "cwd": cwd, "mcpServers": [] }), false).await?
    };
    let session_id = initial.session_id.clone().or_else(|| session["sessionId"].as_str().map(str::to_owned))
        .context("Provider did not return a session identity")?;
    anyhow::ensure!(session["sessionId"].as_str().is_none_or(|id| id == session_id),
        "Provider restored a different session; continuation refused");
    if initial.session_id.is_some() {
        config.restored(&session, initial.session_config.is_some())?;
    } else if session["models"]["currentModelId"].as_str() != Some(config.model.as_str()) {
        connection.call("session/set_config_option", json!({
            "sessionId": session_id, "configId": "model", "value": config.model,
        }), false).await?;
    } else {
        config.restored(&session, false)?;
    }
    let task = mutate(root, &initial.id, |task| {
        task.session_id = Some(session_id.clone()); task.session_config = Some(config.clone()); Ok(())
    })?;
    runner.creator_context(&task, &session_id)?;
    connection.event("session.start", json!({ "sessionId": session_id, "taskId": initial.id }))?;
    if let Some(tx) = &log_tx { tx.send(format!("[{}] Interactive session {session_id}", agent.name)).await?; }
    let initial_prompt = work_item_prompt(initial, agent);
    let mut first = initial.session_id.is_none();
    anyhow::ensure!(first || initial.interaction.messages.iter().any(|message| message.status == "queued"),
        "Restored session has no pending message; original assignment will not be replayed");
    let mut usage = CopilotUsageStats::default();
    let mut exit_code = 0;
    loop {
        let task = {
            let _guard = TaskGuard::acquire(&root.join("queues"), &initial.id)?;
            locate_task(&root.join("queues"), &initial.id)?.1
        };
        if task.agent != agent.name || task.interaction.handoff.is_some() || task.interaction.status_change.is_some() { break; }
        if task.interaction.paused {
            if task.interaction.phase != "paused" || task.interaction.cancel_requested {
                mutate(root, &initial.id, |task| {
                    task.status = crate::models::TaskStatus::InProgress;
                    if task.interaction.cancel_requested {
                        task.interaction.paused = !task.interaction.resume_requested;
                        task.interaction.cancel_requested = false;
                        task.interaction.resume_requested = false;
                    }
                    task.interaction.phase = if task.interaction.paused { "paused" } else { "queued" }.into();
                    Ok(())
                })?;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }
        let messages: Vec<_> = task.interaction.messages.iter().filter(|message| message.status == "queued").cloned().collect();
        if !first && messages.is_empty() { break; }
        let mut prompt = Vec::new();
        if first {
            prompt.push(json!({ "type": "text", "text": initial_prompt }));
            connection.event("user.message", json!({ "content": initial_prompt }))?;
            first = false;
        }
        for message in &messages {
            prompt.push(json!({ "type": "text", "text": message.text }));
            connection.event("user.message", json!({ "content": message.text, "messageId": message.id }))?;
        }
        let ids: Vec<_> = messages.iter().map(|message| message.id.clone()).collect();
        mutate(root, &initial.id, |task| {
            task.status = crate::models::TaskStatus::InProgress;
            task.interaction.phase = "running".into();
            for message in &mut task.interaction.messages {
                if ids.contains(&message.id) { message.status = "delivering".into(); message.session_id = Some(session_id.clone()); }
            }
            Ok(())
        })?;
        let request_id = connection.request("session/prompt", json!({ "sessionId": session_id, "prompt": prompt })).await?;
        usage.turns += 1;
        let mut clock = interval(Duration::from_millis(100));
        let mut cancelled = false;
        let mut acknowledged = false;
        let stop = loop {
            tokio::select! {
                line = connection.output.next_line() => {
                    let value: Value = serde_json::from_str(&line?.context("Provider closed during a turn")?)?;
                    if value["id"].as_u64() == Some(request_id) {
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
                    connection.incoming(&value, false).await?;
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
                _ = clock.tick() => {
                    let task = {
                        let _guard = TaskGuard::acquire(&root.join("queues"), &initial.id)?;
                        locate_task(&root.join("queues"), &initial.id)?.1
                    };
                    if (task.interaction.cancel_requested || task.interaction.status_change.is_some()) && !cancelled {
                        connection.send(json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": session_id } })).await?;
                        cancelled = true;
                    }
                }
            }
        };
        connection.event("session.turn_end", json!({ "stopReason": stop, "sessionId": session_id }))?;
        if let Err(error) = crate::usage::capture(root, initial, &session_id, accounting_start) {
            connection.event("usage.error", json!({ "message": format!("Cannot persist provider usage: {error:#}") }))?;
        }
        mutate(root, &initial.id, |task| {
            for message in &mut task.interaction.messages {
                if ids.contains(&message.id) && message.status == "delivering" {
                    message.status = if stop == "end_turn" { "delivered" } else { "delivery_uncertain" }.into();
                }
            }
            if task.interaction.status_change.is_none() && (stop == "cancelled" || task.interaction.cancel_requested) {
                task.status = crate::models::TaskStatus::InProgress;
                task.interaction.paused = !task.interaction.resume_requested;
                task.interaction.cancel_requested = false;
                task.interaction.resume_requested = false;
                task.interaction.phase = if task.interaction.paused { "paused" } else { "queued" }.into();
            }
            Ok(())
        })?;
        if !matches!(stop.as_str(), "end_turn" | "cancelled") {
            connection.event("session.error", json!({ "message": format!("Provider stopped with {stop}") }))?;
            exit_code = 1;
            break;
        }
    }
    connection.event("session.end", json!({ "sessionId": session_id, "exitCode": exit_code }))?;
    Ok(CopilotExecutionResult { session_id, exit_code, usage })
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
