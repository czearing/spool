use super::*;

impl McpServer {
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

    pub(super) async fn handle_request(&self, req: JsonRpcRequest) -> Option<JsonRpcResponse> {
        let id = req.id.clone();
        match req.method.as_str() {
            "initialize" => Some(JsonRpcResponse::success(id, json!({
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "spool-mcp", "version": "0.1.0" }
            }))),
            "notifications/initialized" => None,
            "tools/list" => {
                let mut result = json!({
                "tools": [
                    {
                        "name": "spool_update_task_status",
                        "description": "Update task status (completed, failed, in_progress, incoming) or hand off to another agent. A normal successful response defaults to completed without this call; required verification still applies. Use failed only for a genuine failure, not an ordinary conversation, clarification question or missing status call.",
                        "inputSchema": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "status": { "type": "string", "enum": ["completed", "failed", "in_progress", "incoming"] },
                                "reassign_to": { "type": "string", "description": "Target agent name if handing off this work item (e.g. prompt-engineer, software-engineer)" },
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
                        "name": "spool_create_task",
                        "description": "Delegate or create a new work item for another agent",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "agent": { "type": "string", "description": "Target agent name (e.g. software-engineer, pr-reviewer, pr-updater)" },
                                "title": { "type": "string", "description": "Short title of the task" },
                                "prompt": { "type": "string", "description": "Detailed prompt and requirements for the task" },
                                "workspace": { "type": "string", "description": "Optional workspace directory path" }
                            },
                            "required": ["agent", "title", "prompt"]
                        }
                    }
                ]
                });
                result["tools"].as_array_mut().unwrap().extend(super::agent_tools::schemas());
                Some(JsonRpcResponse::success(id, result))
            },
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

}
