use std::path::{Path, PathBuf};
use anyhow::Result;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use crate::mcp::protocol::{JsonRpcRequest, JsonRpcResponse};
use crate::models::TaskStatus;
use crate::queue::fs::{atomic_move, read_task, write_task, AgentQueuePaths};

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

    pub async fn run_stdio(&self) -> Result<()> {
        let stdin = tokio::io::stdin();
        let mut stdout = tokio::io::stdout();
        let mut reader = BufReader::new(stdin).lines();

        while let Ok(Some(line)) = reader.next_line().await {
            let line = line.trim();
            if line.is_empty() { continue; }
            if let Ok(req) = serde_json::from_str::<JsonRpcRequest>(line) {
                let resp = self.handle_request(req).await;
                if let Some(resp) = resp {
                    let mut out = serde_json::to_string(&resp)?;
                    out.push('\n');
                    stdout.write_all(out.as_bytes()).await?;
                    stdout.flush().await?;
                }
            }
        }
        Ok(())
    }

    async fn handle_request(&self, req: JsonRpcRequest) -> Option<JsonRpcResponse> {
        let id = req.id.clone();
        match req.method.as_str() {
            "initialize" => Some(JsonRpcResponse::success(id, json!({
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "spool-mcp", "version": "0.1.0" }
            }))),
            "notifications/initialized" => None,
            "tools/list" => Some(JsonRpcResponse::success(id, json!({
                "tools": [
                    {
                        "name": "spool_update_task_status",
                        "description": "Update the status of the current task (completed, failed, or in_progress)",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "status": { "type": "string", "enum": ["completed", "failed", "in_progress"] },
                                "comment": { "type": "string", "description": "Summary of work done or progress" },
                                "error": { "type": "string", "description": "Error details if status is failed" }
                            },
                            "required": ["status"]
                        }
                    },
                    {
                        "name": "spool_get_task",
                        "description": "Get details of the current task work item",
                        "inputSchema": { "type": "object", "properties": {} }
                    },
                    {
                        "name": "spool_add_comment",
                        "description": "Add a progress comment to the current work item",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "comment": { "type": "string", "description": "Comment text" }
                            },
                            "required": ["comment"]
                        }
                    }
                ]
            }))),
            "tools/call" => {
                let params = req.params.unwrap_or(Value::Null);
                let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                let res = self.execute_tool(tool_name, args);
                Some(JsonRpcResponse::success(id, res))
            }
            _ => Some(JsonRpcResponse::error(id, -32601, "Method not found")),
        }
    }

    fn execute_tool(&self, name: &str, args: Value) -> Value {
        let agent = self.current_agent.as_deref().unwrap_or("default");
        let task_id = self.current_task_id.as_deref();
        let paths = AgentQueuePaths::new(&self.queues_root, agent);

        match name {
            "spool_get_task" => {
                if let Some(tid) = task_id {
                    let in_prog_file = paths.in_progress.join(format!("{}.json", tid));
                    if let Ok(task) = read_task(&in_prog_file) {
                        return json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&task).unwrap_or_default() }] });
                    }
                }
                json!({ "isError": true, "content": [{ "type": "text", "text": "No active task found" }] })
            }
            "spool_update_task_status" => {
                let status_str = args.get("status").and_then(|v| v.as_str()).unwrap_or("completed");
                let comment = args.get("comment").and_then(|v| v.as_str());
                let err = args.get("error").and_then(|v| v.as_str());

                if let Some(tid) = task_id {
                    let in_prog_file = paths.in_progress.join(format!("{}.json", tid));
                    if let Ok(mut task) = read_task(&in_prog_file) {
                        if let Some(c) = comment { task.add_comment(format!("agent:{}", agent), c); }
                        if let Some(e) = err { task.error = Some(e.to_string()); }
                        
                        let target_status = match status_str {
                            "failed" => TaskStatus::Failed,
                            "in_progress" => TaskStatus::InProgress,
                            _ => TaskStatus::Completed,
                        };
                        task.status = target_status;
                        
                        let dest = paths.status_dir(target_status).join(format!("{}.json", tid));
                        let _ = write_task(&in_prog_file, &task);
                        if target_status != TaskStatus::InProgress {
                            let _ = atomic_move(&in_prog_file, &dest);
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
                        let _ = write_task(&in_prog_file, &task);
                        return json!({ "content": [{ "type": "text", "text": "Comment added successfully" }] });
                    }
                }
                json!({ "isError": true, "content": [{ "type": "text", "text": "Task not found" }] })
            }
            _ => json!({ "isError": true, "content": [{ "type": "text", "text": format!("Unknown tool: {}", name) }] }),
        }
    }
}
