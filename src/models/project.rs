use std::path::Path;
use anyhow::{Context, Result};
use serde::Deserialize;

pub const DEFAULT_MODEL: &str = "gpt-5.4";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectConfig {
    version: u32,
    default_model: String,
}

pub fn valid_model(model: &str) -> bool {
    !model.is_empty() && model.len() <= 128 && model.as_bytes()[0].is_ascii_alphanumeric()
        && model.bytes().all(|c| c.is_ascii_alphanumeric() || b"._:/-".contains(&c))
}

pub fn default_model(root: &Path) -> Result<String> {
    let source = match std::fs::read_to_string(root.join("spool.json")) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(DEFAULT_MODEL.into()),
        Err(error) => return Err(error).context("Cannot read project settings"),
    };
    let config: ProjectConfig = serde_json::from_str(&source).context("Invalid spool.json")?;
    anyhow::ensure!(config.version == 1 && valid_model(&config.default_model), "Invalid project default model");
    Ok(config.default_model)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AgentConfig;

    #[test]
    fn agents_inherit_live_project_settings_without_changing_explicit_models() -> Result<()> {
        let root = std::env::temp_dir().join(format!("spool-model-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("agents"))?;
        let role = root.join("agents/role.md");
        std::fs::write(&role, "# Instructions")?;
        let result = (|| {
            assert_eq!(AgentConfig::from_file(&role)?.model, DEFAULT_MODEL);
            for model in ["project-one", "project-two"] {
                std::fs::write(root.join("spool.json"), format!(r#"{{"version":1,"defaultModel":"{model}"}}"#))?;
                assert_eq!(AgentConfig::from_file(&role)?.model, model);
            }
            std::fs::write(&role, "---\nmodel: explicit-model\nreasoning: high\n---\n# Instructions")?;
            let agent = AgentConfig::from_file(&role)?;
            assert_eq!(agent.model, "explicit-model");
            assert_eq!(agent.system_prompt, "# Instructions");
            std::fs::write(root.join("spool.json"), r#"{"version":1,"defaultModel":"bad model"}"#)?;
            assert!(AgentConfig::from_file(&role).is_err());
            Ok(())
        })();
        std::fs::remove_dir_all(root)?;
        result
    }
}
