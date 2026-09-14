#![allow(dead_code, unused_imports)]

use std::sync::Arc;
use anyhow::Result;
use clap::Parser;
use tokio::sync::mpsc;

mod cli;
mod commands;
mod copilot;
mod engine;
mod mcp;
mod models;
mod pricing;
mod queue;
mod tui;

use cli::{Cli, Commands};
use commands::{handle_status, handle_submit, run_test_e2e};
use engine::{AppState, Orchestrator};
use mcp::McpServer;
use tui::run_tui;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let root = cli.root.canonicalize().unwrap_or(cli.root);

    match cli.command.unwrap_or(Commands::Run) {
        Commands::Mcp { agent, task } => {
            let server = McpServer::new(root.join("queues"), agent, task);
            server.run_stdio().await?;
        }
        Commands::Submit { agent, title, prompt, id, workspace } => {
            handle_submit(&root, &agent, &title, &prompt, id, workspace)?;
        }
        Commands::Status => {
            handle_status(&root)?;
        }
        Commands::TestE2e => {
            run_test_e2e(&root)?;
        }
        Commands::Daemon => {
            let state = AppState::new();
            let orchestrator = Arc::new(Orchestrator::new(&root, Arc::clone(&state)));
            orchestrator.load_agents()?;
            let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
            println!("🚀 Spool Daemon running in {}", root.display());
            orchestrator.run_loop(shutdown_rx).await?;
        }
        Commands::Run => {
            let state = AppState::new();
            let orchestrator = Arc::new(Orchestrator::new(&root, Arc::clone(&state)));
            orchestrator.load_agents()?;

            let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
            let orch_clone = Arc::clone(&orchestrator);

            tokio::spawn(async move {
                let _ = orch_clone.run_loop(shutdown_rx).await;
            });

            run_tui(state, root.join("queues"), shutdown_tx).await?;
        }
    }
    Ok(())
}

