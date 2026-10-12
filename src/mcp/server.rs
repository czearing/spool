use std::path::{Path, PathBuf};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use crate::mcp::protocol::{JsonRpcRequest, JsonRpcResponse};
use crate::models::{Task, TaskStatus};
use crate::queue::fs::{atomic_move, read_task, write_json, write_task, QueuePaths, TaskGuard};
fn tool_error(error: anyhow::Error) -> Value {
    json!({ "isError": true, "content": [{ "type": "text", "text": format!("{error:#}") }] })
}
#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
#[path = "server_protocol.rs"]
mod transport;
#[path = "agent_tools.rs"]
mod agent_tools;
pub struct McpServer {
    queues_root: PathBuf,
    current_agent: Option<String>,
    current_task_id: Option<String>,
}
impl McpServer {
    pub fn new(queues_root: impl AsRef<Path>, agent: Option<String>, task_id: Option<String>) -> Self {
        Self {
            queues_root: queues_root.as_ref().to_path_buf(),
            current_agent: agent,
            current_task_id: task_id,
        }
    }
    fn execute_tool(&self, name: &str, args: Value) -> Value {
        if ["spool_create_agent", "spool_update_agent", "spool_get_agent", "spool_list_agents"].contains(&name) {
            return self.agent_tool(name, args);
        }
        let agent = self.current_agent.as_deref().unwrap_or("default");
        let task_id = self.current_task_id.as_deref();
        let paths = QueuePaths::new(&self.queues_root);
        let _guard = match task_id.map(|id| TaskGuard::acquire(&self.queues_root, id)).transpose() {
            Ok(guard) => guard,
            Err(error) => return tool_error(error),
        };
        match name {
            "spool_register_pr" => {
                match self.register_pr(&args) {
                    Ok(record) => json!({ "content": [{ "type": "text", "text": record.to_string() }] }),
                    Err(error) => tool_error(error),
                }
            }
            "spool_get_task" => {
                match self.read_current_task().and_then(|task| Ok(serde_json::to_string_pretty(&task)?)) {
                    Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
                    Err(error) => tool_error(error),
                }
            }
            "spool_update_task_status" => {
                let Some(status_str) = args.get("status").and_then(|v| v.as_str()) else {
                    return tool_error(anyhow::anyhow!("An explicit task status is required"));
                };
                let reassign_to = args.get("reassign_to").and_then(|v| v.as_str());
                let comment = args.get("comment").and_then(|v| v.as_str());
                let err = args.get("error").and_then(|v| v.as_str());
                if let Some(tid) = task_id {
                    let in_prog_file = paths.in_progress.join(format!("{}.json", tid));
                    if let Ok(mut task) = read_task(&in_prog_file) {
                        if let Some(new_agent) = reassign_to {
                            let msg = comment.unwrap_or("Handing off task");
                            task.interaction.handoff = Some(crate::models::task::OperatorHandoff {
                                id: uuid::Uuid::new_v4().to_string(), agent: new_agent.to_string(), message: msg.to_owned(),
                            });
                            crate::engine::operator::apply_handoff(&mut task);
                            let dest = paths.incoming.join(format!("{}.json", tid));
                            if let Err(error) = write_task(&in_prog_file, &task).and_then(|_| atomic_move(&in_prog_file, &dest)) {
                                return tool_error(error);
                            }
                            return json!({ "content": [{ "type": "text", "text": format!("Handed off task {} to {}", tid, new_agent) }] });
                        }
                        if let Some(c) = comment { task.add_comment(format!("agent:{}", agent), c); }
                        if let Some(e) = err { task.error = Some(e.to_string()); }
                        let target_status = match status_str {
                            "failed" => TaskStatus::Failed,
                            "in_progress" => TaskStatus::InProgress,
                            "incoming" => TaskStatus::Incoming,
                            "completed" => TaskStatus::Completed,
                            _ => return tool_error(anyhow::anyhow!("Invalid task status: {status_str}")),
                        };
                        if target_status == TaskStatus::Completed {
                            let root = match self.queues_root.parent() {
                                Some(root) => root,
                                None => return tool_error(anyhow::anyhow!("Spool root is missing")),
                            };
                            match crate::engine::acceptance::verify_completion(root, &task) {
                                Ok(Some(result)) => task.add_comment("spool:acceptance",
                                    format!("Independent bundle acceptance verified commit {} and PR {}. after: {}",
                                        result["commit"], result["prId"], result["value"])),
                                Ok(None) => {},
                                Err(error) => return tool_error(error),
                            }
                        }
                        task.status = target_status;
                        
                        let dest = paths.status_dir(target_status).join(format!("{}.json", tid));
                        if let Err(error) = write_task(&in_prog_file, &task).and_then(|_| {
                            if target_status == TaskStatus::InProgress { Ok(()) } else { atomic_move(&in_prog_file, &dest) }
                        }) {
                            return tool_error(error);
                        }
                        return json!({ "content": [{ "type": "text", "text": format!("Task status updated to {}", target_status) }] });
                    }
                }
                json!({ "isError": true, "content": [{ "type": "text", "text": "Failed to update task" }] })
            }
            "spool_add_comment" => {
                let comment = args.get("comment").and_then(|v| v.as_str()).unwrap_or("");
                if let Some(tid) = task_id {
                    let in_prog_file = paths.in_progress.join(format!("{}.json", tid));
                    if let Ok(mut task) = read_task(&in_prog_file) {
                        task.add_comment(format!("agent:{}", agent), comment);
                        if let Err(error) = write_task(&in_prog_file, &task) {
                            return tool_error(error);
                        }
                        return json!({ "content": [{ "type": "text", "text": "Comment added successfully" }] });
                    }

                }
                json!({ "isError": true, "content": [{ "type": "text", "text": "Task not found" }] })
            }
            "spool_create_task" => {
                let target_agent = args.get("agent").and_then(|v| v.as_str()).unwrap_or("software-engineer");
                let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("Delegated Task");
                let prompt = args.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
                let ws = args.get("workspace").and_then(|v| v.as_str()).map(|s| s.to_string());

                let new_id = format!("TASK-{}", &uuid::Uuid::new_v4().to_string()[..8].to_uppercase());
                let mut new_task = crate::models::Task::new(&new_id, target_agent, title, prompt);
                new_task.workspace = ws;
                new_task.add_comment(format!("delegated_by:{}", agent), format!("Created by {} from task {:?}", agent, task_id));

                let target_file = paths.incoming.join(format!("{}.json", new_id));
                if write_task(&target_file, &new_task).is_ok() {
                    json!({ "content": [{ "type": "text", "text": format!("Delegated task {} to {} successfully", new_id, target_agent) }] })
                } else {
                    json!({ "isError": true, "content": [{ "type": "text", "text": "Failed to create task file" }] })
                }
            }
            _ => json!({ "isError": true, "content": [{ "type": "text", "text": format!("Unknown tool: {}", name) }] }),
        }
    }
    fn read_current_task(&self) -> Result<Task> {
        let id = self.current_task_id.as_deref().context("No current task is assigned")?;
        anyhow::ensure!(!id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "Invalid current task identity");
        let paths = QueuePaths::new(&self.queues_root);
        let mut found = None;
        for status in [TaskStatus::InProgress, TaskStatus::Incoming, TaskStatus::Completed, TaskStatus::Failed] {
            let file = paths.status_dir(status).join(format!("{id}.json"));
            if !file.try_exists()? { continue; }
            let mut task = read_task(&file)?;
            anyhow::ensure!(task.id == id, "Task identity does not match its queue file");
            anyhow::ensure!(found.is_none(), "Current task appears in multiple queues");
            task.status = status;
            found = Some(task);
        }
        found.context("Current task not found in any queue")
    }
    fn register_pr(&self, args: &Value) -> Result<Value> {
        let id = self.current_task_id.as_deref().context("No current task")?;
        let agent = self.current_agent.as_deref().context("No current agent")?;
        anyhow::ensure!(!agent.starts_with("pr-updater") && agent != "pr-reviewer", "A reviewer or generic updater is not an original creator");
        let task = read_task(QueuePaths::new(&self.queues_root).in_progress.join(format!("{id}.json")))?;
        anyhow::ensure!(task.agent == agent, "Current task belongs to another agent");
        let workspace = task.workspace.as_deref().context("Creator workspace is missing")?;
        let pr_id = args["pr_id"].as_str().context("pr_id is required")?;
        let url = args["url"].as_str().context("url is required")?;
        let branch = args["branch"].as_str().context("branch is required")?;
        anyhow::ensure!(!pr_id.is_empty() && pr_id.bytes().all(|c| c.is_ascii_digit()), "Invalid PR ID");
        anyhow::ensure!(url.starts_with("https://") && !branch.trim().is_empty(), "A PR URL and branch are required");
        let root = self.queues_root.parent().context("Spool root is missing")?;
        let prepared = task.metadata(root)?.context("PR registration requires prepared task metadata")?;
        anyhow::ensure!(prepared["preparation"]["ready"] == true && prepared["preparation"]["branch"] == branch,
            "PR registration must match this task's prepared branch");
        let dir = root.join(".runner-receipts").join("native-creators");
        std::fs::create_dir_all(&dir)?;
        let file = dir.join(format!("{id}.json"));
        if file.exists() {
            let existing: Value = serde_json::from_slice(&std::fs::read(&file)?)?;
            anyhow::ensure!(existing["prId"] == pr_id && existing["prUrl"] == url &&
                existing["branch"] == branch && existing["agent"] == agent,
                "A different original PR is already registered on this task");
            return Ok(existing);
        }
        let record = json!({ "verified": true, "originKind": "spool", "prId": pr_id, "prUrl": url,
            "branch": branch, "taskId": id, "agent": agent, "creatorName": agent,
            "workspace": workspace, "sessionId": task.session_id, "originalPrompt": task.prompt,
            "registeredAt": chrono::Utc::now() });
        write_json(file, &record)?;
        Ok(record)
    }
}
