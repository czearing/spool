use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use uuid::Uuid;

use crate::copilot::parser::{format_stream_event, parse_usage_json, CopilotUsageStats};
use crate::models::{AgentConfig, Task};

pub struct CopilotExecutionResult {
    pub exit_code: i32,
    pub session_id: String,
    pub usage: CopilotUsageStats,
}

pub struct CopilotRunner {
    binary_path: String,
    logs_dir: PathBuf,
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
        fs::create_dir_all(&self.logs_dir)?;
        let log_file_path = self.logs_dir.join(format!("{}.log", task.id));
        let mut log_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_file_path)?;

        let session_id = task.session_id.clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let usage_file_path = self.logs_dir.join(format!("{}.usage.json", task.id));

        let mut prompt_full = String::new();
        if !agent.system_prompt.is_empty() {
            prompt_full.push_str(&agent.system_prompt);
            prompt_full.push_str("\n\n---\nTask Assignment:\n");
        }
        prompt_full.push_str(&task.prompt);

        let mut cmd = Command::new(&self.binary_path);
        cmd.arg("-p")
            .arg(&prompt_full)
            .arg("--session-id")
            .arg(&session_id)
            .arg("--allow-all")
            .arg("--output-format")
            .arg("json")
            .arg("--usage-output-file")
            .arg(&usage_file_path)
            .arg("--model")
            .arg(&agent.model);

        if let Some(ref effort) = agent.reasoning_effort {
            cmd.arg("--reasoning-effort").arg(effort);
        }

        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(ref ws) = task.workspace {
            cmd.arg("-C").arg(ws);
        }

        if let Some(mcp_path) = mcp_binary {
            let mcp_cfg = serde_json::json!({
                "mcpServers": {
                    "spool": {
                        "command": mcp_path.to_string_lossy(),
                        "args": ["mcp", "--agent", &agent.name, "--task", &task.id]
                    }
                }
            });
            cmd.arg("--additional-mcp-config").arg(mcp_cfg.to_string());
        }

        let mut child = cmd.spawn()
            .with_context(|| "Failed to spawn copilot CLI process")?;

        let stdout = child.stdout.take().context("Missing stdout")?;
        let mut reader = BufReader::new(stdout).lines();

        writeln!(log_file, "=== TASK START {} (Session: {}) ===", task.id, session_id)?;

        while let Ok(Some(line)) = reader.next_line().await {
            writeln!(log_file, "{}", line)?;
            let _ = log_file.flush();

            if let Some(formatted) = format_stream_event(&line) {
                if let Some(ref tx) = log_tx {
                    let _ = tx.send(formatted).await;
                }
            }
        }

        let status = child.wait().await?;
        let exit_code = status.code().unwrap_or(-1);
        writeln!(log_file, "=== TASK END {} (Exit Code: {}) ===", task.id, exit_code)?;

        let usage = if usage_file_path.exists() {
            let content = fs::read_to_string(&usage_file_path).unwrap_or_default();
            parse_usage_json(&content)
        } else {
            CopilotUsageStats::default()
        };

        Ok(CopilotExecutionResult {
            exit_code,
            session_id,
            usage,
        })
    }
}
