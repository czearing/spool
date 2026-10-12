use anyhow::{Context, Result};
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
        return parse_usage_value(&val);
    }
    CopilotUsageStats::default()
}

fn parse_usage_value(val: &Value) -> CopilotUsageStats {
    if let Some(details) = val.get("tokenDetails").and_then(Value::as_object) {
        let count = |name: &str| {
            details
                .get(name)
                .and_then(|value| value.get("tokenCount"))
                .and_then(Value::as_u64)
                .unwrap_or(0)
        };
        let cache_read_tokens = count("cache_read");
        let cache_write_tokens = count("cache_write");
        return CopilotUsageStats {
            input_tokens: count("input") + cache_read_tokens + cache_write_tokens,
            output_tokens: count("output"),
            cache_read_tokens,
            cache_write_tokens,
            turns: val
                .get("totalUserRequests")
                .and_then(Value::as_u64)
                .unwrap_or(1) as u32,
        };
    }
    let input = val
        .get("input_tokens")
        .or_else(|| val.get("prompt_tokens"))
        .or_else(|| val.get("inputTokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let output = val
        .get("output_tokens")
        .or_else(|| val.get("completion_tokens"))
        .or_else(|| val.get("outputTokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let cache_read = val
        .get("cache_read_tokens")
        .or_else(|| val.get("cached_tokens"))
        .or_else(|| val.get("cacheReadTokens"))
        .or_else(|| val.get("cachedReadTokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let cache_write = val
        .get("cache_write_tokens")
        .or_else(|| val.get("cacheWriteTokens"))
        .or_else(|| val.get("cachedWriteTokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let turns = val
        .get("turns")
        .or_else(|| val.get("turn_count"))
        .and_then(|v| v.as_u64())
        .unwrap_or(1) as u32;

    CopilotUsageStats {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        turns,
    }
}

pub fn parse_usage_delta(content: &str, previous: Option<&str>) -> Result<CopilotUsageStats> {
    let current: Value = serde_json::from_str(content).context("Invalid Copilot usage report")?;
    let mut usage = parse_usage_value(&current);
    if let Some(previous) = previous {
        let previous: Value =
            serde_json::from_str(previous).context("Invalid previous Copilot usage report")?;
        let same_session = current
            .get("sessionStartTime")
            .and_then(Value::as_str)
            .is_some_and(|start| {
                previous.get("sessionStartTime").and_then(Value::as_str) == Some(start)
            });
        if same_session
            && current.get("tokenDetails").is_some()
            && previous.get("tokenDetails").is_some()
        {
            let baseline = parse_usage_value(&previous);
            for (value, before, name) in [
                (&mut usage.input_tokens, baseline.input_tokens, "input"),
                (&mut usage.output_tokens, baseline.output_tokens, "output"),
                (
                    &mut usage.cache_read_tokens,
                    baseline.cache_read_tokens,
                    "cache read",
                ),
                (
                    &mut usage.cache_write_tokens,
                    baseline.cache_write_tokens,
                    "cache write",
                ),
            ] {
                *value = value.checked_sub(before).with_context(|| {
                    format!("Copilot cumulative {name} usage decreased within the same session")
                })?;
            }
        }
    }
    Ok(usage)
}

#[cfg(test)]
#[path = "parser_tests.rs"]
mod tests;

pub fn format_stream_event(line: &str) -> Option<String> {
    if let Ok(val) = serde_json::from_str::<Value>(line) {
        let event_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match event_type {
            "assistant.message" => {
                if let Some(content) = val
                    .get("content")
                    .or_else(|| val.get("assistant_content"))
                    .and_then(|v| v.as_str())
                {
                    return Some(format!("[AGENT] {}", content.trim()));
                }
            }
            "tool.execution_start" => {
                let name = val
                    .get("tool_name")
                    .or_else(|| val.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool");
                return Some(format!("[TOOL START] {}", name));
            }
            "tool.execution_complete" => {
                let name = val
                    .get("tool_name")
                    .or_else(|| val.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool");
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
