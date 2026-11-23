use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{create_dir_all, OpenOptions};
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::mpsc;
use tokio::time::{Duration, Instant};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Worker {
    id: String,
    key: String,
    executable: String,
    entry: String,
    cwd: String,
    env: HashMap<String, String>,
    #[serde(default)]
    wake: HashSet<String>,
}

impl Worker {
    fn validate(&self) -> Result<()> {
        crate::queue::fs::validate_id(&self.id)?;
        anyhow::ensure!(!self.key.is_empty(), "Runner execution key is missing");
        anyhow::ensure!(!self.executable.is_empty(), "Runner executable is missing");
        for (name, value) in [("entry", &self.entry), ("cwd", &self.cwd)] {
            anyhow::ensure!(
                Path::new(value).is_absolute(),
                "Runner {name} must be absolute"
            );
        }
        anyhow::ensure!(
            Path::new(&self.entry).is_file(),
            "Runner entry is unavailable"
        );
        anyhow::ensure!(
            Path::new(&self.cwd).is_dir(),
            "Runner working directory is unavailable"
        );
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Control {
    Reconcile { request: u64, workers: Vec<Worker> },
    Stop,
}

enum Event {
    Input(Result<Control>),
    Exited {
        id: String,
        generation: u64,
        error: Option<String>,
        code: Option<i32>,
    },
}

struct Running {
    key: String,
    generation: u64,
    pid: u32,
    input: Option<ChildStdin>,
    draining: bool,
    notified: HashSet<String>,
    started: Instant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status<'a> {
    id: &'a str,
    key: &'a str,
    pid: u32,
    draining: bool,
}

fn emit(value: serde_json::Value) -> Result<()> {
    use std::io::Write;
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, &value)?;
    writeln!(stdout)?;
    stdout.flush()?;
    Ok(())
}

struct Supervisor {
    desired: BTreeMap<String, Worker>,
    running: BTreeMap<String, Running>,
    retries: BTreeMap<String, Instant>,
    failures: BTreeMap<String, String>,
    budgets: BTreeMap<String, super::runner_retry::RetryBudget>,
    blocked: HashSet<String>,
    generation: u64,
    stopping: bool,
    sender: mpsc::UnboundedSender<Event>,
}

impl Supervisor {
    fn snapshot(&self, kind: &str) -> Result<()> {
        let workers: Vec<_> = self
            .running
            .iter()
            .map(|(id, worker)| Status {
                id,
                key: &worker.key,
                pid: worker.pid,
                draining: worker.draining,
            })
            .collect();
        let error = (!self.failures.is_empty()).then(|| {
            self.failures
                .values()
                .cloned()
                .collect::<Vec<_>>()
                .join("; ")
        });
        emit(serde_json::json!({ "type": kind, "workers": workers, "error": error }))
    }

    fn start(&mut self, id: &str) -> Result<()> {
        if self.stopping || self.running.contains_key(id) || self.blocked.contains(id) {
            return Ok(());
        }
        let Some(worker) = self.desired.get(id) else {
            return Ok(());
        };
        let mut command = Command::new(&worker.executable);
        command
            .arg(&worker.entry)
            .arg("--watch")
            .current_dir(&worker.cwd)
            .envs(&worker.env)
            .stdin(Stdio::piped());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut launch = || -> Result<_> {
            let runtime = Path::new(&worker.entry)
                .parent()
                .context("Runner entry directory is missing")?
                .join(".runner");
            create_dir_all(&runtime)?;
            let stdout = OpenOptions::new()
                .create(true)
                .append(true)
                .open(runtime.join("runner.log"))?;
            let stderr = OpenOptions::new()
                .create(true)
                .append(true)
                .open(runtime.join("runner-error.log"))?;
            command.stdout(stdout).stderr(stderr);
            Ok(command.spawn()?)
        };
        let mut child = match launch() {
            Ok(child) => child,
            Err(error) => {
                self.failures
                    .insert(id.into(), format!("[{id}] Launch failed: {error}"));
                self.retry(id, false, false);
                return Ok(());
            }
        };
        let input = child
            .stdin
            .take()
            .context("Runner control pipe is unavailable")?;
        let pid = child
            .id()
            .context("Runner process identity is unavailable")?;
        self.generation += 1;
        let generation = self.generation;
        self.running.insert(
            id.into(),
            Running {
                key: worker.key.clone(),
                generation,
                pid,
                input: Some(input),
                draining: false,
                notified: HashSet::new(),
                started: Instant::now(),
            },
        );
        self.failures.remove(id);
        let sender = self.sender.clone();
        let id = id.to_owned();
        tokio::spawn(async move {
            let (error, code) = match child.wait().await {
                Ok(status) if status.success() => (None, status.code()),
                Ok(status) => (Some(format!("Runner exited with {status}")), status.code()),
                Err(error) => (Some(format!("Cannot wait for runner: {error}")), None),
            };
            let _ = sender.send(Event::Exited {
                id,
                generation,
                error,
                code,
            });
        });
        Ok(())
    }

