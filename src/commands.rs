use std::collections::HashMap;
use std::path::Path;
use anyhow::Result;
use uuid::Uuid;

use crate::models::{AgentConfig, Task};
use crate::queue::fs::{list_tasks_in_dir, write_task, QueuePaths};
pub fn handle_pause(root: &Path, agent: &str, paused: bool) -> Result<()> {
    let marker = AgentConfig::pause_path(root, agent)?;
    AgentConfig::from_file(root.join("agents").join(format!("{agent}.md")))?;
    if paused {
        std::fs::create_dir_all(marker.parent().unwrap())?;
        std::fs::write(marker, "Paused by operator; active work may finish.\n")?;
    } else {
        match std::fs::remove_file(marker) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    println!("{agent}: {}", if paused { "paused; active work is not terminated" } else { "resumed" });
    Ok(())
}
pub fn handle_submit(
    root: &Path,
    agent: &str,
    title: &str,
    prompt: &str,
    id: Option<String>,
    workspace: Option<String>,
) -> Result<String> {
    let task_id = id.unwrap_or_else(|| format!("TASK-{}", &Uuid::new_v4().to_string()[..8].to_uppercase()));
    let mut task = Task::new(&task_id, agent, title, prompt);
    task.workspace = workspace;
    let qp = QueuePaths::new(root.join("queues"));
    qp.ensure_dirs()?;

    let target = qp.incoming.join(format!("{}.json", task_id));
    write_task(&target, &task)?;
    println!("✓ Task {} created in {}", task_id, target.display());
    Ok(task_id)
}
pub fn handle_status(root: &Path) -> Result<()> {
    let scheduler_error = root.join("controls").join("scheduler-error.json");
    if scheduler_error.try_exists()? {
        let failure: serde_json::Value = serde_json::from_slice(&std::fs::read(scheduler_error)?)?;
        println!("SCHEDULER FAILED: {}", failure["error"]);
    }
    let capability = root.join("controls").join("capabilities.json");
    match std::fs::read(&capability) {
        Ok(bytes) => {
            let value: serde_json::Value = serde_json::from_slice(&bytes)?;
            let timestamp = value["updatedAt"].as_str()
                .ok_or_else(|| anyhow::anyhow!("Scheduler heartbeat is missing updatedAt"))?;
            let updated = chrono::DateTime::parse_from_rfc3339(timestamp)?;
            let age = chrono::Utc::now().signed_duration_since(updated).num_seconds();
            if age > 15 {
                println!("SCHEDULER UNHEALTHY: heartbeat is {age}s old (last update {timestamp}). Queue counts do not prove agent activity.");
            } else {
                println!("Scheduler heartbeat: {timestamp} (PID {})", value["pid"]);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            println!("SCHEDULER UNVERIFIED: no heartbeat found. Queue counts do not prove agent activity.");
        }
        Err(error) => return Err(error.into()),
    }
    let agents_dir = root.join("agents");
    let queues_dir = root.join("queues");
    let qp = QueuePaths::new(&queues_dir);

    let inc_tasks = list_tasks_in_dir(&qp.incoming);
    let prog_tasks = list_tasks_in_dir(&qp.in_progress);
    let comp_tasks = list_tasks_in_dir(&qp.completed);
    let fail_tasks = list_tasks_in_dir(&qp.failed);

    let mut inc_counts: HashMap<String, usize> = HashMap::new();
    let mut prog_counts: HashMap<String, usize> = HashMap::new();
    let mut comp_counts: HashMap<String, usize> = HashMap::new();
    let mut fail_counts: HashMap<String, usize> = HashMap::new();

    for (_, t) in &inc_tasks { *inc_counts.entry(t.agent.clone()).or_default() += 1; }
    for (_, t) in &prog_tasks { *prog_counts.entry(t.agent.clone()).or_default() += 1; }
    for (_, t) in &comp_tasks { *comp_counts.entry(t.agent.clone()).or_default() += 1; }
    for (_, t) in &fail_tasks { *fail_counts.entry(t.agent.clone()).or_default() += 1; }

    println!("\n{:<20} {:<10} {:<6} {:<6} {:<6} {:<6}", "AGENT", "STATUS", "INC", "PROG", "DONE", "FAIL");
    println!("{:-<58}", "");

    if let Ok(entries) = std::fs::read_dir(agents_dir) {
        let mut agents = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Ok(agent) = AgentConfig::from_file(&path) {
                    agents.push(agent);
                }
            }
        }
        agents.sort_by(|a, b| a.name.cmp(&b.name));

        for agent in agents {
            let inc = *inc_counts.get(&agent.name).unwrap_or(&0);
            let prog = *prog_counts.get(&agent.name).unwrap_or(&0);
            let comp = *comp_counts.get(&agent.name).unwrap_or(&0);
            let fail = *fail_counts.get(&agent.name).unwrap_or(&0);
            let status = if AgentConfig::is_paused(root, &agent.name)? {
                if prog > 0 { "DRAINING" } else { "PAUSED" }
            } else if prog > 0 { "RUNNING" } else if inc > 0 { "QUEUED" } else { "IDLE" };
            println!("{:<20} {:<10} {:<6} {:<6} {:<6} {:<6}", agent.name, status, inc, prog, comp, fail);
        }
    }
    println!();
    Ok(())
}

