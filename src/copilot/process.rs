use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::copilot::parser::CopilotUsageStats;
use crate::models::{AgentConfig, Task};
use crate::queue::fs::write_json;

#[path = "acp.rs"]
mod acp;
#[path = "oneshot.rs"]
mod oneshot;

pub fn interactive_enabled() -> bool {
    std::env::var("SPOOL_INTERACTIVE_ACP").is_ok_and(|value| value == "1")
}

pub struct CopilotExecutionResult {
    pub exit_code: i32,
    pub session_id: String,
    pub usage: CopilotUsageStats,
}

pub struct CopilotRunner {
    binary_path: String,
    logs_dir: PathBuf,
}

fn work_item_prompt(task: &Task, agent: &AgentConfig) -> String {
    if task.session_id.is_some() {
        task.prompt.clone()
    } else {
        format!("{}\n\n{}", agent.system_prompt, task.prompt)
    }
}

impl CopilotRunner {
    pub fn new(logs_dir: impl AsRef<Path>) -> Self {
        Self {
            binary_path: "copilot".to_string(),
            logs_dir: logs_dir.as_ref().to_path_buf(),
        }
    }

    pub async fn execute_task(
        &self,
        task: &Task,
        agent: &AgentConfig,
        mcp_binary: Option<&Path>,
        log_tx: Option<tokio::sync::mpsc::Sender<String>>,
    ) -> Result<CopilotExecutionResult> {
        if interactive_enabled() {
            acp::execute(self, task, agent, mcp_binary, log_tx).await
        } else {
            oneshot::execute(self, task, agent, mcp_binary, log_tx).await
        }
    }

    fn creator_context(&self, task: &Task, session_id: &str) -> Result<PathBuf> {
        anyhow::ensure!(task.session_id.as_deref() == Some(session_id), "Creator session must be persisted before launch");
        let root = self.logs_dir.parent().context("Spool root is unavailable")?;
        crate::automation::bind_session(root, task, session_id)?;
        let records = root.join(".runner-receipts");
        let prepared = task.metadata(root)?;
        let branch = prepared.as_ref()
            .filter(|value| value["preparation"]["ready"] == true &&
                value["preparation"]["repoRoot"].as_str().zip(task.workspace.as_deref())
                    .is_some_and(|(a, b)| {
                        fs::canonicalize(a).ok().zip(fs::canonicalize(b).ok())
                            .is_some_and(|(a, b)| a == b)
                    }))
            .and_then(|value| value["preparation"]["branch"].as_str());
        let directory = records.join("creator-contexts");
        fs::create_dir_all(&directory)?;
        let file = directory.join(format!("{}.json", task.id));
        write_json(&file, &serde_json::json!({
            "version": 1, "originKind": "spool", "taskId": task.id, "agent": task.agent,
            "sessionId": session_id, "workspace": task.workspace, "branch": branch,
            "providerToken": task.provider.as_ref().map(|provider| &provider.token),
            "receiptDirectory": records.join("native-creators"), "originalPrompt": task.prompt,
            "acceptance": task.acceptance,
        }))?;
        Ok(file)
    }

    fn command(&self) -> Result<Command> {
        #[cfg(windows)]
        {
            let paths: Vec<_> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
            let mut command = resolve_windows_command(&paths)?;
            command.creation_flags(0x08000000);
            Ok(command)
        }
        #[cfg(not(windows))]
        { Ok(Command::new(&self.binary_path)) }
    }

    fn configure_task_mcp(
        &self, command: &mut Command, task: &Task, agent: &AgentConfig, binary: Option<&Path>,
    ) -> Result<()> {
        if let Some(binary) = binary {
            let root = self.logs_dir.parent().context("Missing Spool root")?;
            command.arg("--additional-mcp-config")
                .arg(super::session::task_mcp(root, task, &agent.name, Some(binary)).unwrap().to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;

#[cfg(windows)]
fn resolve_windows_command(paths: &[PathBuf]) -> Result<Command> {
    for directory in paths {
        let executable = directory.join("copilot.exe");
        if executable.is_file() { return Ok(Command::new(executable)); }
        let loader = directory.join("node_modules").join("@github").join("copilot").join("npm-loader.js");
        if loader.is_file() {
            let mut command = Command::new("node.exe");
            command.arg(loader);
            return Ok(command);
        }
    }
    anyhow::bail!("No native CLI executable or npm loader found on PATH; refusing cmd.exe prompt execution")
}
