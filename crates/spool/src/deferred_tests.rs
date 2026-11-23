use super::*;
use crate::queue::fs::read_task;

#[test]
fn non_repository_task_reservation_is_idempotent_and_never_creates_publication_state() -> Result<()>
{
    let root = std::env::temp_dir().join(format!("spool-reserve-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("agents"))?;
    std::fs::write(root.join("agents/probe.md"), "A generic worker.")?;
    let result = (|| -> Result<()> {
        let workspace = root.to_str().unwrap();
        let first = reserve(
            &root,
            "reserved",
            "probe",
            "Research",
            "Continue this research later.",
            workspace,
        )?;
        assert_eq!(
            first,
            reserve(
                &root,
                "reserved",
                "probe",
                "Research",
                "Continue this research later.",
                workspace
            )?
        );
        let file = root.join("queues/completed/reserved.json");
        let mut task = read_task(&file)?;
        assert!(eligible(&task)?);
        assert!(!root.join(".runner-receipts").exists());
        let descriptor: Value =
            serde_json::from_slice(&std::fs::read(first["contextFile"].as_str().unwrap())?)?;
        assert!(descriptor.get("branch").is_none() && descriptor.get("receiptDirectory").is_none());
        assert!(reserve(
            &root,
            "reserved",
            "probe",
            "Research",
            "Another task",
            workspace
        )
        .is_err());
        task.session_id = Some(uuid::Uuid::new_v4().to_string());
        write_task(&file, &task)?;
        assert!(!eligible(&task)?);
        assert!(reserve(
            &root,
            "reserved",
            "probe",
            "Research",
            "Continue this research later.",
            workspace
        )
        .is_err());
        Ok(())
    })();
    std::fs::remove_dir_all(root)?;
    result
}

#[test]
fn reserved_execution_cannot_fabricate_a_replacement_conversation() -> Result<()> {
    let mut task = Task::new("probe", "probe", "Research", "Research");
    assert!(!eligible(&task)?);
    task.deferred_session = true;
    task.turns = 1;
    assert!(eligible(&task).is_err());
    Ok(())
}
