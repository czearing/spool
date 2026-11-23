use crate::job::ProcessJob;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::ipc::Channel;

type Pending = Arc<Mutex<HashMap<String, Channel<Value>>>>;
pub struct Bridge {
    connection: Mutex<Connection>,
    runtime: PathBuf,
    script: PathBuf,
    data: PathBuf,
}
struct Connection {
    input: ChildStdin,
    pending: Pending,
    child: Child,
    _job: ProcessJob,
    healthy: Arc<AtomicBool>,
}
#[derive(Deserialize, serde::Serialize)]
pub struct Request {
    id: String,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
}
fn start_runner_host(runtime: &Path, script: &Path, data: &Path) -> std::io::Result<()> {
    let (runtime, script, engine) = crate::runner_runtime::snapshot(runtime, script, data)?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data.join("runners.log"))?;
    let mut command = Command::new(&engine);
    command
        .arg("runner-host")
        .arg("--runtime")
        .arg(dunce::simplified(&runtime))
        .arg("--script")
        .arg(dunce::simplified(&script))
        .arg("--data")
        .arg(dunce::simplified(data))
        .current_dir(data)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // The runner host must not inherit the desktop's kill-on-close job.
        command.creation_flags(0x01000000 | 0x08000000);
    }
    let child = command.spawn();
    #[cfg(windows)]
    let child = match child {
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            use std::os::windows::process::CommandExt;
            let quote = |value: &Path| format!("\"{}\"", dunce::simplified(value).display());
            let line = format!(
                "{} runner-host --runtime {} --script {} --data {}",
                quote(&engine),
                quote(&runtime),
                quote(&script),
                quote(data)
            );
            let literal = |value: &str| format!("'{}'", value.replace('\'', "''"));
            let shell =
                PathBuf::from(std::env::var_os("SystemRoot").ok_or_else(|| {
                    std::io::Error::other("Windows system directory is unavailable")
                })?)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe");
            let script = format!("$ErrorActionPreference='Stop'; $startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{{CreateFlags=[uint32]0x09000000;ShowWindow=[uint16]0}}; $p=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{CommandLine={};CurrentDirectory={};ProcessStartupInformation=$startup}}; if($p.ReturnValue -ne 0) {{ throw \"Runner host creation failed: $($p.ReturnValue)\" }}",
                literal(&line), literal(&data.to_string_lossy()));
            let log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(data.join("runners.log"))?;
            Command::new(shell)
                .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                .creation_flags(0x08000000)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(log)
                .spawn()
        }
        result => result,
    };
    let mut child = child?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
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
            if let Err(error) = start_runner_host(&runner_runtime, &runner_script, &runner_data) {
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
impl Connection {
    fn start(
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
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::time::Instant;

    fn until(mut predicate: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !predicate() {
            assert!(
                Instant::now() < deadline,
                "Fixture desktop process did not reach its expected state"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn runner_host_survives_backend_crash_reconnect_and_desktop_shutdown(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let root = std::env::temp_dir().join(format!("spool-bridge-{}", std::process::id()));
        std::fs::create_dir_all(&root)?;
        let runtime = manifest.join("binaries/spool-runtime-x86_64-pc-windows-msvc.exe");
        std::fs::copy(
            manifest.join("resources/spool-engine.exe"),
            root.join("spool-engine.exe"),
        )?;
        let script = root.join("backend.mjs");
        std::fs::write(
            &script,
            r#"
    import { existsSync, writeFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    if (process.argv.includes("--runner-service")) {
      writeFileSync("service-pid", String(process.pid));
      const timer = setInterval(() => {
        if (existsSync("stop-service")) { clearInterval(timer); process.exit(0); }
        writeFileSync("heartbeat", String(Date.now()));
      }, 20);
      createInterface({ input: process.stdin }).on("line", line => {
        if (line === "shutdown") { clearInterval(timer); process.exit(0); }
      });
    } else {
      console.log(JSON.stringify({ id: "ready", type: "ready" }));
      createInterface({ input: process.stdin }).on("line", line => {
        const value = JSON.parse(line);
        if (value.crash) process.exit(7);
        if (value.shutdown) process.exit(0);
      });
    }
    "#,
        )?;
        let bridge = Bridge::start(&runtime, &script, &root)?;
        until(|| root.join("heartbeat").exists());
        let service = std::fs::read_to_string(root.join("service-pid"))?;
        {
            let mut connection = bridge.connection.lock().unwrap();
            let pid = connection.child.id();
            connection.send(&json!({ "crash": true }))?;
            until(|| connection.child.try_wait().unwrap().is_some());
            bridge.reconnect(&mut connection)?;
            assert_ne!(connection.child.id(), pid);
        }
        bridge.shutdown()?;
        drop(bridge);
        let heartbeat = std::fs::read_to_string(root.join("heartbeat"))?;
        until(|| std::fs::read_to_string(root.join("heartbeat")).unwrap_or_default() != heartbeat);
        assert_eq!(std::fs::read_to_string(root.join("service-pid"))?, service);
        std::fs::write(&script, format!("{}\n// Updated runtime revision", std::fs::read_to_string(&script)?))?;
        let updated = Bridge::start(&runtime, &script, &root)?;
        until(|| std::fs::read_to_string(root.join("service-pid")).is_ok_and(|pid| pid != service));
        updated.shutdown()?;
        drop(updated);
        let heartbeat = std::fs::read_to_string(root.join("heartbeat"))?;
        until(|| std::fs::read_to_string(root.join("heartbeat")).unwrap_or_default() != heartbeat);
        std::fs::write(root.join("stop-service"), "")?;
        until(|| {
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(root.join("runner-host.lock"));
            file.is_ok_and(|file| file.try_lock().is_ok())
        });
        until(|| std::fs::remove_dir_all(&root).is_ok() || !root.exists());
        Ok(())
    }
}
impl Connection {
    fn send(&mut self, value: &impl serde::Serialize) -> Result<(), String> {
        serde_json::to_writer(&mut self.input, value).map_err(|error| error.to_string())?;
        self.input
            .write_all(b"\n")
            .and_then(|_| self.input.flush())
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
impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
