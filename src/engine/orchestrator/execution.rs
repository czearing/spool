use super::*;

impl Orchestrator {
    pub(super) async fn execute_task_pipeline(&self, task: Task, agent: AgentConfig, _in_prog_path: PathBuf) {
        let runner = CopilotRunner::new(&self.logs_dir);
        let exe_path = std::env::current_exe().ok();

        let (log_tx, mut log_rx) = mpsc::channel::<String>(50);
        let state_ref = Arc::clone(&self.state);
        let log_task = tokio::spawn(async move {
            while let Some(msg) = log_rx.recv().await {
                state_ref.write().add_log(msg);
            }
        });

        let accounting_start = chrono::Utc::now();
        let res = runner.execute_task(&task, &agent, exe_path.as_deref(), Some(log_tx)).await;
        let _ = log_task.await;
        let accounting = crate::usage::capture_task(&self.root, &task, accounting_start);
        if let Err(error) = accounting {
            self.state.write().add_log(format!("Cannot record task {} usage: {error:#}", task.id));
        }

        if let Err(error) = self.settle_execution(&task.id, &agent.name, &agent.model, res) {
            self.state.write().add_log(format!("Cannot persist task {} outcome: {error:#}", task.id));
        }
    }

    pub(super) fn settle_execution(&self, id: &str, agent: &str, _model: &str, result: Result<CopilotExecutionResult>) -> Result<()> {
        let _guard = TaskGuard::acquire(&self.queues_dir, id)?;
        let qp = QueuePaths::new(&self.queues_dir);
        let current: Vec<_> = [TaskStatus::InProgress, TaskStatus::Incoming, TaskStatus::Completed, TaskStatus::Failed]
            .into_iter().map(|status| (status, qp.status_dir(status).join(format!("{id}.json"))))
            .filter(|(_, file)| file.exists()).collect();
        anyhow::ensure!(current.len() == 1, "Task {id} must exist in exactly one queue at completion");
        let (status, current_path) = &current[0];
        let mut task = read_task(current_path)?;
        task.status = *status;
        let chat = task.interaction.chat_return.is_some();
        let explicit_completion_required = !chat && (task.acceptance.is_some() || task.metadata(&self.root)?.is_some());
        let successful_stop = result.is_ok();
        match result {
            Ok(exec_res) => {
                task.session_id = Some(exec_res.session_id);
                task.turns += exec_res.usage.turns;

                let cost = crate::models::TaskCost {
                    input_tokens: exec_res.usage.input_tokens, output_tokens: exec_res.usage.output_tokens,
                    cache_read_tokens: exec_res.usage.cache_read_tokens, cache_write_tokens: exec_res.usage.cache_write_tokens,
                    ..Default::default()
                };
                task.cost.input_tokens += cost.input_tokens;
                task.cost.output_tokens += cost.output_tokens;
                task.cost.cache_read_tokens += cost.cache_read_tokens;
                task.cost.cache_write_tokens += cost.cache_write_tokens;
                self.state.write().record_task_cost(agent, &cost);

                if task.agent == agent && task.status == TaskStatus::InProgress &&
                    exec_res.exit_code == 0 && !explicit_completion_required && !chat {
                    task.status = TaskStatus::Completed;
                }
                if exec_res.exit_code != 0 {
                    task.status = TaskStatus::Failed;
                    task.error = Some(format!("Agent exited with code {}; see logs/{}.log", exec_res.exit_code, task.id));
                }
            }
            Err(err) => {
                task.status = TaskStatus::Failed;
                task.error = Some(format!("{err:#}"));
            }
        }
        task.updated_at = chrono::Utc::now();
        task.provider = None;
        for message in &mut task.interaction.messages {
            if message.status == "delivering" {
                message.status = "delivery_uncertain".into();
                message.error = Some("Provider ended before delivery was confirmed".into());
            }
        }
        let operator_disposition = task.interaction.status_change.is_some();
        let mut restored_chat = false;
        if let Some(change) = task.interaction.status_change.take() {
            if successful_stop {
                crate::engine::operator::change_status(&mut task, change.target);
            } else {
                write_json(self.root.join("controls").join("results").join(format!("{}.json", change.request_id)),
                    &serde_json::json!({ "id": change.request_id, "result": { "status": "failed", "error": task.error } }))?;
            }
        } else if task.error.is_none() && task.interaction.handoff.is_some() {
            crate::engine::operator::apply_handoff(&mut task);
        } else if task.interaction.paused {
            task.status = TaskStatus::InProgress;
            task.interaction.phase = "paused".into();
        } else if task.error.is_none() && task.interaction.messages.iter().any(|message| message.status == "queued") {
            task.status = TaskStatus::Incoming;
            task.interaction.phase = "queued".into();
        } else {
            task.interaction.phase = "ended".into();
            if task.status == TaskStatus::InProgress && task.error.is_none() {
                if let Some(previous) = task.interaction.chat_return.take() {
                    anyhow::ensure!(matches!(previous.status, TaskStatus::Completed | TaskStatus::Failed),
                        "Invalid pre-chat task outcome");
                    task.status = previous.status;
                    task.error = previous.error;
                    restored_chat = true;
                }
            }
            if explicit_completion_required && task.status == TaskStatus::InProgress && task.error.is_none() {
                task.status = TaskStatus::Failed;
                task.error = Some("Agent exited without an explicit task result; record completion or failure through spool_update_task_status".into());
            }
        }
        if matches!(task.status, TaskStatus::Completed | TaskStatus::Failed) {
            task.interaction.chat_return = None;
        }
        if task.status == TaskStatus::Completed && !operator_disposition && !restored_chat {
            if let Err(error) = crate::engine::acceptance::verify_completion(&self.root, &task) {
                task.status = TaskStatus::Failed;
                task.error = Some(format!("Completion evidence became invalid: {error:#}"));
            }
        }
        let dest = qp.status_dir(task.status).join(format!("{}.json", task.id));
        write_task(current_path, &task)?;
        if *current_path != dest { atomic_move(current_path, &dest)?; }
        Ok(())
    }
}
