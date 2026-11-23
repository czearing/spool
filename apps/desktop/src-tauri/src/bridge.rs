mod connection;
#[cfg(all(test, windows))]
mod tests;

use connection::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Mutex},
    time::Duration,
};
use tauri::ipc::Channel;

pub struct Bridge {
    connection: Mutex<Connection>,
    runtime: PathBuf,
    script: PathBuf,
    data: PathBuf,
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
    pub fn shutdown(&self) -> Result<(), String> {
        let mut connection = self.connection.lock().map_err(|error| error.to_string())?;
        if connection
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Ok(());
        }
        connection.send(&json!({ "shutdown": true }))?;
        loop {
            if connection
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_some()
            {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    pub fn start(
        runtime: &Path,
        script: &Path,
        data: &Path,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        std::fs::create_dir_all(data)?;
        let (runner_runtime, runner_script, runner_data) =
            (runtime.to_owned(), script.to_owned(), data.to_owned());
        std::thread::spawn(move || {
            if let Err(error) =
                crate::runner_runtime::start(&runner_runtime, &runner_script, &runner_data)
            {
                eprintln!("Runner host could not start; saved data remains available: {error}");
            }
        });
        Ok(Self {
            connection: Mutex::new(Connection::start(runtime, script, data)?),
            runtime: runtime.into(),
            script: script.into(),
            data: data.into(),
        })
    }
    fn reconnect(&self, connection: &mut Connection) -> Result<(), String> {
        if !connection.healthy.load(Ordering::Acquire)
            || connection
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_some()
        {
            *connection = Connection::start(&self.runtime, &self.script, &self.data)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
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
    let mut connection = bridge
        .connection
        .lock()
        .map_err(|error| error.to_string())?;
    bridge.reconnect(&mut connection)?;
    {
        let mut pending = connection
            .pending
            .lock()
            .map_err(|error| error.to_string())?;
        if pending.len() > 128 || pending.contains_key(&request.id) {
            return Err("Too many desktop requests.".into());
        }
        pending.insert(request.id.clone(), channel);
    }
    if let Err(error) = connection.send(&request) {
        connection.pending.lock().unwrap().remove(&request.id);
        return Err(error);
    }
    Ok(())
}
#[tauri::command]
pub fn cancel_request(bridge: tauri::State<'_, Bridge>, id: String) -> Result<(), String> {
    let mut connection = bridge
        .connection
        .lock()
        .map_err(|error| error.to_string())?;
    connection
        .pending
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&id);
    connection.send(&json!({ "id": id, "cancel": true }))
}
