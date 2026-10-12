use std::{fs, io::{Error, ErrorKind, Write}, path::{Path, PathBuf}};
use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use super::{agent::{frontmatter, scalar, ICONS}, AgentConfig};

fn one() -> Option<usize> { Some(1) }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentWrite {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    image: Option<String>,
    #[serde(default = "one")]
    max_concurrent_runs: Option<usize>,
    prompt: Option<String>,
    revision: Option<String>,
}
pub fn revision(source: &str) -> String { format!("{:x}", Sha256::digest(source.as_bytes())) }
fn conflict(message: &str) -> anyhow::Error { Error::new(ErrorKind::AlreadyExists, message).into() }
fn agent_path(root: &Path, name: &str) -> Result<PathBuf> {
    anyhow::ensure!(!name.is_empty() && name.len() <= 120 &&
        name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'), "Invalid agent name");
    let reserved = name.to_ascii_uppercase();
    anyhow::ensure!(!["CON", "PRN", "AUX", "NUL"].contains(&reserved.as_str()) &&
        !(reserved.len() == 4 && (reserved.starts_with("COM") || reserved.starts_with("LPT")) &&
          reserved.as_bytes()[3].is_ascii_digit()), "Reserved agent name");
    let directory = root.join("agents");
    fs::create_dir_all(&directory)?;
    anyhow::ensure!(fs::symlink_metadata(&directory)?.file_type().is_dir(), "Agent folder must be a regular directory");
    Ok(directory.join(format!("{name}.md")))
}
pub fn source(root: &Path, name: &str) -> Result<(PathBuf, String)> {
    let file = agent_path(root, name)?;
    let metadata = fs::symlink_metadata(&file)?;
    anyhow::ensure!(metadata.file_type().is_file() && metadata.len() <= 131_072, "Agent must be a regular UTF-8 file under 128 KiB");
    Ok((file.clone(), fs::read_to_string(file)?))
}
pub fn get(root: &Path, name: &str) -> Result<Value> {
    let (file, source) = source(root, name)?;
    let default_model = super::project::default_model(root)?;
    let agent = AgentConfig::parse_with_default(name, &source, file, default_model.clone())?;
    let mut model = None;
    for line in frontmatter(&source)?.0.lines() {
        if let Some((key, value)) = line.split_once(':') {
            if key.trim() == "model" {
                let value = scalar(value)?;
                if !value.is_empty() { model = Some(value); }
            }
        }
    }
    Ok(json!({ "name": name, "description": agent.description, "model": model,
        "defaultModel": default_model, "defaultWorkspace": agent.default_workspace, "icon": agent.icon, "image": super::agent_image::read(&source)?,
        "maxConcurrentRuns": agent.max_concurrent_runs, "revision": revision(&source) }))
}
pub fn list(root: &Path) -> Result<Value> {
    let directory = root.join("agents");
    let mut agents = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.path().extension().is_some_and(|v| v == "md") {
            agents.push(get(root, entry.path().file_stem().and_then(|s| s.to_str()).context("Invalid agent filename")?)?);
        }
    }
    agents.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(json!(agents))
}
pub fn save(root: &Path, args: Value, create: bool) -> Result<Value> {
    if !create {
        for key in ["model", "max_concurrent_runs", "revision"] {
            anyhow::ensure!(args.get(key).is_some(), "Agent settings require {key}");
        }
    }
    let image_set = args.get("image").is_some();
    let input: AgentWrite = serde_json::from_value(args)?;
    anyhow::ensure!(input.description.as_ref().is_none_or(|v| v.len() <= 240 && !v.contains(['\n', '\r', '\0'])), "Invalid description");
    anyhow::ensure!(input.icon.as_ref().is_none_or(|v| ICONS.contains(&v.as_str())), "Invalid agent icon");
    if let Some(image) = &input.image { super::agent_image::validate(image)?; }
    anyhow::ensure!(input.model.as_ref().is_none_or(|m| super::project::valid_model(m)), "Invalid agent model");
    anyhow::ensure!(input.max_concurrent_runs.is_none_or(|n| n > 0 && n <= 9_007_199_254_740_991), "Run limit must be a positive safe integer or null");
    let file = agent_path(root, &input.name)?;
    let lock_path = file.with_extension("md.lock");
    let lock = fs::OpenOptions::new().write(true).create_new(true).open(&lock_path)?;
    let temporary = file.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let (old, body) = if create {
            anyhow::ensure!(input.revision.is_none(), "Creation cannot include a revision");
            if file.try_exists()? { return Err(conflict("Agent already exists")); }
            let prompt = input.prompt.as_deref().context("Agent instructions are required")?;
            anyhow::ensure!(!prompt.contains('\0') && prompt.len() <= 120_000, "Invalid agent instructions");
            (String::new(), prompt.to_owned())
        } else {
            anyhow::ensure!(input.prompt.is_none(), "Use the prompt editor to change instructions");
            let (_, old) = source(root, &input.name)?;
            if Some(revision(&old)).as_ref() != input.revision.as_ref() { return Err(conflict("Agent changed. Reload before saving.")); }
            let body = frontmatter(&old)?.1.to_owned();
            (old, body)
        };
        let newline = if old.contains("\r\n") { "\r\n" } else { "\n" };
        let mut fields = String::new();
        for line in frontmatter(&old)?.0.lines() {
            if !line.split_once(':').is_some_and(|(key, _)|
                ["model", "max_concurrent_runs"].contains(&key.trim()) ||
                key.trim() == "description" && input.description.is_some() ||
                key.trim() == "icon" && input.icon.is_some() || key.trim() == "image" && image_set) {
                fields.push_str(line); fields.push_str(newline);
            }
        }
        for (key, value) in [("description", input.description.as_ref()), ("icon", input.icon.as_ref()),
            ("image", input.image.as_ref())] {
            if let Some(value) = value { fields.push_str(&format!("{key}: {}{newline}", json!(value))); }
        }
        fields.push_str(&format!("max_concurrent_runs: {}{newline}", json!(input.max_concurrent_runs)));
        if let Some(model) = &input.model { fields.push_str(&format!("model: {}{newline}", json!(model))); }
        let content = format!("---{newline}{fields}---{newline}{body}");
        anyhow::ensure!(content.len() <= 131_072, "Agent exceeds 128 KiB");
        AgentConfig::parse(&input.name, &content, file.clone())?;
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        output.write_all(content.as_bytes())?;
        output.sync_all()?;
        drop(output);
        if create { fs::hard_link(&temporary, &file)?; }
        else {
            if source(root, &input.name)?.1 != old { return Err(conflict("Agent changed while saving")); }
            fs::set_permissions(&temporary, fs::metadata(&file)?.permissions())?;
            fs::rename(&temporary, &file)?;
        }
        get(root, &input.name)
    })();
    drop(lock);
    let cleanup = match fs::remove_file(&temporary) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        result => result,
    };
    let unlock = fs::remove_file(lock_path);
    cleanup.context("Cannot clean agent temporary file")?;
    unlock.context("Cannot remove agent lock")?;
    result
}
