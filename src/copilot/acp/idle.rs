use super::*;

pub(super) struct IdlePolicy {
    pub duration: Option<Duration>,
    pub workspace: PathBuf,
}

pub(super) fn retention(root: &Path, config: &SessionConfig) -> Result<Option<IdlePolicy>> {
    let Some(provider) = &config.provider else {
        return Ok(None);
    };
    let settings = root.join("spool.json");
    if !settings.try_exists()? {
        return Ok(None);
    }
    let settings: Value = serde_json::from_slice(&fs::read(settings)?)?;
    let seconds = settings["warmChatSeconds"].as_u64().unwrap_or(0).min(1800);
    let persistent = settings["keepChatWarm"].as_bool().unwrap_or(false);
    if seconds == 0 && !persistent {
        return Ok(None);
    }
    let Some(index) = provider
        .args
        .iter()
        .position(|argument| argument == "--config")
    else {
        return Ok(None);
    };
    let Some(file) = provider.args.get(index + 1) else {
        return Ok(None);
    };
    let profile: Value = serde_json::from_slice(&fs::read(file)?)?;
    if profile["purpose"] != "engineering" || !profile["sshHost"].is_string() {
        return Ok(None);
    }
    Ok(Some(IdlePolicy {
        duration: (!persistent).then(|| Duration::from_secs(seconds)),
        workspace: PathBuf::from(profile["workspace"].as_str().unwrap_or(&config.workspace)),
    }))
}

fn same_workspace(left: Option<&str>, right: Option<&str>) -> bool {
    let (Some(left), Some(right)) = (left, right) else {
        return false;
    };
    let (Ok(left), Ok(right)) = (fs::canonicalize(left), fs::canonicalize(right)) else {
        return false;
    };
    #[cfg(windows)]
    return left
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy());
    #[cfg(not(windows))]
    return left == right;
}

fn read_contender<T: serde::de::DeserializeOwned>(file: &Path) -> Result<Option<T>> {
    match fs::read(file) {
        Ok(contents) => Ok(Some(serde_json::from_slice(&contents)?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn should_yield(root: &Path, task: &Task, policy: &IdlePolicy) -> Result<bool> {
    if AgentConfig::is_paused(root, &task.agent)? {
        return Ok(true);
    }
    if let Some(workspace) = &task.workspace {
        if Path::new(workspace)
            .join("repository-mcp.lock")
            .try_exists()?
        {
            return Ok(true);
        }
    }
    if policy.workspace.join("repository-mcp.lock").try_exists()? {
        return Ok(true);
    }
    let workspace = policy.workspace.to_str();
    for entry in fs::read_dir(root.join("queues").join("incoming"))? {
        let file = entry?.path();
        if file.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let Some(queued) = read_contender::<Task>(&file)? else {
            continue;
        };
        anyhow::ensure!(
            file.file_stem().and_then(|name| name.to_str()) == Some(queued.id.as_str()),
            "Task identity does not match its queue file: {}",
            file.display()
        );
        if queued.id != task.id
            && (queued.agent == task.agent
                || same_workspace(queued.workspace.as_deref(), task.workspace.as_deref())
                || same_workspace(queued.workspace.as_deref(), workspace))
        {
            return Ok(true);
        }
    }
    for directory in ["manual", "native-resumes"] {
        let directory = root.join("controls").join(directory);
        if !directory.try_exists()? {
            continue;
        }
        for entry in fs::read_dir(directory)? {
            let file = entry?.path();
            if file.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let Some(job) = read_contender::<Value>(&file)? else {
                continue;
            };
            let request = &job["request"];
            if job["status"] == "failed" || request["taskId"] == task.id {
                continue;
            }
            if request["agent"] != task.agent
                && !same_workspace(request["workspace"].as_str(), task.workspace.as_deref())
                && !same_workspace(request["workspace"].as_str(), workspace)
            {
                continue;
            }
            let id = request["id"]
                .as_str()
                .context("Missing idle contender identity")?;
            crate::queue::fs::validate_id(id)?;
            if !root
                .join("controls")
                .join("results")
                .join(format!("{id}.json"))
                .try_exists()?
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

pub(super) fn mark_idle(root: &Path, id: &str) -> Result<bool> {
    let mut retained = false;
    mutate(root, id, |task| {
        if task
            .interaction
            .messages
            .iter()
            .any(|message| message.status == "queued")
            || task.interaction.paused
            || task.interaction.cancel_requested
            || task.interaction.status_change.is_some()
            || task.interaction.handoff.is_some()
        {
            return Ok(());
        }
        if let Some(previous) = &task.interaction.chat_return {
            task.status = previous.status;
            task.error = previous.error.clone();
        } else if task.status != crate::models::TaskStatus::Completed {
            return Ok(());
        }
        task.interaction.phase = "idle".into();
        retained = true;
        Ok(())
    })?;
    Ok(retained)
}

#[cfg(test)]
#[path = "idle_tests.rs"]
mod tests;
