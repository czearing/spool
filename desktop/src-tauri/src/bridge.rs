use crate::job::ProcessJob;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::ipc::Channel;

type Pending = Arc<Mutex<HashMap<String, Channel<Value>>>>;
pub struct Bridge {
    input: Mutex<ChildStdin>,
    pending: Pending,
    child: Mutex<Child>,
    _job: ProcessJob,
}
#[derive(Deserialize, serde::Serialize)]
pub struct Request {
    id: String,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
}
impl Bridge {
    pub fn start(
        runtime: &Path,
        script: &Path,
        data: &Path,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        std::fs::create_dir_all(data)?;
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
            for (_, channel) in replies.lock().unwrap().drain() {
                let _ = channel.send(json!({"type":"error","error":"Desktop service stopped. Restart Spool; see desktop.log."}));
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
            input: Mutex::new(input),
            pending,
            child: Mutex::new(child),
            _job: job,
        })
    }
    fn send(&self, value: &impl serde::Serialize) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut *input, value).map_err(|error| error.to_string())?;
        input
            .write_all(b"\n")
            .and_then(|_| input.flush())
            .map_err(|error| error.to_string())
    }
}
#[tauri::command]
pub fn request(
    bridge: tauri::State<'_, Bridge>,
    request: Request,
    channel: Channel<Value>,
) -> Result<(), String> {
    if !request.url.starts_with("/api/")
        || request.url.len() > 8192
        || request.id.len() != 36
        || !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].contains(&request.method.as_str())
        || request
            .body
            .as_ref()
            .is_some_and(|body| body.len() > 1_000_000)
    {
        return Err("Invalid desktop request.".into());
    }
    {
        let mut pending = bridge.pending.lock().map_err(|error| error.to_string())?;
        if pending.len() > 128 || pending.contains_key(&request.id) {
            return Err("Too many desktop requests.".into());
        }
        pending.insert(request.id.clone(), channel);
    }
    if let Err(error) = bridge.send(&request) {
        bridge.pending.lock().unwrap().remove(&request.id);
        return Err(error);
    }
    Ok(())
}
#[tauri::command]
pub fn cancel_request(bridge: tauri::State<'_, Bridge>, id: String) -> Result<(), String> {
    bridge
        .pending
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&id);
    bridge.send(&json!({ "id": id, "cancel": true }))
}
impl Drop for Bridge {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
