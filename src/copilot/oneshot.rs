use super::*;
use crate::copilot::parser::{format_stream_event, parse_usage_delta};
use crate::queue::fs::{locate_task, write_task, TaskGuard};

pub(super) async fn stop(child: &mut tokio::process::Child) -> Result<()> {
    if child.try_wait()?.is_some() { return Ok(()); }
    let pid = child.id().context("Task process has no identity")?;
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("taskkill.exe");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]).creation_flags(0x08000000);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new("kill");
        command.args(["-KILL", "--", &format!("-{pid}")]);
        command
    };
    let outcome = command.kill_on_drop(true).output().await?;
    anyhow::ensure!(outcome.status.success() || child.try_wait()?.is_some(),
        "Cannot stop task process {pid}: {}", String::from_utf8_lossy(&outcome.stderr));
    child.wait().await?;
    Ok(())
}

pub(super) async fn execute(
    runner: &CopilotRunner, task: &Task, agent: &AgentConfig,
    mcp_binary: Option<&Path>, log_tx: Option<tokio::sync::mpsc::Sender<String>>,
) -> Result<CopilotExecutionResult> {
    fs::create_dir_all(&runner.logs_dir)?;
    let root = runner.logs_dir.parent().context("Missing Spool root")?;
    let queues = root.join("queues");
    let prompt = work_item_prompt(task, agent);
    let resumed = task.session_id.is_some();
    let task = {
        let _guard = TaskGuard::acquire(&queues, &task.id)?;
        let (file, mut current) = locate_task(&queues, &task.id)?;
        anyhow::ensure!(current.session_id == task.session_id, "Task session changed before launch");
        if current.session_id.is_none() {
            current.session_id = Some(uuid::Uuid::new_v4().to_string());
            current.model.get_or_insert_with(|| agent.model.clone());
            write_task(file, &current)?;
        }
        current
    };
    let task = &task;
    let session_id = task.session_id.clone().context("Task session must be persisted before launch")?;
    let usage_path = runner.logs_dir.join(format!("{}.usage.json", task.id));
    let previous_usage = if usage_path.exists() {
        let previous = fs::read_to_string(&usage_path)?;
        let archive = usage_path.with_extension(format!("{}.json", uuid::Uuid::new_v4()));
        fs::rename(&usage_path, archive)?;
        Some(previous)
    } else { None };
    let mut log = OpenOptions::new().create(true).append(true)
        .open(runner.logs_dir.join(format!("{}.log", task.id)))?;
    let mut command = runner.command()?;
    command.env("BOHEMIA_CREATOR_CONTEXT", runner.creator_context(task, &session_id)?)
        .env("COPILOT_SESSION_ID", &session_id).env("COPILOT_ALLOW_ALL", "true")
        .args([if resumed { "--resume" } else { "--session-id" }, &session_id, "--allow-all", "--output-format", "json",
            "--usage-output-file"]).arg(&usage_path).args(["--model",
                task.session_config.as_ref().map(|config| config.model.as_str()).or(task.model.as_deref()).unwrap_or(&agent.model)])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(workspace) = &task.workspace {
        anyhow::ensure!(Path::new(workspace).is_absolute() && Path::new(workspace).is_dir(), "Task workspace is unavailable");
        command.current_dir(workspace).arg("-C").arg(workspace);
    }
    if let Some(effort) = &agent.reasoning_effort { command.args(["--reasoning-effort", effort]); }
    runner.configure_task_mcp(&mut command, task, agent, mcp_binary)?;
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().context("Failed to spawn copilot CLI process")?;
    let stderr = child.stderr.take().context("Missing stderr")?;
    let mut error_log = tokio::fs::File::from_std(log.try_clone()?);
    let errors = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Some(line) = lines.next_line().await? {
            error_log.write_all(format!("stderr: {line}\n").as_bytes()).await?;
        }
        Ok::<_, std::io::Error>(())
    });
    let mut input = child.stdin.take().context("Missing prompt input")?;
    input.write_all(prompt.as_bytes()).await.context("Cannot deliver the complete work item")?;
    input.shutdown().await?;
    drop(input);
    let mut lines = BufReader::new(child.stdout.take().context("Missing stdout")?).lines();
    let mut stdout_open = true;
    let mut reported_session = None;
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(250));
    writeln!(log, "=== TASK START {} (Session: {}) ===", task.id, session_id)?;
    loop {
        tokio::select! {
            line = lines.next_line(), if stdout_open => {
                let Some(line) = line? else { stdout_open = false; continue; };
                if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
                    if event["type"] == "result" {
                        reported_session = event["sessionId"].as_str().map(str::to_owned);
                    }
                }
                writeln!(log, "{line}")?;
                log.flush()?;
                if let (Some(formatted), Some(tx)) = (format_stream_event(&line), &log_tx) {
                    let _ = tx.send(formatted).await;
                }
            }
            _ = interval.tick() => {
                if child.try_wait()?.is_some() {
                    if !stdout_open { break; }
                    continue;
                }
                let requested = {
                    let _guard = TaskGuard::acquire(&queues, &task.id)?;
                    locate_task(&queues, &task.id)?.1.interaction.status_change.is_some()
                };
                if requested {
                    if let Err(error) = stop(&mut child).await {
                        writeln!(log, "Operator stop failed: {error:#}; retaining ownership until process exits")?;
                        child.wait().await?;
                        errors.await??;
                        return Err(error);
                    }
                    break;
                }
            }
        }
    }
    let status = child.wait().await?;
    errors.await??;
    writeln!(log, "=== TASK END {} (Exit Code: {}) ===", task.id, status.code().unwrap_or(-1))?;
    if status.success() {
        anyhow::ensure!(reported_session.as_deref() == Some(session_id.as_str()),
            "Provider did not confirm the assigned session {session_id}; refusing an unverified continuation");
    }
    let usage = if usage_path.exists() { parse_usage_delta(&fs::read_to_string(usage_path)?, previous_usage.as_deref())? }
        else { CopilotUsageStats::default() };
    Ok(CopilotExecutionResult { exit_code: status.code().unwrap_or(-1), session_id, usage })
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn operator_stop_terminates_owned_descendants_but_not_an_unrelated_process() -> Result<()> {
        let root = std::env::temp_dir().join(format!("spool-stop-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root)?;
        let pid_file = root.join("child.pid");
        let script = format!("$p=Start-Process pwsh -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep 120' -PassThru -WindowStyle Hidden; Set-Content -LiteralPath '{}' -Value $p.Id; Start-Sleep 120", pid_file.display());
        let mut owned = Command::new("pwsh").args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(0x08000000).spawn()?;
        let mut unrelated = Command::new("pwsh").args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep 120"])
            .creation_flags(0x08000000).spawn()?;
        let result = async {
            let descendant = tokio::time::timeout(std::time::Duration::from_secs(20), async {
                loop {
                    if pid_file.exists() {
                        if let Ok(pid) = fs::read_to_string(&pid_file)?.trim().parse::<u32>() {
                            return Ok::<_, anyhow::Error>(pid);
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }).await??;
            stop(&mut owned).await?;
            assert!(owned.try_wait()?.is_some());
            assert!(unrelated.try_wait()?.is_none());
            let check = Command::new("pwsh").args(["-NoProfile", "-NonInteractive", "-Command",
                &format!("if (Get-Process -Id {descendant} -ErrorAction SilentlyContinue) {{ exit 1 }}")])
                .creation_flags(0x08000000).status().await?;
            assert!(check.success(), "Task descendant survived operator stop");
            Ok::<_, anyhow::Error>(())
        }.await;
        stop(&mut owned).await?;
        stop(&mut unrelated).await?;
        fs::remove_dir_all(root)?;
        result
    }
}
