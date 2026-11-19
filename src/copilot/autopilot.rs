use super::*;
use serde_json::{json, Value};

pub(super) fn command(command: Command) -> Command {
    let runtime = std::env::current_exe().ok().and_then(|exe| exe.parent()?.parent().map(|directory|
        directory.join(if cfg!(windows) { "spool-runtime.exe" } else { "spool-runtime" })))
        .filter(|file| file.is_file()).unwrap_or_else(|| PathBuf::from("node"));
    let mut adapter = Command::new(runtime);
    adapter.args(["--input-type=module", "-e", concat!(
        include_str!("../../packages/runners/packages/repository-mcp/src/copilot-autopilot.mjs"),
        "\nawait serveAutopilot(process.argv.slice(1));"
    ), "--"]).arg(command.as_std().get_program()).args(command.as_std().get_args());
    adapter
}

pub(super) struct RoleInstructions(PathBuf);

impl Drop for RoleInstructions {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.0.join("role.instructions.md"));
        let _ = fs::remove_dir(&self.0);
    }
}

pub(super) fn configure_role(command: &mut Command, root: &Path, agent: &AgentConfig) -> Result<RoleInstructions> {
    let directory = root.join(".runner-receipts").join("role-instructions").join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&directory)?;
    let guard = RoleInstructions(directory);
    fs::write(guard.0.join("role.instructions.md"), &agent.system_prompt)?;
    let mut directories = std::env::var("COPILOT_CUSTOM_INSTRUCTIONS_DIRS").unwrap_or_default();
    if !directories.is_empty() { directories.push(','); }
    directories.push_str(&guard.0.to_string_lossy());
    command.env("COPILOT_CUSTOM_INSTRUCTIONS_DIRS", directories)
        .env("SPOOL_AGENT_INSTRUCTIONS", guard.0.join("role.instructions.md"));
    Ok(guard)
}

pub(super) fn prompt(messages: &[Value]) -> Result<Vec<Value>> {
    let objective = messages.iter().map(|message| message["text"].as_str().context("Invalid objective message"))
        .collect::<Result<Vec<_>>>()?.join("\n\n");
    let objective = objective.trim();
    anyhow::ensure!(!objective.is_empty() && !["on", "off", "status", "pause", "resume", "clear"].contains(&objective.to_ascii_lowercase().as_str()),
        "Autopilot requires an objective, not an empty message or mode command");
    Ok(vec![json!({ "type": "text", "text": format!("/autopilot {objective}") })])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn objectives_contain_only_the_incoming_messages() -> Result<()> {
        let messages = vec![json!({ "type": "text", "text": "Fix the assigned task.\nKeep its scope." }),
            json!({ "type": "text", "text": "Also handle this feedback." })];
        assert_eq!(prompt(&messages)?, vec![json!({ "type": "text",
            "text": "/autopilot Fix the assigned task.\nKeep its scope.\n\nAlso handle this feedback." })]);
        for text in ["", " ", "on", "OFF", "status", "pause", "resume", "clear"] {
            assert!(prompt(&[json!({ "type": "text", "text": text })]).is_err());
        }
        Ok(())
    }

    #[test]
    fn role_instructions_are_separate_and_cleaned_after_execution() -> Result<()> {
        let root = std::env::temp_dir().join(format!("spool-autopilot-{}", uuid::Uuid::new_v4()));
        let agent = AgentConfig::parse("probe", "Keep this role out of the objective.", PathBuf::new())?;
        let mut command = Command::new("mock-provider");
        let instructions = configure_role(&mut command, &root, &agent)?;
        let file = instructions.0.join("role.instructions.md");
        assert_eq!(fs::read_to_string(&file)?, agent.system_prompt);
        assert!(command.as_std().get_envs().any(|(key, value)|
            key == "SPOOL_AGENT_INSTRUCTIONS" && value == Some(file.as_os_str())));
        drop(instructions);
        assert!(!file.exists());
        fs::remove_dir_all(root)?;
        Ok(())
    }
}
