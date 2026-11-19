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
#[path = "autopilot.rs"]
mod autopilot;

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

fn turn_prompt(agent: &AgentConfig) -> Result<String> {
    if agent.path.as_os_str().is_empty() { return Ok(agent.per_turn_prompt.clone()); }
    Ok(AgentConfig::from_file(&agent.path)?.per_turn_prompt)
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
        let root = self.logs_dir.parent().context("Spool root is unavailable")?;
        if interactive_enabled() || crate::models::project::autopilot(root)? ||
            task.session_config.as_ref().is_some_and(|config| config.provider.is_some() || config.autopilot) ||
            super::provider::configured(root, &task.agent)?.is_some() {
            acp::execute(self, task, agent, mcp_binary, log_tx).await
        } else {
            oneshot::execute(self, task, agent, mcp_binary, log_tx).await
        }
    }

    fn execution_context(&self, task: &Task, session_id: &str) -> Result<PathBuf> {
        anyhow::ensure!(task.session_id.as_deref() == Some(session_id), "Conversation must be persisted before launch");
        let root = self.logs_dir.parent().context("Spool root is unavailable")?;
        let directory = root.join("controls").join("executions");
        fs::create_dir_all(&directory)?;
        let file = directory.join(format!("{}.json", task.id));
        write_json(&file, &serde_json::json!({
            "version": 1, "taskId": task.id, "agent": task.agent,
            "sessionId": session_id, "workspace": task.workspace, "projectRoot": root,
            "providerToken": task.provider.as_ref().map(|provider| &provider.token),
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
