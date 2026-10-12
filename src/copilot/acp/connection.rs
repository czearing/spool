use super::*;

pub(super) struct Connection {
    pub(super) input: ChildStdin,
    pub(super) output: tokio::io::Lines<BufReader<ChildStdout>>,
    pub(super) log: fs::File,
    pub(super) next_id: u64,
}

impl Connection {
    pub(super) async fn send(&mut self, value: Value) -> Result<()> {
        self.input.write_all(format!("{value}\n").as_bytes()).await?;
        self.input.flush().await?;
        Ok(())
    }
    pub(super) async fn request(&mut self, method: &str, params: Value) -> Result<u64> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await?;
        Ok(id)
    }
    pub(super) fn event(&mut self, kind: &str, data: Value) -> Result<()> {
        writeln!(self.log, "{}", json!({ "type": kind, "timestamp": chrono::Utc::now(), "data": data }))?;
        self.log.flush()?;
        Ok(())
    }
    pub(super) async fn incoming(&mut self, value: &Value, replay: bool) -> Result<()> {
        if value["method"] == "session/request_permission" {
            let selected = value["params"]["options"].as_array().and_then(|options|
                options.iter().find(|option| option["kind"] == "allow_once")).map(|option| option["optionId"].clone());
            let outcome = selected.map(|id| json!({ "outcome": "selected", "optionId": id }))
                .unwrap_or_else(|| json!({ "outcome": "cancelled" }));
            self.send(json!({ "jsonrpc": "2.0", "id": value["id"], "result": { "outcome": outcome } })).await?;
        } else if value.get("method").is_some() && value.get("id").is_some() {
            self.send(json!({ "jsonrpc": "2.0", "id": value["id"], "error": { "code": -32601, "message": "Client method is not supported" } })).await?;
        } else if value["method"] == "session/update" && !replay {
            let update = &value["params"]["update"];
            match update["sessionUpdate"].as_str().unwrap_or("") {
                "agent_message_chunk" if update["content"]["type"] == "text" => {
                    self.event("assistant.message_delta", json!({ "content": update["content"]["text"] }))?;
                }
                "tool_call" => self.event("tool.execution_start", json!({
                    "toolCallId": update["toolCallId"], "toolName": update["title"], "arguments": update["rawInput"],
                }))?,
                "tool_call_update" if update["status"] == "completed" || update["status"] == "failed" => {
                    self.event("tool.execution_complete", json!({
                        "toolCallId": update["toolCallId"], "success": update["status"] == "completed",
                        "result": update.get("rawOutput").cloned().unwrap_or_else(|| update["content"].clone()),
                    }))?;
                }
                "tool_call_update" => self.event("tool.execution_progress", json!({
                    "toolCallId": update["toolCallId"], "title": update["title"],
                    "arguments": update["rawInput"], "status": update["status"],
                }))?,
                "plan" => self.event("session.plan", json!({ "entries": update["entries"] }))?,
                _ => {}
            }
        }
        Ok(())
    }
    pub(super) async fn call(&mut self, method: &str, params: Value, replay: bool) -> Result<Value> {
        let id = self.request(method, params).await?;
        timeout(Duration::from_secs(120), async {
            loop {
                let line = self.output.next_line().await?.context("Copilot ACP closed its output")?;
                let value: Value = serde_json::from_str(&line).context("Invalid ACP response")?;
                if value["id"].as_u64() == Some(id) {
                    anyhow::ensure!(value.get("error").is_none(), "ACP {method} failed: {}", value["error"]);
                    return Ok(value["result"].clone());
                }
                self.incoming(&value, replay).await?;
            }
        }).await.context("Copilot ACP setup timed out")?
    }
}
