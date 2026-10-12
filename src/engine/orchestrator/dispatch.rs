use super::*;

impl Orchestrator {
    pub(super) fn refresh_agents(&self) -> Result<()> {
        let mut loaded = std::collections::HashMap::new();
        for entry in std::fs::read_dir(&self.agents_dir)? {
            let path = entry?.path();
            if path.extension().is_none_or(|e| e != "md") { continue; }
            match AgentConfig::from_file(&path) {
                Ok(agent) => { loaded.insert(agent.name.clone(), agent); }
                Err(error) => self.state.write().add_log(format!("Cannot load agent {}: {error:#}", path.display())),
            }
        }
        self.state.write().agents = loaded;
        Ok(())
    }
    pub fn dispatch_available_tasks(&self) {
        if let Err(error) = self.refresh_agents() {
            self.state.write().add_log(format!("Cannot refresh agents: {error:#}"));
            return;
        }
        let qp = QueuePaths::new(&self.queues_dir);
        let tasks = list_tasks_in_dir(&qp.incoming);
        if tasks.is_empty() {
            return;
        }

        let agents: Vec<_> = self.state.read().agents.keys().cloned().collect();

        for agent_name in agents {
          loop {
            let claim = match self.claim_task(&agent_name, &tasks) {
                Ok(claim) => claim,
                Err(error) => {
                    self.state.write().add_log(format!("Cannot claim task for {agent_name}: {error:#}"));
                    break;
                }
            };
            if let Some((in_prog_file, task, agent_cfg)) = claim {
                let orch = self.clone_arc();
                tokio::spawn(async move {
                    let task_id = task.id.clone();
                    orch.execute_task_pipeline(task, agent_cfg, in_prog_file).await;
                    orch.state.write().remove_active_task(&task_id);
                    orch.dispatch_available_tasks();
                });
            } else { break; }
          }
        }
    }

    pub(super) fn claim_task(&self, agent: &str, tasks: &[(PathBuf, Task)]) -> Result<Option<(PathBuf, Task, AgentConfig)>> {
        for (incoming, task) in tasks.iter().filter(|(_, task)| task.agent == agent) {
            let _guard = TaskGuard::acquire(&self.queues_dir, &task.id)?;
            let mut state = self.state.write();
            if AgentConfig::is_paused(&self.root, agent)? {
                return Ok(None);
            }
            if state.active_tasks.contains_key(&task.id) || !incoming.exists() {
                continue;
            }
            let mut task = read_task(incoming)?;
            if task.agent != agent || task.interaction.paused { continue; }
            let agent_cfg = AgentConfig::from_file(self.agents_dir.join(format!("{agent}.md")))?;
            if agent_cfg.concurrency_explicit && agent_cfg.max_concurrent_runs.is_some_and(|limit|
                state.active_tasks.values().filter(|active| active.agent == agent).count() >= limit) {
                return Ok(None);
            }
            if state.active_tasks.values().any(|active|
                (!agent_cfg.concurrency_explicit && active.agent == agent &&
                    (!task.independent_workspace || !active.independent_workspace)) ||
                task.session_id.as_ref().is_some_and(|session| active.session_id.as_ref() == Some(session))) {
                continue;
            }
            task.workspace = spool_agent_prompts::working_directory(task.workspace.as_deref(),
                agent_cfg.default_workspace.as_deref(), task.session_id.is_some())?
                .map(|path| path.to_string_lossy().into_owned());
            if crate::engine::operator::workspace_held(&self.root, &task)? { continue; }
            let workspace = task.workspace.as_ref().map(|workspace| {
                let path = std::fs::canonicalize(workspace)?;
                #[cfg(windows)]
                let path = PathBuf::from(path.to_string_lossy().to_lowercase());
                Ok::<_, std::io::Error>(path)
            }).transpose()?;
            if task.independent_workspace {
                let receipt = task.metadata(&self.root)?.context("Independent task has no preparation receipt")?;
                let prepared_workspace = receipt["preparation"]["repoRoot"].as_str()
                    .context("Independent task has no prepared workspace")?;
                anyhow::ensure!(task.session_id.is_some() && workspace.is_some() &&
                    receipt["independentWorkspace"] == true && receipt["runner"] == "pr-updater" &&
                    receipt["preparation"]["ready"] == true && receipt["contract"]["identifier"] == task.id &&
                    receipt["contract"]["agent"] == task.agent &&
                    receipt["contract"]["cwd"] == task.workspace.as_deref().unwrap() &&
                    std::fs::canonicalize(prepared_workspace)? == std::fs::canonicalize(task.workspace.as_ref().unwrap())?,
                    "Independent task must retain its original session and verified PR workspace");
            }
            if workspace.as_ref().is_some_and(|path| state.active_workspaces.contains_key(path)) {
                continue;
            }
            let destination = QueuePaths::new(&self.queues_dir).in_progress.join(format!("{}.json", task.id));
            anyhow::ensure!(!destination.exists(), "Task {} already has an in-progress record", task.id);
            task.status = TaskStatus::InProgress;
            write_task(incoming, &task)?;
            atomic_move(incoming, &destination)?;
            state.set_active_task(&task);
            if let Some(workspace) = workspace {
                state.active_workspaces.insert(workspace, task.id.clone());
            }
            state.agents.insert(agent.to_owned(), agent_cfg.clone());
            state.add_log(format!("[{agent}] Picked up task {}: {}", task.id, task.title));
            return Ok(Some((destination, task.clone(), agent_cfg)));
        }
        Ok(None)
    }

    pub(super) fn clone_arc(&self) -> Arc<Self> {
        Arc::new(Self {
            root: self.root.clone(),
            agents_dir: self.agents_dir.clone(),
            queues_dir: self.queues_dir.clone(),
            logs_dir: self.logs_dir.clone(),
            state: Arc::clone(&self.state),
        })
    }

    pub async fn handle_task_file(&self, _incoming_file: &Path) {
        self.dispatch_available_tasks();
    }

}
