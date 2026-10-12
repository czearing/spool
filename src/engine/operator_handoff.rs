use super::*;
use crate::models::task::OperatorMessage;

pub fn apply_handoff(task: &mut Task) {
    apply_for_mode(task, crate::copilot::process::interactive_enabled());
}

fn apply_for_mode(task: &mut Task, interactive: bool) {
    if let Some(handoff) = task.interaction.handoff.take() {
        if let Some(error) = task.error.take() {
            task.add_comment("spool:supervisor", format!("Operator handed off the task after recorded failure: {error}"));
        }
        task.add_comment(format!("handoff:{}->{}", task.agent, handoff.agent), &handoff.message);
        if interactive {
            task.interaction.messages.push(OperatorMessage {
                id: handoff.id, text: handoff.message, status: "queued".into(),
                created_at: chrono::Utc::now(), session_id: None, error: None,
            });
        }
        task.agent = handoff.agent;
        if let Some(config) = &mut task.session_config {
            config.agent = task.agent.clone();
            if let Some(args) = config.mcp.as_mut().and_then(|mcp| mcp["mcpServers"]["spool"]["args"].as_array_mut()) {
                if let Some(index) = args.iter().position(|value| value == "--agent") {
                    if let Some(value) = args.get_mut(index + 1) { *value = json!(task.agent); }
                }
            }
        }
        task.status = TaskStatus::Incoming;
        task.interaction.paused = false;
        task.interaction.cancel_requested = false;
        task.interaction.resume_requested = false;
        task.interaction.phase = "queued".into();
    }
}

pub fn recover_input(task: &mut Task) {
    if task.interaction.handoff.is_some() { apply_for_mode(task, true); }
    if task.session_id.is_some() && !task.interaction.paused &&
        !task.interaction.messages.iter().any(|message| message.status == "queued") {
        task.interaction.messages.push(OperatorMessage {
            id: uuid::Uuid::new_v4().to_string(),
            text: "Continue the interrupted task from its current session context.".into(),
            status: "queued".into(), created_at: chrono::Utc::now(), session_id: None, error: None,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handoff_queues_only_new_instructions_in_interactive_mode() {
        for interactive in [false, true] {
            let mut task = Task::new("task", "first", "Task", "Never replay this");
            task.session_id = Some("original".into());
            task.interaction.handoff = Some(OperatorHandoff {
                id: "handoff".into(), agent: "second".into(), message: "Review the result".into(),
            });
            apply_for_mode(&mut task, interactive);
            assert_eq!(task.agent, "second");
            assert_eq!(task.session_id.as_deref(), Some("original"));
            assert_eq!(task.prompt, "Never replay this");
            assert_eq!(task.interaction.messages.len(), usize::from(interactive));
            if interactive { assert_eq!(task.interaction.messages[0].text, "Review the result"); }
        }
    }

    #[test]
    fn recovery_adds_one_continuation_cue_without_replaying_or_retrying_uncertain_input() {
        let mut task = Task::new("task", "first", "Task", "Never replay this");
        task.session_id = Some("original".into());
        recover_input(&mut task);
        recover_input(&mut task);
        assert_eq!(task.interaction.messages.len(), 1);
        assert!(!task.interaction.messages[0].text.contains(&task.prompt));
        task.interaction.messages[0].status = "delivery_uncertain".into();
        task.interaction.paused = true;
        recover_input(&mut task);
        assert_eq!(task.interaction.messages.len(), 1);
        assert!(task.interaction.paused);
    }
}
