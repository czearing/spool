#![allow(dead_code, unused_imports)]

use std::sync::Arc;
use anyhow::Result;
use clap::Parser;
use tokio::sync::mpsc;

mod cli;
mod automation;
mod commands;
mod copilot;
mod engine;
mod importer;
mod mcp;
mod models;
mod queue;
mod tui;
mod usage;

use engine::ownership;
use cli::{Cli, Commands};
use commands::{handle_status, handle_submit, run_test_e2e};
use engine::{AppState, Orchestrator};
use mcp::McpServer;
use tui::run_tui;

fn resolve_spool_root(cli_root: &std::path::Path) -> std::path::PathBuf {
    if cli_root != std::path::Path::new(".") {
        return cli_root.canonicalize().unwrap_or_else(|_| cli_root.to_path_buf());
    }
    if let Ok(dir) = std::env::var("SPOOL_DIR") {
        return std::path::PathBuf::from(dir);
    }
    let default_path = std::path::PathBuf::from(r"C:\Code\spool");
    if default_path.exists() {
        return default_path;
    }
    std::path::PathBuf::from(".")
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let root = resolve_spool_root(&cli.root);

    match cli.command.unwrap_or(Commands::Run) {
        Commands::Mcp { agent, task } => {
            let server = McpServer::new(root.join("queues"), agent, task);
            server.run_stdio().await?;
        }
        Commands::Submit { agent, title, prompt, id, workspace } => {
            handle_submit(&root, &agent, &title, &prompt, id, workspace)?;
        }
        Commands::ReservePrOwner { id, agent, title, workspace, branch, commit } => {
            println!("{}", automation::reserve(&root, &id, &agent, &title, &workspace, &branch, &commit)?);
        }
        Commands::Status => {
            handle_status(&root)?;
        }
        Commands::UsageSync => {
            usage::sync_project(&root)?;
            println!("Provider usage accounting synchronized.");
        }
        Commands::Pause { agent } => commands::handle_pause(&root, &agent, true)?,
        Commands::Resume { agent } => commands::handle_pause(&root, &agent, false)?,
        Commands::ImportPaperclip { url, company } => {
            let importer = importer::PaperclipImporter::new(&url, &company, &root);
            let count = importer.run_import().await?;
            println!("✓ Successfully imported {} tasks from Paperclip into Spool queues!", count);
        }
        Commands::TestE2e => {
            let scratch = std::env::temp_dir().join(format!("spool-e2e-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&scratch)?;
            let result = run_test_e2e(&scratch);
            let cleanup = std::fs::remove_dir_all(&scratch);
            result?;
            cleanup?;
        }
        Commands::Daemon => {
            let _lease = ownership::DaemonLease::acquire(&root)?;
            let state = AppState::new();
            let orchestrator = Arc::new(Orchestrator::new(&root, Arc::clone(&state)));
            orchestrator.load_agents()?;
            let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
            println!("🚀 Spool Daemon running in {}", root.display());
            orchestrator.run_supervised(shutdown_rx).await?;
        }
        Commands::Run => {
            let _lease = ownership::DaemonLease::acquire(&root)?;
            let state = AppState::new();
            let orchestrator = Arc::new(Orchestrator::new(&root, Arc::clone(&state)));
            orchestrator.load_agents()?;

            let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
            let orch_clone = Arc::clone(&orchestrator);

            tokio::spawn(async move {
                if let Err(error) = orch_clone.run_supervised(shutdown_rx).await {
                    eprintln!("Spool scheduler supervision ended: {error:#}");
                }
            });

            run_tui(state, root.join("queues"), shutdown_tx).await?;
        }
    }
    Ok(())
}
