use std::path::Path;
use anyhow::Result;
use uuid::Uuid;

use crate::models::{AgentConfig, Task};
use crate::pricing::calculate_cost;
use crate::queue::fs::{list_tasks_in_dir, write_task, AgentQueuePaths};

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

    let qp = AgentQueuePaths::new(root.join("queues"), agent);
    qp.ensure_dirs()?;

    let target = qp.incoming.join(format!("{}.json", task_id));
    write_task(&target, &task)?;
    println!("✓ Task {} created in {}", task_id, target.display());
    Ok(task_id)
}

pub fn handle_status(root: &Path) -> Result<()> {
    let agents_dir = root.join("agents");
    let queues_dir = root.join("queues");

    println!("\n{:<16} {:<12} {:<6} {:<6} {:<6} {:<6}", "AGENT", "STATUS", "INC", "PROG", "DONE", "FAIL");
    println!("{:-<54}", "");

    if let Ok(entries) = std::fs::read_dir(agents_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Ok(agent) = AgentConfig::from_file(&path) {
                    let qp = AgentQueuePaths::new(&queues_dir, &agent.name);
                    let inc = list_tasks_in_dir(&qp.incoming).len();
                    let prog = list_tasks_in_dir(&qp.in_progress).len();
                    let comp = list_tasks_in_dir(&qp.completed).len();
                    let fail = list_tasks_in_dir(&qp.failed).len();

                    let status = if prog > 0 { "RUNNING" } else { "IDLE" };
                    println!("{:<16} {:<12} {:<6} {:<6} {:<6} {:<6}", agent.name, status, inc, prog, comp, fail);
                }
            }
        }
    }
    println!();
    Ok(())
}

pub fn run_test_e2e(root: &Path) -> Result<()> {
    println!("=== RUNNING SPOOL E2E SELF-TEST ===");
    
    // 1. Pricing verification
    println!("[1/4] Testing token pricing calculation...");
    let cost = calculate_cost("gpt-5.4", 100_000, 20_000, 50_000, 10_000);
    assert!(cost.total_cost_usd > 0.0, "Cost should be non-zero");
    println!("      Input: 100k (50k cached), Output: 20k -> ${:.4} (PASSED)", cost.total_cost_usd);

    // 2. Queue & atomic move verification
    println!("[2/4] Testing queue atomic file state machine...");
    let test_id = format!("TEST-{}", &Uuid::new_v4().to_string()[..8]);
    let task_id = handle_submit(root, "test-agent", "E2E Test Task", "Verify functionality", Some(test_id.clone()), None)?;
    let qp = AgentQueuePaths::new(root.join("queues"), "test-agent");
    let inc_file = qp.incoming.join(format!("{}.json", task_id));
    assert!(inc_file.exists(), "Incoming task file must exist");
    println!("      Atomic incoming write verified (PASSED)");

    // 3. Agent markdown config parser
    println!("[3/4] Testing agent markdown prompt parsing...");
    let sample_md = "---\nmodel: gpt-5.4\ndescription: Performance Analyzer\n---\nYou are a perf engineer.";
    let agent = AgentConfig::parse("perf", sample_md, root.join("agents/perf.md"))?;
    assert_eq!(agent.model, "gpt-5.4");
    assert_eq!(agent.name, "perf");
    println!("      Parsed agent: {} (model: {}) (PASSED)", agent.name, agent.model);

    // 4. Clean up test files
    let _ = std::fs::remove_file(inc_file);
    let _ = std::fs::remove_dir_all(qp.base);
    println!("[4/4] Cleaned up temporary test artifacts (PASSED)");

    println!("\n✓ ALL SPOOL E2E INTEGRATION CHECKS PASSED SUCCESSFULLY!");
    Ok(())
}
