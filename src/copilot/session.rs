use std::path::Path;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::models::{AgentConfig, Task};

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfig {
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub workspace: String,
    pub agent: String,
    pub mcp: Option<Value>,
}

pub fn task_mcp(root: &Path, task: &Task, agent: &str, binary: Option<&Path>) -> Option<Value> {
    binary.map(|binary| json!({ "mcpServers": { "spool": {
        "type": "local", "command": binary, "tools": ["*"],
        "args": ["--root", root, "mcp", "--agent", agent, "--task", task.id],
    } } }))
}

fn git_head(cwd: &Path, symbolic: bool) -> Result<String> {
    let mut command = std::process::Command::new("git");
    command.arg("-C").arg(cwd).arg("rev-parse");
    if symbolic { command.arg("--abbrev-ref"); }
    command.arg("HEAD");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().context("Cannot verify session workspace branch")?;
    anyhow::ensure!(output.status.success(), "Cannot verify session workspace branch");
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

fn branch(cwd: &Path) -> Result<Option<String>> {
    if !cwd.join(".git").try_exists()? { return Ok(None); }
    let branch = git_head(cwd, true)?;
    Ok(Some(if branch == "HEAD" { format!("HEAD:{}", git_head(cwd, false)?) } else { branch }))
}

impl SessionConfig {
    pub(crate) fn verify_preparation(cwd: &Path, expected_branch: &str, commit: &str) -> Result<()> {
        if cwd.join(".git").try_exists()? {
            anyhow::ensure!(branch(cwd)?.as_deref() == Some(expected_branch) && git_head(cwd, false)? == commit,
                "Workspace changed after runner preparation");
        }
        Ok(())
    }

    pub fn capture(cwd: &Path, task: &Task, agent: &AgentConfig, mcp: Option<Value>) -> Result<Self> {
        Ok(Self { model: task.model.as_ref().unwrap_or(&agent.model).clone(), reasoning_effort: agent.reasoning_effort.clone(),
            workspace: std::fs::canonicalize(cwd)?.to_string_lossy().into_owned(),
            agent: task.agent.clone(), mcp })
    }

    pub fn validate(&self, cwd: &Path, task: &Task) -> Result<()> {
        anyhow::ensure!(self.agent == task.agent, "Session belongs to a different agent; continuation refused");
        anyhow::ensure!(std::fs::canonicalize(cwd)? == std::fs::canonicalize(&self.workspace)?,
            "Session workspace changed; continuation refused");
        Ok(())
    }

    pub fn restored(&mut self, session: &Value, pinned: bool) -> Result<()> {
        let model = session["models"]["currentModelId"].as_str().context("Provider did not report the restored model")?;
        let reasoning = session["configOptions"].as_array().and_then(|options| options.iter()
            .find(|option| option["id"] == "reasoning_effort" || option["id"] == "reasoning"))
            .and_then(|option| option["currentValue"].as_str()).map(str::to_owned);
        if pinned {
            anyhow::ensure!(self.model == model, "Restored model changed; refusing to invalidate the session cache");
            if let Some(reasoning) = reasoning.as_ref() {
                anyhow::ensure!(self.reasoning_effort.as_ref().is_none_or(|expected| expected == reasoning),
                    "Restored reasoning configuration changed");
            }
        }
        self.model = model.to_owned();
        if !pinned || reasoning.is_some() { self.reasoning_effort = reasoning; }
        Ok(())
    }
}