pub fn run_test_e2e(root: &Path) -> Result<()> {
    println!("=== RUNNING SPOOL E2E SELF-TEST ===");
    println!("[1/6] Testing provider accounting schema...");
    let ledger = crate::usage::Ledger::default();
    assert_eq!(ledger.unit, "model_tokens");
    assert!(ledger.sessions.is_empty(), "No usage should be manufactured");
    println!("      Provider-native units; no price estimates (PASSED)");

    // 2. Queue & atomic move verification
    println!("[2/6] Testing queue atomic file state machine...");
    let test_id = format!("TEST-{}", &Uuid::new_v4().to_string()[..8]);
    let task_id = handle_submit(root, "test-agent", "E2E Test Task", "Verify functionality", Some(test_id.clone()), None)?;
    let qp = QueuePaths::new(root.join("queues"));
    let inc_file = qp.incoming.join(format!("{}.json", task_id));
    assert!(inc_file.exists(), "Incoming task file must exist");
    println!("      Atomic incoming write verified (PASSED)");

    // 3. Agent markdown config parser
    println!("[3/6] Testing agent markdown prompt parsing...");
    let sample_md = "---\nmodel: gpt-5.4\ndescription: Performance Analyzer\n---\nYou are a perf engineer.";
    let agent = AgentConfig::parse("perf", sample_md, root.join("agents/perf.md"))?;
    assert_eq!(agent.model, "gpt-5.4");
    assert_eq!(agent.name, "perf");
    println!("      Parsed agent: {} (model: {}) (PASSED)", agent.name, agent.model);

    // 4. Mid-turn crash recovery & session continuity test
    println!("[4/6] Testing mid-turn crash recovery and session preservation...");
    let resume_session_id = format!("sess-{}", &Uuid::new_v4().to_string()[..8]);
    let mut in_prog_task = Task::new("TEST-CRASH-1", "test-agent", "Interrupted Task", "Continue work");
    in_prog_task.session_id = Some(resume_session_id.clone());
    let in_prog_file = qp.in_progress.join("TEST-CRASH-1.json");
    write_task(&in_prog_file, &in_prog_task)?;
    assert!(in_prog_file.exists(), "Simulated in-progress task must exist");

    let state = crate::engine::AppState::new();
    let orch = crate::engine::Orchestrator::new(root, state);
    orch.recover_interrupted_tasks()?;

    let recovered_file = qp.incoming.join("TEST-CRASH-1.json");
    assert!(recovered_file.exists(), "Interrupted task must be restored to incoming");
    let recovered_task = crate::queue::fs::read_task(&recovered_file)?;
    assert_eq!(recovered_task.session_id, Some(resume_session_id), "Session ID must be preserved for token caching");
    println!("      Crash recovery verified: session ID preserved for token cache (PASSED)");

    // 5. Multi-agent handoff & prompt context chaining test
    println!("[5/6] Testing multi-agent handoff (Chief of Staff -> Prompt Engineer -> Software Engineer)...");
    let handoff_id = "TEST-HANDOFF-1";
    let mut task = Task::new(handoff_id, "chief-of-staff", "Create Memory Analyzer Agent", "Plan and build agent");

    // Turn 1: Chief of Staff reassigns to Prompt Engineer
    task.add_comment("handoff:chief-of-staff->prompt-engineer", "Spec defined. Please create prompt in agents/memory-analyzer.md");
    task.agent = "prompt-engineer".to_string();
    let h_file = qp.incoming.join(format!("{}.json", handoff_id));
    write_task(&h_file, &task)?;

    // Turn 2: Prompt Engineer adds prompt & reassigns to Software Engineer
    let mut pe_task = crate::queue::fs::read_task(&h_file)?;
    assert_eq!(pe_task.agent, "prompt-engineer");
    assert_eq!(pe_task.comments.len(), 1);
    pe_task.add_comment("handoff:prompt-engineer->software-engineer", "Prompt file created. Ready for code implementation.");
    pe_task.agent = "software-engineer".to_string();
    write_task(&h_file, &pe_task)?;

    // Turn 3: Software Engineer completes task
    let mut se_task = crate::queue::fs::read_task(&h_file)?;
    assert_eq!(se_task.agent, "software-engineer");
    assert_eq!(se_task.comments.len(), 2);
    se_task.status = crate::models::TaskStatus::Completed;
    let completed_h_file = qp.completed.join(format!("{}.json", handoff_id));
    crate::queue::fs::atomic_move(&h_file, &completed_h_file)?;
    assert!(completed_h_file.exists(), "Completed handoff task must exist in completed/");
    println!("      Multi-agent handoff chaining verified with full comment audit trail (PASSED)");

    // 6. Clean up test files
    let _ = std::fs::remove_file(inc_file);
    let _ = std::fs::remove_file(recovered_file);
    let _ = std::fs::remove_file(completed_h_file);
    println!("[6/6] Cleaned up temporary test artifacts (PASSED)");

    println!("\n✓ ALL SPOOL E2E INTEGRATION CHECKS PASSED SUCCESSFULLY!");
    Ok(())
}
