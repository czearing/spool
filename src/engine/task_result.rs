use crate::models::{Task, TaskStatus};
use anyhow::Result;
use std::path::Path;

pub fn update(
    root: &Path,
    task: &mut Task,
    agent: &str,
    status: TaskStatus,
    comment: Option<&str>,
    error: Option<&str>,
) -> Result<()> {
    if let Some(comment) = comment {
        task.add_comment(format!("agent:{agent}"), comment);
    }
    if let Some(error) = error {
        task.error = Some(error.to_owned());
    }
    if status == TaskStatus::Completed {
        task.error = None;
        if let Some(result) = super::acceptance::verify_completion(root, task)? {
            task.add_comment(
                "spool:acceptance",
                format!(
                    "Independent bundle acceptance verified commit {} and PR {}. after: {}",
                    result["commit"], result["prId"], result["value"]
                ),
            );
        }
    }
    task.status = status;
    if matches!(status, TaskStatus::Failed | TaskStatus::Completed) {
        task.failure_origin =
            (status == TaskStatus::Failed).then(|| crate::models::task::FailureOrigin {
                source: "agent".into(),
                error: task.error.clone(),
            });
    }
    if status != TaskStatus::InProgress {
        task.interaction.chat_return = None;
    }
    Ok(())
}
