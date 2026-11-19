use crate::mcp::protocol::{JsonRpcRequest, JsonRpcResponse};
use crate::models::{Task, TaskStatus};
use crate::queue::fs::{atomic_move, read_task, write_json, write_task, QueuePaths, TaskGuard};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
fn tool_error(error: anyhow::Error) -> Value {
    json!({ "isError": true, "content": [{ "type": "text", "text": format!("{error:#}") }] })
}
#[path = "agent_tools.rs"]
mod agent_tools;
#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
#[path = "server_protocol.rs"]
mod transport;
pub struct McpServer {
    queues_root: PathBuf,
    current_agent: Option<String>,
    current_task_id: Option<String>,
}
impl McpServer {
    pub fn new(
        queues_root: impl AsRef<Path>,
        agent: Option<String>,
        task_id: Option<String>,
    ) -> Self {
        Self {
            queues_root: queues_root.as_ref().to_path_buf(),
            current_agent: agent,
            current_task_id: task_id,
        }
    }
    fn execute_tool(&self, name: &str, args: Value) -> Value {
        if [
            "spool_create_agent",
            "spool_update_agent",
            "spool_get_agent",
            "spool_list_agents",
        ]
        .contains(&name)
        {
            return self.agent_tool(name, args);
        }
        let agent = self.current_agent.as_deref().unwrap_or("default");
        let task_id = self.current_task_id.as_deref();
        let paths = QueuePaths::new(&self.queues_root);
        let _guard = match task_id
            .map(|id| TaskGuard::acquire(&self.queues_root, id))
            .transpose()
        {
            Ok(guard) => guard,
            Err(error) => return tool_error(error),
        };
        match name {
            "spool_get_task" => {
                match self
                    .read_current_task()
                    .and_then(|task| Ok(serde_json::to_string_pretty(&task)?))
                {
                    Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
                    Err(error) => tool_error(error),
                }
            }
            "spool_update_task_status" => {
                if args.as_object().is_none_or(|args| {
                    args.keys()
                        .any(|key| !matches!(key.as_str(), "status" | "error" | "reassign_to"))
                }) {
                    return tool_error(anyhow::anyhow!(
                        "Status updates accept only status, error and reassign_to"
                    ));
                }
                let Some(status_str) = args.get("status").and_then(|v| v.as_str()) else {
                    return tool_error(anyhow::anyhow!("An explicit task status is required"));
                };
                let reassign_to = args.get("reassign_to").and_then(|v| v.as_str());
                let err = args.get("error").and_then(|v| v.as_str());
                if let Some(tid) = task_id {
                    let current = match self.read_current_task() {
                        Ok(task) => task,
                        Err(error) => return tool_error(error),
                    };
                    if current.agent != agent
                        || current.status != TaskStatus::InProgress
                            && current.interaction.phase != "running"
                    {
                        return tool_error(anyhow::anyhow!(
                            "Current task is not running for this agent"
                        ));
                    }
                    let task_file = paths
                        .status_dir(current.status)
                        .join(format!("{}.json", tid));
                    {
                        let mut task = current;
                        if let Some(new_agent) = reassign_to {
                            task.interaction.handoff = Some(crate::models::task::OperatorHandoff {
                                id: uuid::Uuid::new_v4().to_string(),
                                agent: new_agent.to_string(),
                                message: "Handing off task".into(),
                            });
                            crate::engine::operator::apply_handoff(&mut task);
                            let dest = paths.incoming.join(format!("{}.json", tid));
                            if let Err(error) = write_task(&task_file, &task).and_then(|_| {
                                if task_file == dest {
                                    Ok(())
                                } else {
                                    atomic_move(&task_file, &dest)
                                }
                            }) {
                                return tool_error(error);
                            }
                            return json!({ "content": [{ "type": "text", "text": format!("Handed off task {} to {}", tid, new_agent) }] });
                        }
                        let target_status = match status_str {
                            "failed" => TaskStatus::Failed,
                            "in_progress" => TaskStatus::InProgress,
                            "incoming" => TaskStatus::Incoming,
                            "completed" => TaskStatus::Completed,
                            _ => {
                                return tool_error(anyhow::anyhow!(
                                    "Invalid task status: {status_str}"
                                ))
                            }
                        };
                        let root = match self.queues_root.parent() {
                            Some(root) => root,
                            None => return tool_error(anyhow::anyhow!("Spool root is missing")),
                        };
                        if let Err(error) = crate::engine::task_result::update(
                            root,
                            &mut task,
                            agent,
                            target_status,
                            None,
                            err,
                        ) {
                            return tool_error(error);
                        }

                        let dest = paths
                            .status_dir(target_status)
                            .join(format!("{}.json", tid));
                        if let Err(error) = write_task(&task_file, &task).and_then(|_| {
                            if task_file == dest {
                                Ok(())
                            } else {
                                atomic_move(&task_file, &dest)
                            }
                        }) {
                            return tool_error(error);
                        }
                        return json!({ "content": [{ "type": "text", "text": format!("Task status updated to {}", target_status) }] });
                    }
                }
                json!({ "isError": true, "content": [{ "type": "text", "text": "Failed to update task" }] })
            }
            "spool_create_task" => {
                let target_agent = args
                    .get("agent")
                    .and_then(|v| v.as_str())
                    .unwrap_or("software-engineer");
                let title = args
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Delegated Task");
                let prompt = args.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
                let ws = args
                    .get("workspace")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if let Err(error) =
                    spool_agent_prompts::working_directory(ws.as_deref(), None, false)
                {
                    return tool_error(error);
                }

                let new_id = format!(
                    "TASK-{}",
                    &uuid::Uuid::new_v4().to_string()[..8].to_uppercase()
                );
                let mut new_task = crate::models::Task::new(&new_id, target_agent, title, prompt);
                new_task.workspace = ws;
                new_task.add_comment(
                    format!("delegated_by:{}", agent),
                    format!("Created by {} from task {:?}", agent, task_id),
                );

                let target_file = paths.incoming.join(format!("{}.json", new_id));
                if write_task(&target_file, &new_task).is_ok() {
                    json!({ "content": [{ "type": "text", "text": format!("Delegated task {} to {} successfully", new_id, target_agent) }] })
                } else {
                    json!({ "isError": true, "content": [{ "type": "text", "text": "Failed to create task file" }] })
                }
            }
            _ => {
                json!({ "isError": true, "content": [{ "type": "text", "text": format!("Unknown tool: {}", name) }] })
            }
        }
    }
    fn read_current_task(&self) -> Result<Task> {
        let id = self
            .current_task_id
            .as_deref()
            .context("No current task is assigned")?;
        anyhow::ensure!(
            !id.is_empty()
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "Invalid current task identity"
        );
        let paths = QueuePaths::new(&self.queues_root);
        let mut found = None;
        for status in [
            TaskStatus::InProgress,
            TaskStatus::Incoming,
            TaskStatus::Completed,
            TaskStatus::Failed,
        ] {
            let file = paths.status_dir(status).join(format!("{id}.json"));
            if !file.try_exists()? {
                continue;
            }
            let mut task = read_task(&file)?;
            anyhow::ensure!(task.id == id, "Task identity does not match its queue file");
            anyhow::ensure!(found.is_none(), "Current task appears in multiple queues");
            task.status = status;
            found = Some(task);
        }
        found.context("Current task not found in any queue")
    }
}
