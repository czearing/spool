use super::*;
use crate::models::{agent::ICONS, agent_store};

pub(super) fn schemas() -> Vec<Value> {
    let mut properties = json!({
        "name": { "type": "string", "description": "Unique agent ID (letters, digits, hyphens or underscores)" },
        "description": { "type": "string", "maxLength": 240 },
        "model": { "type": ["string", "null"], "description": "Null inherits the project default" },
        "icon": { "type": "string", "enum": ICONS },
        "image": { "type": ["string", "null"], "maxLength": 65536,
            "description": "PNG, JPEG or WebP base64 data URL. Null removes the image; omission preserves it." },
        "max_concurrent_runs": { "type": ["integer", "null"], "minimum": 1,
            "maximum": 9007199254740991_u64, "description": "Null means unlimited. Workspace and session ownership remain exclusive." }
    });
    let get = json!({ "name": "spool_get_agent", "description": "Read persistent agent settings and their revision",
        "inputSchema": { "type": "object", "properties": { "name": { "type": "string" } },
            "required": ["name"], "additionalProperties": false } });
    let list = json!({ "name": "spool_list_agents", "description": "List configured agents and their native settings",
        "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false } });
    properties["prompt"] = json!({ "type": "string", "description": "System instructions for the new agent" });
    let create = json!({ "name": "spool_create_agent",
        "description": "Create an agent without overwriting existing work. Discovered live by Spool; defaults to one concurrent run.",
        "inputSchema": { "type": "object", "properties": properties.clone(),
            "required": ["name", "prompt"], "additionalProperties": false } });
    properties.as_object_mut().unwrap().remove("prompt");
    properties["revision"] = json!({ "type": "string", "description": "Revision from spool_get_agent; stale edits are rejected" });
    let update = json!({ "name": "spool_update_agent",
        "description": "Save agent settings. Limits affect new admissions, never cancel active runs. Keep the current revision.",
        "inputSchema": { "type": "object", "properties": properties,
            "required": ["name", "model", "max_concurrent_runs", "revision"], "additionalProperties": false } });
    vec![get, list, create, update]
}
impl McpServer {
    pub(super) fn agent_tool(&self, name: &str, args: Value) -> Value {
        let result = (|| {
            let root = self.queues_root.parent().context("Spool root is missing")?;
            match name {
                "spool_create_agent" => agent_store::save(root, args, true),
                "spool_update_agent" => agent_store::save(root, args, false),
                "spool_get_agent" => agent_store::get(root, args["name"].as_str().context("Agent name is required")?),
                "spool_list_agents" => agent_store::list(root),
                _ => anyhow::bail!("Unknown agent tool"),
            }
        })();
        match result {
            Ok(value) => json!({ "structuredContent": value, "content": [{ "type": "text", "text": value.to_string() }] }),
            Err(error) => {
                let status = match error.downcast_ref::<std::io::Error>().map(|e| e.kind()) {
                    Some(std::io::ErrorKind::AlreadyExists) => 409,
                    Some(std::io::ErrorKind::NotFound) => 404,
                    Some(_) => 503,
                    None => 400,
                };
                json!({ "isError": true, "structuredContent": { "status": status },
                    "content": [{ "type": "text", "text": format!("{error:#}") }] })
            }
        }
    }
}
