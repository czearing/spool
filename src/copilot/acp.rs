use super::*;
use serde_json::{json, Value};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::time::{interval, timeout, Duration};
use crate::models::task::ProviderLease;
use crate::copilot::session::{SessionConfig, task_mcp};
use crate::queue::fs::{locate_task, save_task_state, TaskGuard};

fn mutate(root: &Path, id: &str, update: impl FnOnce(&mut Task) -> Result<()>) -> Result<Task> {
    let queues = root.join("queues");
    let _guard = TaskGuard::acquire(&queues, id)?;
    let (file, mut task) = locate_task(&queues, id)?;
    update(&mut task)?;
    task.updated_at = chrono::Utc::now();
    save_task_state(&queues, &file, &task)?;
    Ok(task)
}

#[path = "acp/connection.rs"]
mod connection;
#[path = "acp/session.rs"]
mod session;
#[path = "acp/shutdown.rs"]
mod shutdown;
use connection::Connection;
use session::run_session;

fn provider_command(runner: &CopilotRunner, task: &Task, config: &SessionConfig, cwd: &Path, launch_log: &Path) -> Result<Command> {
    let mut command = runner.command()?;
    command.args(["--acp", "--stdio", "--allow-all"])
        .arg("--log-dir").arg(launch_log).env("COPILOT_ALLOW_ALL", "true")
        .current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    command.env("SPOOL_PROVIDER_TOKEN", &task.provider.as_ref().context("Missing provider lease")?.token)
        .env("BOHEMIA_CREATOR_CONTEXT", runner.logs_dir.parent().context("Missing Spool root")?
            .join(".runner-receipts").join("creator-contexts").join(format!("{}.json", task.id)));
    if let Some(session) = &task.session_id {
        command.env("COPILOT_SESSION_ID", session)
            .env("BOHEMIA_CREATOR_CONTEXT", runner.creator_context(task, session)?);
    } else {
        command.env_remove("COPILOT_SESSION_ID");
    }
    if task.session_id.is_none() || task.session_config.is_some() {
        command.arg("--model").arg(&config.model);
        if let Some(effort) = &config.reasoning_effort { command.arg("--reasoning-effort").arg(effort); }
    }
    if let Some(mcp) = &config.mcp { command.arg("--additional-mcp-config").arg(mcp.to_string()); }
    Ok(command)
}

pub(super) async fn execute(
    runner: &CopilotRunner, initial: &Task, agent: &AgentConfig, mcp_binary: Option<&Path>,
    log_tx: Option<tokio::sync::mpsc::Sender<String>>,
) -> Result<CopilotExecutionResult> {
    let root = runner.logs_dir.parent().context("Spool root is unavailable")?;
    fs::create_dir_all(&runner.logs_dir)?;
    let token = format!("spool-provider-{}", uuid::Uuid::new_v4());
    let launch_log = runner.logs_dir.join("providers").join(&token);
    fs::create_dir_all(&launch_log)?;
    let cwd = initial.workspace.as_deref().map(Path::new).unwrap_or(root);
    anyhow::ensure!(cwd.is_absolute() && cwd.is_dir(), "Task workspace is unavailable");
    let mut config = if let Some(config) = &initial.session_config {
        config.validate(cwd, initial)?;
        config.clone()
    } else { SessionConfig::capture(cwd, initial, agent, task_mcp(root, initial, &agent.name, mcp_binary))? };
    if let (Some(binary), Some(server)) = (mcp_binary, config.mcp.as_mut()
        .and_then(|mcp| mcp.get_mut("mcpServers")).and_then(|servers| servers.get_mut("spool"))) {
        server.as_object_mut().context("Invalid saved Spool MCP configuration")?
            .insert("command".into(), json!(binary));
    }
    let context_dir = root.join(".runner-receipts").join("creator-contexts");
    fs::create_dir_all(&context_dir)?;
    let initial = mutate(root, &initial.id, |task| {
        task.provider = Some(ProviderLease { token: token.clone(), pid: None });
        task.interaction.phase = "starting".into();
        Ok(())
    })?;
    let log = OpenOptions::new().append(true).create(true).open(runner.logs_dir.join(format!("{}.log", initial.id)))?;
    let initial = &initial;
    let mut command = provider_command(runner, initial, &config, cwd, &launch_log)?;
    #[cfg(unix)]
    command.process_group(0);
    let mut stderr_log = tokio::fs::File::from_std(log.try_clone()?);
    let mut child = command.spawn().context("Failed to start interactive Copilot")?;
    let mut stderr_task = child.stderr.take().map(|stderr| tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Some(line) = lines.next_line().await? {
            stderr_log.write_all(format!("stderr: {line}\n").as_bytes()).await?;
        }
        Ok::<(), std::io::Error>(())
    }));
    let mut input = child.stdin.take();
    let result = async {
        mutate(root, &initial.id, |task| {
            task.provider.as_mut().context("Missing provider lease")?.pid = child.id();
            Ok(())
        })?;
        anyhow::ensure!(stderr_task.is_some(), "Missing Copilot stderr");
        let mut connection = Connection {
            input: input.take().context("Missing Copilot input")?,
            output: BufReader::new(child.stdout.take().context("Missing Copilot output")?).lines(),
            log, next_id: 0,
        };
        let result = run_session(&mut connection, runner, root, cwd, initial, agent, &mut config, log_tx).await;
        input = Some(connection.input);
        result
    }.await;
    // Only a finished session reaches teardown; active turns and operator interrupts have no deadline.
    drop(input);
    let record = |phase: &str, error: Option<String>| {
        if let Some(error) = &error { eprintln!("Task {}: {error}", initial.id); }
        if let Err(error) = mutate(root, &initial.id, |task| {
            if phase == "cleanup_blocked" {
                if task.interaction.phase != phase {
                    task.add_comment("spool:supervisor", error.as_deref().unwrap_or("Provider cleanup is unconfirmed"));
                }
            } else if error.is_some() { task.error = error; }
            task.interaction.phase = phase.into();
            Ok(())
        }) { eprintln!("Cannot record provider teardown for {}: {error:#}", initial.id); }
    };
    let original = result.as_ref().err().map(|error| format!("{error:#}"));
    record("stopping", original.clone());
    loop {
        let cleanup = shutdown::finish(&mut child, &mut stderr_task, Duration::from_secs(30)).await;
        if let Err(error) = &cleanup {
            if error.is::<shutdown::CleanupUncertain>() {
                record("cleanup_blocked", Some(format!("{}Provider cleanup unconfirmed: {error:#}",
                    original.as_ref().map(|message| format!("{message}; ")).unwrap_or_default())));
                tokio::time::sleep(Duration::from_secs(30)).await;
                continue;
            }
        }
        return shutdown::outcome(result, cleanup);
    }
}
