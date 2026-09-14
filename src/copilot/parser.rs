use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CopilotUsageStats {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_write_tokens: u64,
    #[serde(default)]
    pub turns: u32,
}

pub fn parse_usage_json(content: &str) -> CopilotUsageStats {
    if let Ok(val) = serde_json::from_str::<Value>(content) {
        let input = val.get("input_tokens")
            .or_else(|| val.get("prompt_tokens"))
            .or_else(|| val.get("inputTokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        let output = val.get("output_tokens")
            .or_else(|| val.get("completion_tokens"))
            .or_else(|| val.get("outputTokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        let cache_read = val.get("cache_read_tokens")
            .or_else(|| val.get("cached_tokens"))
            .or_else(|| val.get("cacheReadTokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        let cache_write = val.get("cache_write_tokens")
            .or_else(|| val.get("cacheWriteTokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        let turns = val.get("turns")
            .or_else(|| val.get("turn_count"))
            .and_then(|v| v.as_u64())
            .unwrap_or(1) as u32;

        return CopilotUsageStats {
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cache_read,
            cache_write_tokens: cache_write,
            turns,
        };
    }
    CopilotUsageStats::default()
}

pub fn format_stream_event(line: &str) -> Option<String> {
    if let Ok(val) = serde_json::from_str::<Value>(line) {
        let event_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match event_type {
            "assistant.message" => {
                if let Some(content) = val.get("content").or_else(|| val.get("assistant_content")).and_then(|v| v.as_str()) {
                    return Some(format!("[AGENT] {}", content.trim()));
                }
            }
            "tool.execution_start" => {
                let name = val.get("tool_name").or_else(|| val.get("name")).and_then(|v| v.as_str()).unwrap_or("tool");
                return Some(format!("[TOOL START] {}", name));
            }
            "tool.execution_complete" => {
                let name = val.get("tool_name").or_else(|| val.get("name")).and_then(|v| v.as_str()).unwrap_or("tool");
                let success = val.get("success").and_then(|v| v.as_bool()).unwrap_or(true);
                return Some(format!("[TOOL END] {} (success: {})", name, success));
            }
            _ => {
                if let Some(msg) = val.get("message").and_then(|v| v.as_str()) {
                    return Some(msg.to_string());
                }
            }
        }
    }
    None
}