    fn retry(&mut self, id: &str, stable: bool, permanent: bool) {
        let delay = if permanent {
            None
        } else {
            self.budgets.entry(id.into()).or_default().next(stable)
        };
        let message = self.failures.entry(id.into()).or_default();
        if let Some(delay) = delay {
            message.push_str(&format!("; retrying in {} seconds", delay.as_secs()));
            self.retries.insert(id.into(), Instant::now() + delay);
        } else {
            message.push_str("; blocked: correct configuration or re-enable this runner to retry");
            self.blocked.insert(id.into());
        }
    }

    async fn drain(&mut self, id: &str) -> Result<()> {
        if let Some(worker) = self.running.get_mut(id) {
            if !worker.draining {
                worker.draining = true;
                let mut input = worker
                    .input
                    .take()
                    .context("Runner control pipe is already closed")?;
                if let Err(error) = async {
                    input.write_all(b"stop\n").await?;
                    input.shutdown().await
                }
                .await
                {
                    self.failures
                        .insert(id.into(), format!("[{id}] Drain control failed: {error}"));
                }
            }
        }
        Ok(())
    }

    async fn reconcile(&mut self, workers: Vec<Worker>) -> Result<()> {
        let mut desired = BTreeMap::new();
        for worker in workers {
            worker.validate()?;
            let id = worker.id.clone();
            anyhow::ensure!(
                desired.insert(id, worker).is_none(),
                "Duplicate runner identity"
            );
        }
        self.budgets.retain(|id, _| {
            desired
                .get(id)
                .zip(self.desired.get(id))
                .is_some_and(|(next, old)| next.key == old.key)
        });
        self.blocked.retain(|id| {
            desired
                .get(id)
                .zip(self.desired.get(id))
                .is_some_and(|(next, old)| next.key == old.key)
        });
        self.retries.retain(|id, _| {
            desired
                .get(id)
                .zip(self.desired.get(id))
                .is_some_and(|(next, old)| next.key == old.key)
        });
        self.desired = desired;
        self.retries.retain(|id, _| self.desired.contains_key(id));
        self.failures.retain(|id, _| self.desired.contains_key(id));
        let changed: Vec<_> = self
            .running
            .iter()
            .filter(|(id, running)| {
                self.desired
                    .get(*id)
                    .is_none_or(|next| next.key != running.key)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in changed {
            self.drain(&id).await?;
        }
        for id in self.desired.keys().cloned().collect::<Vec<_>>() {
            if !self.retries.contains_key(&id) {
                self.start(&id)?;
            }
            let Some(running) = self.running.get_mut(&id).filter(|worker| !worker.draining) else {
                continue;
            };
            let pending = &self.desired[&id].wake;
            if pending.difference(&running.notified).next().is_some() {
                if let Err(error) = running
                    .input
                    .as_mut()
                    .context("Runner control pipe is closed")?
                    .write_all(b"run\n")
                    .await
                {
                    self.failures
                        .insert(id.clone(), format!("[{id}] Wake control failed: {error}"));
                    continue;
                }
            }
            running.notified.clone_from(pending);
        }
        self.snapshot("state")
    }

    async fn stop(&mut self) -> Result<()> {
        self.stopping = true;
        self.desired.clear();
        self.retries.clear();
        self.failures.clear();
        for id in self.running.keys().cloned().collect::<Vec<_>>() {
            self.drain(&id).await?;
        }
        self.snapshot("state")
    }
}

pub async fn run() -> Result<()> {
    let (sender, mut events) = mpsc::unbounded_channel();
    let input = sender.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        loop {
            let event = match lines.next_line().await {
                Ok(Some(line)) if line.len() <= 4_000_000 => Event::Input(
                    serde_json::from_str(&line).context("Invalid runner engine command"),
                ),
                Ok(Some(_)) => {
                    Event::Input(Err(anyhow::anyhow!("Runner engine command is too large")))
                }
                Ok(None) => Event::Input(Ok(Control::Stop)),
                Err(error) => {
                    let _ = input.send(Event::Input(Err(error.into())));
                    Event::Input(Ok(Control::Stop))
                }
            };
            let stopped = matches!(event, Event::Input(Ok(Control::Stop)));
            if input.send(event).is_err() || stopped {
                break;
            }
        }
    });
    let mut supervisor = Supervisor {
        desired: BTreeMap::new(),
        running: BTreeMap::new(),
        retries: BTreeMap::new(),
        failures: BTreeMap::new(),
        budgets: BTreeMap::new(),
        blocked: HashSet::new(),
        generation: 0,
        stopping: false,
        sender,
    };
    supervisor.snapshot("ready")?;
    loop {
        let deadline = supervisor
            .retries
            .values()
            .min()
            .copied()
            .unwrap_or_else(|| Instant::now() + Duration::from_secs(86400));
        tokio::select! {
            Some(event) = events.recv() => match event {
                Event::Input(Ok(Control::Stop)) => supervisor.stop().await?,
                Event::Input(Ok(Control::Reconcile { request, workers })) if !supervisor.stopping => {
                    let error = supervisor.reconcile(workers).await.err().map(|error| format!("{error:#}"));
                    emit(serde_json::json!({ "type": "applied", "request": request, "error": error }))?;
                }
                Event::Input(Err(error)) => {
                    emit(serde_json::json!({ "type": "error", "error": format!("{error:#}") }))?;
                }
                Event::Input(_) => {}
                Event::Exited { id, generation, error, code } => {
                    if supervisor.running.get(&id).is_some_and(|worker| worker.generation == generation) {
                        let worker = supervisor.running.remove(&id).unwrap();
                        if !supervisor.stopping && supervisor.desired.contains_key(&id) {
                            if !worker.draining {
                                supervisor.failures.insert(id.clone(),
                                    format!("[{id}] {}", error.as_deref().unwrap_or("Runner exited unexpectedly")));
                                supervisor.retry(&id, worker.started.elapsed() >= Duration::from_secs(300),
                                    super::runner_retry::permanent_exit(code));
                            } else {
                                supervisor.retries.insert(id, Instant::now());
                            }
                        }
                        supervisor.snapshot("state")?;
                    }
                }
            },
            _ = tokio::time::sleep_until(deadline) => {
                let due: Vec<_> = supervisor.retries.iter().filter(|(_, at)| **at <= Instant::now())
                    .map(|(id, _)| id.clone()).collect();
                for id in due {
                    supervisor.retries.remove(&id);
                    supervisor.start(&id)?;
                }
                supervisor.snapshot("state")?;
            }
        }
        if supervisor.stopping && supervisor.running.is_empty() {
            supervisor.snapshot("stopped")?;
            return Ok(());
        }
    }
}
