use anyhow::{Context, Result};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;

pub struct DaemonLease {
    _file: File,
}

impl DaemonLease {
    pub fn acquire(root: &Path) -> Result<Self> {
        let directory = root.join(".runner");
        std::fs::create_dir_all(&directory)?;
        let file_path = directory.join("daemon.lock");
        let mut file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&file_path)?;
        file.try_lock().with_context(|| format!(
            "Another Spool daemon or run command owns {}; duplicate startup refused", root.display()
        ))?;
        // Older installed launchers hold this handle instead of a binary-owned lease.
        let legacy = directory.join("supervisor.lock");
        if legacy.exists() {
            let _legacy = OpenOptions::new().read(true).write(true).open(&legacy)
                .context("A legacy Spool launcher still owns this root; duplicate startup refused")?;
        }
        file.set_len(0)?;
        writeln!(file, "{}", std::process::id())?;
        file.sync_all()?;
        Ok(Self { _file: file })
    }
}

pub fn ensure_sessions_stopped(sessions: &[String]) -> Result<()> {
    if sessions.is_empty() {
        return Ok(());
    }
    #[cfg(windows)]
    let commands: Vec<Option<String>> = {
        use std::os::windows::process::CommandExt;
        let result = std::process::Command::new("pwsh.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference='Stop'; $lines=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(copilot|node|cmd)(\\.exe)?$' } | ForEach-Object { $_.CommandLine }); ConvertTo-Json -InputObject $lines -Compress"])
            .creation_flags(0x08000000)
            .output().context("Cannot inspect surviving agent sessions; recovery refused")?;
        anyhow::ensure!(result.status.success(), "Session inspection failed: {}", String::from_utf8_lossy(&result.stderr));
        serde_json::from_slice(&result.stdout).context("Invalid process inspection result")?
    };
    #[cfg(not(windows))]
    let commands: Vec<Option<String>> = {
        let result = std::process::Command::new("ps").args(["-eo", "args="]).output()?;
        anyhow::ensure!(result.status.success(), "Cannot inspect surviving agent sessions; recovery refused");
        String::from_utf8(result.stdout)?.lines().map(|line| Some(line.to_owned())).collect()
    };
    check_session_commands(sessions, &commands)
}

fn check_session_commands(sessions: &[String], commands: &[Option<String>]) -> Result<()> {
    for command in commands {
        let command = command.as_deref().context("A CLI process cannot be inspected; refusing unsafe session recovery")?;
        if let Some(session) = sessions.iter().find(|session| !session.is_empty() && command.contains(session.as_str())) {
            anyhow::bail!("Agent session {session} is still alive; startup held without stopping or duplicating it");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_covers_path_aliases_and_releases_without_deleting_the_lock_file() -> Result<()> {
        let root = std::env::temp_dir().join(format!("spool-lease-{}", uuid::Uuid::new_v4()));
        let lease = DaemonLease::acquire(&root)?;
        assert!(DaemonLease::acquire(&root.join(".")).is_err());
        drop(lease);
        let recovered = DaemonLease::acquire(&root)?;
        drop(recovered);
        std::fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn recovery_rejects_surviving_or_uninspectable_sessions() {
        let sessions = vec!["provider-session".into()];
        assert!(check_session_commands(&sessions, &[Some("copilot --session-id provider-session".into())]).is_err());
        assert!(check_session_commands(&sessions, &[None]).is_err());
        assert!(check_session_commands(&sessions, &[Some("node unrelated.js".into())]).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn legacy_launcher_blocks_new_binaries_during_live_upgrade() -> Result<()> {
        use std::os::windows::fs::OpenOptionsExt;
        let root = std::env::temp_dir().join(format!("spool-legacy-lease-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".runner"))?;
        let legacy = OpenOptions::new().read(true).write(true).create_new(true).share_mode(0)
            .open(root.join(".runner").join("supervisor.lock"))?;
        assert!(DaemonLease::acquire(&root).is_err());
        drop(legacy);
        let lease = DaemonLease::acquire(&root)?;
        drop(lease);
        std::fs::remove_dir_all(root)?;
        Ok(())
    }
}
