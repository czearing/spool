use std::path::Path;
use anyhow::{Context, Result};
use serde_json::Value;
use crate::models::Task;

pub fn verify_completion(root: &Path, task: &Task) -> Result<Option<Value>> {
    let Some(contract) = task.acceptance.as_ref() else { return Ok(None); };
    anyhow::ensure!(contract["kind"] == "bundle-v2" && contract["version"] == 2,
        "Unsupported task acceptance contract; completion refused");
    let verifier = Path::new(contract["verifier"].as_str().context("Acceptance verifier is missing")?);
    anyhow::ensure!(verifier.is_absolute() && verifier.is_file() &&
        verifier.file_name().is_some_and(|name| name == "verify-task.mjs"),
        "Acceptance verifier is unavailable");
    let mut command = std::process::Command::new("node");
    command.arg(verifier).arg("--root").arg(root).arg("--task").arg(&task.id);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().context("Cannot execute independent bundle acceptance")?;
    anyhow::ensure!(output.status.success(), "Independent bundle acceptance failed: {}",
        String::from_utf8_lossy(&output.stderr));
    let result: Value = serde_json::from_slice(&output.stdout).context("Invalid acceptance result")?;
    anyhow::ensure!(result["status"] == "verified" && result["taskId"] == task.id &&
        result["sessionId"].as_str() == task.session_id.as_deref() &&
        result["prId"].as_str().is_some_and(|id| !id.is_empty()) &&
        result["value"].as_u64().is_some(),
        "Independent acceptance did not verify this published task/session");
    Ok(Some(result))
}
