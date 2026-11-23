use crate::job::ProcessJob;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::ipc::Channel;

type Pending = Arc<Mutex<HashMap<String, Channel<Value>>>>;
pub(super) struct Connection {
    input: ChildStdin,
    pub(super) pending: Pending,
    pub(super) child: Child,
    _job: ProcessJob,
    pub(super) healthy: Arc<AtomicBool>,
}
impl Connection {
    pub(super) fn start(
        runtime: &Path,
        script: &Path,
        data: &Path,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(data.join("desktop.log"))?;
        let mut command = Command::new(dunce::simplified(runtime));
        command
            .arg(dunce::simplified(script))
            .current_dir(dunce::simplified(data))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn()?;
        let job = match ProcessJob::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.into());
            }
        };
        let input = child.stdin.take().ok_or("Desktop input unavailable")?;
        let output = child.stdout.take().ok_or("Desktop output unavailable")?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let replies = Arc::clone(&pending);
        let (ready, wait) = std::sync::mpsc::channel();
        let healthy = Arc::new(AtomicBool::new(true));
        let connected = healthy.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let value = match line.and_then(|line| {
                    serde_json::from_str::<Value>(&line).map_err(std::io::Error::other)
                }) {
                    Ok(value) => value,
                    Err(error) => {
                        eprintln!("Desktop protocol failed: {error}");
                        break;
                    }
                };
                if value["id"] == "ready" {
                    let _ = ready.send(());
                    continue;
                }
                if let Some(id) = value["id"].as_str() {
                    let mut pending = replies.lock().unwrap();
                    if let Some(channel) = pending.get(id) {
                        let _ = channel.send(value.clone());
                    }
                    if value["type"] == "end" || value["type"] == "error" {
                        pending.remove(id);
                    }
                }
            }
            connected.store(false, Ordering::Release);
            for (_, channel) in replies.lock().unwrap().drain() {
                let _ = channel.send(json!({"type":"error","error":"Desktop connection interrupted. Reconnecting does not stop your runners."}));
            }
        });
        if wait.recv_timeout(Duration::from_secs(30)).is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Desktop service could not start. See {}",
                data.join("desktop.log").display()
            )
            .into());
        }
        Ok(Self {
            input,
            pending,
            child,
            _job: job,
            healthy,
        })
    }
    pub(super) fn send(&mut self, value: &impl serde::Serialize) -> Result<(), String> {
        serde_json::to_writer(&mut self.input, value).map_err(|error| error.to_string())?;
        self.input
            .write_all(b"\n")
            .and_then(|_| self.input.flush())
            .map_err(|error| error.to_string())
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
