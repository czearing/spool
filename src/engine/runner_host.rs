use super::runner_retry::{permanent_exit, RetryBudget};
use anyhow::{Context, Result};
use std::fs::OpenOptions;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::{Duration, Instant};

#[derive(serde::Deserialize)]
struct Target {
    runtime: PathBuf,
    script: PathBuf,
    engine: PathBuf,
}

fn replacement(data: &Path, runtime: &Path, script: &Path) -> Option<Target> {
    let target: Target =
        serde_json::from_slice(&std::fs::read(data.join("runner-host-target.json")).ok()?).ok()?;
    ((target.runtime != runtime || target.script != script)
        && [&target.runtime, &target.script, &target.engine]
            .iter()
            .all(|path| path.is_absolute() && path.is_file()))
    .then_some(target)
}

fn handoff(target: Target, data: &Path, lease: std::fs::File) -> Result<()> {
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(data.join("runners.log"))?;
    let mut command = Command::new(target.engine);
    command
        .arg("runner-host")
        .arg("--runtime")
        .arg(target.runtime)
        .arg("--script")
        .arg(target.script)
        .arg("--data")
        .arg(data)
        .current_dir(data)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    drop(lease);
    command
        .spawn()
        .context("Cannot start updated runner host")?;
    Ok(())
}

pub async fn run(runtime: &Path, script: &Path, data: &Path) -> Result<()> {
    anyhow::ensure!(
        runtime.is_absolute() && script.is_absolute() && data.is_absolute(),
        "Runner host paths must be absolute"
    );
    std::fs::create_dir_all(data)?;
    let lease = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(data.join("runner-host.lock"))?;
    if let Err(error) = lease.try_lock() {
        if matches!(error, std::fs::TryLockError::WouldBlock) {
            return Ok(());
        }
        return Err(error.into());
    }
    let mut budget = RetryBudget::default();
    let (sender, mut controls) = tokio::sync::mpsc::unbounded_channel();
    // Tokio's blocking stdin task otherwise prevents runtime shutdown after a service drain.
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    let mut input_open = true;
    loop {
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(data.join("runners.log"))?;
        let mut command = Command::new(runtime);
        command
            .arg(script)
            .arg("--runner-service")
            .current_dir(data)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(log);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let started = Instant::now();
        let outcome = match command.spawn() {
            Ok(mut child) => {
                crate::queue::fs::write_json(
                    data.join("runner-host.json"),
                    &serde_json::json!({
                        "state": "starting", "pid": std::process::id(), "servicePid": child.id()
                    }),
                )?;
                let mut input = child
                    .stdin
                    .take()
                    .context("Runner service control pipe is unavailable")?;
                let mut updates = tokio::time::interval(Duration::from_secs(2));
                loop {
                    tokio::select! {
                        _ = updates.tick() => {
                            if let Some(target) = replacement(data, runtime, script) {
                                input.write_all(b"shutdown\n").await?;
                                let status = child.wait().await?;
                                anyhow::ensure!(status.success(), "Runner service could not drain for update: {status}");
                                return handoff(target, data, lease);
                            }
                        },
                        status = child.wait() => break status.map(|status| status.code()),
                        line = controls.recv(), if input_open => {
                            match line.transpose()? {
                                Some(line) if line.trim() == "stop" => {
                                    input.write_all(b"shutdown\n").await?;
                                    let status = child.wait().await?;
                                    anyhow::ensure!(status.success(), "Runner service could not drain: {status}");
                                    return Ok(());
                                },
                                None => input_open = false,
                                _ => {},
                            }
                        }
                    }
                }
            }
            Err(error) => Err(error),
        };
        let code = outcome.as_ref().ok().copied().flatten();
        if code == Some(0) {
            return Ok(());
        }
        let delay = if permanent_exit(code) {
            None
        } else {
            budget.next(started.elapsed() >= Duration::from_secs(300))
        };
        let status = serde_json::json!({ "state": if delay.is_some() { "recovering" } else { "blocked" },
            "error": format!("Runner service stopped: {outcome:?}"),
            "retryAfterMs": delay.map(|value| value.as_millis()) });
        crate::queue::fs::write_json(data.join("runner-host.json"), &status)?;
        let Some(delay) = delay else {
            return Ok(());
        };
        let deadline = Instant::now() + delay;
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(2)) => {
                    if let Some(target) = replacement(data, runtime, script) {
                        return handoff(target, data, lease);
                    }
                },
                _ = tokio::time::sleep_until(deadline) => break,
                line = controls.recv(), if input_open => {
                    match line.transpose()? {
                        Some(line) if line.trim() == "stop" => return Ok(()),
                        None => input_open = false,
                        _ => {},
                    }
                }
            }
        }
    }
}
