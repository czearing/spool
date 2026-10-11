use anyhow::{Context, Result};
use std::{fs, path::{Path, PathBuf}};

fn path_field(header: &str, name: &str) -> Result<Option<PathBuf>> {
    let mut sources = header.lines().filter_map(|line| {
        let (key, value) = line.split_once(':')?;
        (key.trim() == name).then_some(value.trim())
    });
    let Some(source) = sources.next() else { return Ok(None); };
    anyhow::ensure!(sources.next().is_none(), "Duplicate {name} field");
    let file: String = serde_json::from_str(source).with_context(|| format!("{name} must be a JSON string"))?;
    let path = PathBuf::from(file);
    anyhow::ensure!(path.is_absolute(), "{name} must be an absolute path");
    Ok(Some(path))
}
fn reference(header: &str) -> Result<Option<PathBuf>> {
    let path = path_field(header, "shared_prompt")?;
    anyhow::ensure!(path.as_ref().is_none_or(|path| path.extension().is_some_and(|v| v == "md")),
        "Shared prompt reference must be an agent Markdown path");
    Ok(path)
}
pub fn default_workspace(header: &str) -> Result<Option<PathBuf>> { path_field(header, "default_workspace") }
pub fn working_directory(explicit: Option<&str>, default: Option<&Path>, resumed: bool) -> Result<Option<PathBuf>> {
    let workspace = explicit.map(Path::new).or_else(|| if resumed { None } else { default });
    if let Some(path) = workspace {
        anyhow::ensure!(path.is_absolute() && path.is_dir(), "Agent workspace is unavailable: {}", path.display());
    }
    Ok(workspace.map(Path::to_path_buf))
}
fn parts(source: &str) -> Result<(&str, &str)> {
    let text = source.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let mut lines = text.split_inclusive('\n');
    let first = lines.next().unwrap_or("");
    if first.trim() != "---" { return Ok(("", source)); }
    let start = first.len();
    let mut offset = start;
    for line in lines {
        if line.trim() == "---" { return Ok((&text[start..offset], &text[offset + line.len()..])); }
        offset += line.len();
    }
    anyhow::bail!("Shared agent frontmatter is missing its closing delimiter")
}
fn read_role(path: &Path, seen: &mut Vec<PathBuf>) -> Result<String> {
    let metadata = fs::symlink_metadata(path).context("Shared agent instructions are unavailable")?;
    anyhow::ensure!(metadata.file_type().is_file() && metadata.len() <= 131_072,
        "Shared instructions must be a regular file under 128 KiB");
    let canonical = fs::canonicalize(path)?;
    anyhow::ensure!(seen.len() < 8 && !seen.contains(&canonical), "Circular or excessively nested shared prompt reference");
    seen.push(canonical);
    let source = fs::read_to_string(path)?;
    let (header, body) = parts(&source)?;
    if let Some(parent) = reference(header)? { return read_role(&parent, seen); }
    anyhow::ensure!(!body.trim().is_empty() && !body.contains('\0'), "Shared instructions are empty or invalid");
    Ok(body.trim().to_owned())
}
pub fn resolve(header: &str, context: &str) -> Result<String> {
    let Some(path) = reference(header)? else { return Ok(context.trim().to_owned()); };
    let prompt = read_role(&path, &mut Vec::new())?;
    if context.trim().is_empty() { return Ok(prompt); }
    Ok(format!("{prompt}\n\n## Project-specific instructions\n\n\
        Project instructions override the shared role for this workspace.\n\n{}", context.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn shared_instructions_refresh_without_copying_project_context() -> Result<()> {
        let file = std::env::temp_dir().join(format!("spool-prompt-{}-{}.md",
            std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()));
        let header = format!("model: example\nshared_prompt: {}", json!(file.to_string_lossy()));
        fs::write(&file, "---\nmodel: source-model\n---\nShared role")?;
        let a = resolve(&header, "Repository A")?;
        let b = resolve(&header, "Repository B")?;
        assert!(a.starts_with("Shared role") && a.ends_with("Repository A"));
        assert!(b.ends_with("Repository B") && !b.contains("Repository A"));
        fs::write(&file, "Updated role")?;
        assert_eq!(resolve(&header, "")?, "Updated role");
        fs::remove_file(&file)?;
        assert!(resolve(&header, "").is_err());
        Ok(())
    }

    #[test]
    fn legacy_prompts_and_invalid_references() -> Result<()> {
        assert_eq!(resolve("model: example", " Legacy role ")?, "Legacy role");
        assert!(resolve("shared_prompt: \"relative.md\"", "").is_err());
        assert!(resolve("shared_prompt: not-json", "").is_err());
        assert!(resolve("shared_prompt: \"a\"\nshared_prompt: \"b\"", "").is_err());
        Ok(())
    }

    #[test]
    fn workspace_defaults_preserve_explicit_assignments_and_existing_sessions() -> Result<()> {
        let root = std::env::temp_dir();
        let header = format!("default_workspace: {}", json!(root.to_string_lossy()));
        assert_eq!(default_workspace(&header)?, Some(root.clone()));
        assert_eq!(working_directory(None, Some(&root), false)?, Some(root.clone()));
        assert_eq!(working_directory(None, Some(&root), true)?, None);
        let missing = root.join(format!("missing-{}", std::process::id()));
        assert_eq!(working_directory(root.to_str(), Some(&missing), false)?, Some(root.clone()));
        assert!(working_directory(None, Some(&missing), false).is_err());
        assert_eq!(working_directory(None, None, false)?, None);
        assert!(default_workspace("default_workspace: \"relative\"").is_err());
        assert!(default_workspace(&format!("{header}\n{header}")).is_err());
        Ok(())
    }

    #[test]
    fn nested_references_exclude_instance_context_and_reject_cycles() -> Result<()> {
        let base = std::env::temp_dir().join(format!("spool-chain-{}-{}",
            std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()));
        let origin = base.with_extension("md");
        let instance = base.with_extension("instance.md");
        let header = format!("shared_prompt: {}", json!(instance.to_string_lossy()));
        let linked = format!("---\nshared_prompt: {}\n---\nPrivate source context", json!(origin.to_string_lossy()));
        fs::write(&origin, "# Canonical role")?;
        fs::write(&instance, linked)?;
        let result = resolve(&header, "Destination only")?;
        assert!(result.starts_with("# Canonical role") && result.ends_with("Destination only"));
        assert!(!result.contains("Private source context"));
        fs::write(&origin, format!("---\n{header}\n---\nCycle"))?;
        assert!(resolve(&header, "").is_err());
        fs::write(&origin, "---\nmodel: missing-delimiter")?;
        assert!(resolve(&header, "").is_err());
        fs::write(&origin, " ")?;
        assert!(resolve(&header, "").is_err());
        fs::write(&origin, vec![b'a'; 131_073])?;
        assert!(resolve(&header, "").is_err());
        fs::remove_file(origin)?;
        fs::remove_file(instance)?;
        Ok(())
    }
}
