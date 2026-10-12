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
    #[serde(default)]
    pub default_workspace: Option<PathBuf>,
    #[serde(default = "default_icon")]
    pub icon: String,
    #[serde(default)]
    pub max_concurrent_runs: Option<usize>,
    #[serde(skip)]
    pub concurrency_explicit: bool,
    pub system_prompt: String,
    #[serde(skip)]
    pub path: PathBuf,
}

fn default_model() -> String {
    super::project::DEFAULT_MODEL.to_string()
}
pub fn default_icon() -> String { "bot".into() }
pub const ICONS: &[&str] = &["bot", "code", "search", "shield", "pen-tool", "chart-line",
    "bug", "flask-conical", "workflow", "lightbulb", "terminal", "book-open"];

pub fn frontmatter(source: &str) -> Result<(&str, &str)> {
    let text = source.trim_start();
    let mut lines = text.split_inclusive('\n');
    let first = lines.next().unwrap_or("");
    if first.trim() != "---" { return Ok(("", source)); }
    let start = first.len();
    let mut offset = start;
    for line in lines {
        if line.trim() == "---" { return Ok((&text[start..offset], &text[offset + line.len()..])); }
        offset += line.len();
    }
    anyhow::bail!("Agent frontmatter is missing its closing delimiter")
}

pub fn scalar(value: &str) -> Result<String> {
    let value = value.trim();
    if value.starts_with('"') { return Ok(serde_json::from_str(value)?); }
    Ok(value.trim_matches('\'').to_owned())
}

impl AgentConfig {
    pub fn pause_path(root: &Path, agent: &str) -> Result<PathBuf> {
        anyhow::ensure!(!agent.is_empty() && agent.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
            "Invalid agent name");
        Ok(root.join("controls").join("paused").join(agent))
    }

    pub fn is_paused(root: &Path, agent: &str) -> Result<bool> {
        Ok(Self::pause_path(root, agent)?.try_exists()?)
    }

    pub fn from_file(path: impl AsRef<Path>) -> Result<Self> {
        let path_ref = path.as_ref();
        let content = std::fs::read_to_string(path_ref)
            .with_context(|| format!("Failed to read agent prompt file: {:?}", path_ref))?;
        
        let stem = path_ref.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("agent")
            .to_string();

        let root = path_ref.parent().and_then(Path::parent).context("Agent has no project root")?;
        Self::parse_with_default(&stem, &content, path_ref.to_path_buf(), super::project::default_model(root)?)
    }

    pub fn parse(name: &str, content: &str, path: PathBuf) -> Result<Self> {
        Self::parse_with_default(name, content, path, default_model())
    }

    pub(crate) fn parse_with_default(name: &str, content: &str, path: PathBuf, inherited: String) -> Result<Self> {
        let (header, body) = frontmatter(content)?;
        if !header.is_empty() {
                
                let mut model = inherited;
                let mut reasoning_effort: Option<String> = None;
                let mut desc = format!("Agent {}", name);
                let mut tools = Vec::new();
                let mut icon = default_icon();
                let mut max_concurrent_runs = Some(1);
                let mut seen = std::collections::HashSet::new();

                for line in header.lines() {
                    let line = line.trim();
                    if let Some((k, v)) = line.split_once(':') {
                        let k = k.trim();
                        if ["model", "description", "icon", "max_concurrent_runs"].contains(&k) {
                            anyhow::ensure!(seen.insert(k), "Duplicate agent field: {k}");
                        }
                        let value = scalar(v)?;
                        let v = value.as_str();
                        match k {
                            "model" if !v.is_empty() => {
                                anyhow::ensure!(super::project::valid_model(v), "Invalid agent model");
                                model = v.to_string();
                            }
                            "reasoning_effort" | "reasoning" => reasoning_effort = Some(v.to_string()),
                            "description" => desc = v.to_string(),
                            "icon" => {
                                anyhow::ensure!(ICONS.contains(&v), "Invalid agent icon");
                                icon = v.to_owned();
                            }
                            "max_concurrent_runs" => {
                                max_concurrent_runs = if v == "null" || v == "unlimited" { None }
                                    else { Some(v.parse::<usize>().context("Invalid max_concurrent_runs")?) };
                                anyhow::ensure!(max_concurrent_runs.is_none_or(|n| n > 0 && n <= 9_007_199_254_740_991),
                                    "max_concurrent_runs must be a positive safe integer or null");
                            }
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
                    default_workspace: spool_agent_prompts::default_workspace(header)?,
                    icon,
                    max_concurrent_runs,
                    concurrency_explicit: seen.contains("max_concurrent_runs"),
                    system_prompt: spool_agent_prompts::resolve(header, body)?,
                    path,
                });
        }

        Ok(Self {
            name: name.to_string(),
            description: format!("Agent {}", name),
            model: inherited,
            reasoning_effort: None,
            tools: Vec::new(),
            default_workspace: None,
            icon: default_icon(),
            max_concurrent_runs: Some(1),
            concurrency_explicit: false,
            system_prompt: body.to_string(),
            path,
        })
    }
}
