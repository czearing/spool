use std::path::{Path, PathBuf};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub name: String,
    pub description: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    pub system_prompt: String,
    #[serde(skip)]
    pub path: PathBuf,
}

fn default_model() -> String {
    "gpt-5.4".to_string()
}

impl AgentConfig {
    pub fn from_file(path: impl AsRef<Path>) -> Result<Self> {
        let path_ref = path.as_ref();
        let content = std::fs::read_to_string(path_ref)
            .with_context(|| format!("Failed to read agent prompt file: {:?}", path_ref))?;
        
        let stem = path_ref.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("agent")
            .to_string();

        Self::parse(&stem, &content, path_ref.to_path_buf())
    }

    pub fn parse(name: &str, content: &str, path: PathBuf) -> Result<Self> {
        let trimmed = content.trim();
        if trimmed.starts_with("---") {
            if let Some(end_idx) = trimmed[3..].find("---") {
                let header = &trimmed[3..3 + end_idx];
                let body = trimmed[3 + end_idx + 3..].trim();
                
                let mut model = default_model();
                let mut reasoning_effort: Option<String> = None;
                let mut desc = format!("Agent {}", name);
                let mut tools = Vec::new();

                for line in header.lines() {
                    let line = line.trim();
                    if let Some((k, v)) = line.split_once(':') {
                        let k = k.trim();
                        let v = v.trim().trim_matches('"').trim_matches('\'');
                        match k {
                            "model" => model = v.to_string(),
                            "reasoning_effort" | "reasoning" => reasoning_effort = Some(v.to_string()),
                            "description" => desc = v.to_string(),
                            "tools" => {
                                tools = v.split(',')
                                    .map(|s| s.trim().to_string())
                                    .filter(|s| !s.is_empty())
                                    .collect();
                            }
                            _ => {}
                        }
                    }
                }

                return Ok(Self {
                    name: name.to_string(),
                    description: desc,
                    model,
                    reasoning_effort,
                    tools,
                    system_prompt: body.to_string(),
                    path,
                });
            }
        }

        Ok(Self {
            name: name.to_string(),
            description: format!("Agent {}", name),
            model: default_model(),
            reasoning_effort: None,
            tools: Vec::new(),
            system_prompt: content.to_string(),
            path,
        })
    }
}
