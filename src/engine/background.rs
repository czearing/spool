use anyhow::{Context, Result};
use std::fs::OpenOptions;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub async fn start(root: &Path) -> Result<u32> {
    let root = root.canonicalize().context("Task runtime project is unavailable")?;
    let logs = root.join("logs");
    std::fs::create_dir_all(&logs)?;
    let output = OpenOptions::new().create(true).append(true).open(logs.join("task-runtime.stdout.log"))?;
    let errors = OpenOptions::new().create(true).append(true).open(logs.join("task-runtime.stderr.log"))?;
    let mut command = Command::new(std::env::current_exe()?);
    command.arg("--root").arg(&root).arg("daemon").current_dir(&root)
        .stdin(Stdio::null()).stdout(output).stderr(errors);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // The desktop's backend job must not own agent executions after the UI exits.
        command.creation_flags(0x01000000 | 0x08000000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().context("Cannot launch the background task runtime")?;
    let pid = child.id();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait()? {
            anyhow::bail!("Task runtime {pid} exited {status}; check {}", logs.join("task-runtime.stderr.log").display());
        }
        match std::fs::read(root.join("controls").join("capabilities.json")) {
            Ok(bytes) => {
                let capability: serde_json::Value = serde_json::from_slice(&bytes)?;
                if capability["pid"].as_u64() == Some(u64::from(pid)) && capability["taskControl"] == true {
                    return Ok(pid);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        anyhow::ensure!(Instant::now() < deadline,
            "Task runtime {pid} did not become ready; it was left running. Check {}", logs.display());
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
