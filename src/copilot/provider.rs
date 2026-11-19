use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provider {
    pub command: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
    pub working_directory: String,
}

pub fn configured(root: &Path, agent: &str) -> Result<Option<Provider>> {
    let file = root.join("spool.json");
    if !file.try_exists()? {
        return Ok(None);
    }
    let settings: serde_json::Value = serde_json::from_slice(&std::fs::read(file)?)?;
    let Some(providers) = settings.get("copilotProviders") else {
        return Ok(None);
    };
    let providers = providers
        .as_object()
        .context("copilotProviders must be an object")?;
    let Some(value) = providers.get(agent) else {
        return Ok(None);
    };
    let provider: Provider =
        serde_json::from_value(value.clone()).context("Invalid Copilot provider")?;
    anyhow::ensure!(
        provider.command.is_absolute() && provider.command.is_file(),
        "Copilot provider command must be an existing absolute file"
    );
    anyhow::ensure!(
        provider.working_directory.starts_with('/')
            && !provider.working_directory.contains(['\0', '\r', '\n'])
            && provider.args.iter().all(|arg| !arg.contains('\0')),
        "Invalid remote provider arguments or working directory"
    );
    Ok(Some(provider))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn providers_are_explicit_per_agent_and_validate_before_launch() -> Result<()> {
        let root = std::env::temp_dir().join(format!("spool-provider-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root)?;
        let result = (|| {
            assert!(configured(&root, "perf")?.is_none());
            let mut settings = serde_json::json!({"version":1,"defaultModel":"gpt-6.1-sol","copilotProviders":{
                "perf":{"command":std::env::current_exe()?,"args":["launcher.mjs"],"workingDirectory":"/workspaces/1JS"}
            }});
            std::fs::write(root.join("spool.json"), settings.to_string())?;
            assert!(configured(&root, "bohemia")?.is_none());
            assert_eq!(
                configured(&root, "perf")?.unwrap().working_directory,
                "/workspaces/1JS"
            );
            settings["copilotProviders"]["perf"]["command"] = "relative.exe".into();
            std::fs::write(root.join("spool.json"), settings.to_string())?;
            assert!(configured(&root, "perf").is_err());
            Ok(())
        })();
        std::fs::remove_file(root.join("spool.json"))?;
        std::fs::remove_dir(root)?;
        result
    }

    #[tokio::test]
    async fn removing_a_remote_provider_refuses_continuation_instead_of_launching_locally(
    ) -> Result<()> {
        use crate::{
            copilot::{CopilotRunner, SessionConfig},
            models::{AgentConfig, Task},
        };
        let root =
            std::env::temp_dir().join(format!("spool-provider-resume-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("logs"))?;
        let result = async {
            let agent = AgentConfig::parse("perf", "Test", PathBuf::new())?;
            let mut task = Task::new("test", "perf", "Test", "Test");
            task.session_id = Some(uuid::Uuid::new_v4().to_string());
            let mut config = SessionConfig::capture(&root, &task, &agent, None)?;
            config.provider = Some(Provider {
                command: std::env::current_exe()?,
                args: vec![],
                working_directory: "/workspaces/1JS".into(),
            });
            task.session_config = Some(config);
            let error = CopilotRunner::new(root.join("logs"))
                .execute_task(&task, &agent, None, None)
                .await
                .err()
                .context("Removed provider unexpectedly launched")?;
            anyhow::ensure!(
                error.to_string().contains("provider changed"),
                "Unexpected continuation error: {error:#}"
            );
            Ok(())
        }
        .await;
        std::fs::remove_dir_all(root)?;
        result
    }

    #[tokio::test]
    async fn configuring_a_remote_provider_refuses_to_move_an_existing_local_session() -> Result<()>
    {
        use crate::{
            copilot::{CopilotRunner, SessionConfig},
            models::{AgentConfig, Task},
        };
        let root = std::env::temp_dir().join(format!(
            "spool-provider-local-resume-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("logs"))?;
        let result = async {
            let agent = AgentConfig::parse("perf", "Test", PathBuf::new())?;
            let mut task = Task::new("test", "perf", "Test", "Test");
            task.session_id = Some(uuid::Uuid::new_v4().to_string());
            task.session_config = Some(SessionConfig::capture(&root, &task, &agent, None)?);
            std::fs::write(
                root.join("spool.json"),
                serde_json::json!({
                    "copilotProviders":{"perf":{"command":std::env::current_exe()?,
                        "workingDirectory":"/workspaces/1JS"}}
                })
                .to_string(),
            )?;
            let error = CopilotRunner::new(root.join("logs"))
                .execute_task(&task, &agent, None, None)
                .await
                .err()
                .context("Existing local session unexpectedly migrated")?;
            anyhow::ensure!(
                error.to_string().contains("provider changed"),
                "Unexpected continuation error: {error:#}"
            );
            Ok(())
        }
        .await;
        std::fs::remove_dir_all(root)?;
        result
    }

    #[tokio::test]
    #[ignore = "Live provider integration; requires SPOOL_REMOTE_PROVIDER_PROOF and SPOOL_REMOTE_MCP_BINARY"]
    async fn live_configured_remote_provider_preserves_callbacks_and_usage() -> Result<()> {
        use crate::{
            copilot::CopilotRunner,
            models::{AgentConfig, Task, TaskStatus},
            queue::fs::{read_task, write_json, write_task},
        };
        let root = PathBuf::from(std::env::var("SPOOL_REMOTE_PROVIDER_PROOF")?);
        anyhow::ensure!(
            root.is_absolute() && !root.exists(),
            "Proof directory must be new"
        );
        let node = PathBuf::from(std::env::var("SPOOL_REMOTE_NODE")?);
        let launcher = std::env::var("SPOOL_REMOTE_LAUNCHER")?;
        let profile = std::env::var("SPOOL_REMOTE_PROFILE")?;
        let codespace: serde_json::Value = serde_json::from_slice(&std::fs::read(&profile)?)?;
        let workspace = PathBuf::from(
            codespace["workspace"]
                .as_str()
                .context("Missing control workspace")?,
        );
        let binary = PathBuf::from(std::env::var("SPOOL_REMOTE_MCP_BINARY")?);
        let role_file = std::env::var("SPOOL_REMOTE_AGENT_ROLE").ok();
        let mut agent = if let Some(file) = &role_file {
            AgentConfig::from_file(Path::new(file))?
        } else {
            AgentConfig::parse(
                "remote-proof",
                "---\nmodel: gpt-6.1-sol\n---\nNative remote integration test.",
                PathBuf::new(),
            )?
        };
        agent.system_prompt.push_str("\nThis assignment is infrastructure verification, not a software change. You are already inside the Codespace. Use native file and shell tools directly, never SSH or run.mjs. Do not modify repository source files, settings, the working branch, dependencies or PRs. Do not create or copy job templates, especially Windows paths. Only the requested remote-main refresh and Spool task comment are authorized.");
        std::fs::create_dir_all(root.join("logs"))?;
        write_json(
            &root.join("spool.json"),
            &serde_json::json!({
                "version":1,"defaultModel":"gpt-6.1-sol","copilotProviders":{(agent.name.clone()):{
                    "command":node,"args":[launcher,"--config",profile],"workingDirectory":"/workspaces/1JS"
                }}
            }),
        )?;
        let nonce = format!("native-remote-callback-{}", uuid::Uuid::new_v4());
        let mut task = Task::new("remote-proof", &agent.name, "Native Spool provider proof",
            format!("Use spool_get_task to verify the assigned task id is remote-proof. Read midgard/package.json with your native file tool and report its name. Call repository repo_prepare with repo 1js and input {{\"operation\":\"master\"}} to refresh remote main without switching the working branch, warming dependencies or starting an application. Add a Spool task progress comment containing exactly {nonce}. Do not change task status."));
        task.status = TaskStatus::InProgress;
        task.workspace = Some(root.to_string_lossy().into_owned());
        let task_file = root.join("queues/in_progress/remote-proof.json");
        std::fs::create_dir_all(task_file.parent().unwrap())?;
        write_task(&task_file, &task)?;
        let runner = CopilotRunner::new(root.join("logs"));
        let started = chrono::Utc::now();
        let mut expected = None;
        for turn in 0..2 {
            let result = runner
                .execute_task(&task, &agent, Some(&binary), None)
                .await?;
            anyhow::ensure!(result.exit_code == 0, "Remote provider turn failed");
            if let Some(session) = &expected {
                anyhow::ensure!(
                    session == &result.session_id,
                    "Session changed after reconnect"
                );
            } else {
                expected = Some(result.session_id.clone());
            }
            task = read_task(&task_file)?;
            anyhow::ensure!(
                task.session_config
                    .as_ref()
                    .is_some_and(|config| config.provider.is_some()),
                "MCP callback lost remote provider ownership"
            );
            crate::usage::capture_task(&root, &task, started)?;
            if turn == 0 {
                task.interaction.messages.push(crate::models::task::OperatorMessage {
                    id:"follow-up".into(), text:format!("Follow-up on the same task: use native shell to run pwd, git branch --show-current, and git ls-remote --exit-code origin HEAD, then call spool_get_task and confirm your earlier {nonce} comment is still present. Do not modify anything."),
                    status:"queued".into(), created_at:chrono::Utc::now(), session_id:None, error:None,
                });
                write_task(&task_file, &task)?;
            }
        }
        anyhow::ensure!(
            task.comments
                .iter()
                .any(|comment| comment.message.contains(&nonce)),
            "Task callback not persisted"
        );
        anyhow::ensure!(
            task.interaction
                .messages
                .iter()
                .all(|message| message.status == "delivered"),
            "Follow-up was not delivered"
        );
        let receipt = workspace.join("prepare.json");
        anyhow::ensure!(
            std::fs::metadata(&receipt)?.modified()? >= started.into(),
            "Repository preparation callback did not produce a new receipt"
        );
        let status: serde_json::Value = serde_json::from_slice(&std::fs::read(receipt)?)?;
        anyhow::ensure!(
            status["execution"]["codespace"] == codespace["codespace"],
            "Repository callback used the wrong Codespace"
        );
        crate::usage::sync_project(&root)?;
        let ledger: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("usage/accounting.json"))?)?;
        let session = expected.context("Missing session")?;
        anyhow::ensure!(
            ledger["sessions"][&session]["records"]
                .as_array()
                .is_some_and(|records| records.len() >= 2),
            "Remote usage was not imported"
        );
        write_json(
            &root.join("verified.json"),
            &serde_json::json!({
                "ready":true,"sessionId":session,"taskId":task.id,"nativeTools":true,
                "agent":agent.name,"roleFile":role_file,"codespace":codespace["codespace"],
                "spoolCallbacks":true,"repositoryCallback":true,"remoteUsage":true,"sameSessionRestored":true,"followUpDelivered":true,
                "productModified":false,"productionProviderEnabled":false
            }),
        )?;
        Ok(())
    }
}
