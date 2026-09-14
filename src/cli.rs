use std::path::PathBuf;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "spool")]
#[command(about = "Lean, high-performance agent work-item queue & supervisor", long_about = None)]
pub struct Cli {
    #[arg(short, long, global = true, default_value = ".")]
    pub root: PathBuf,

    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Start the agent runner with interactive TUI dashboard (default)
    Run,
    /// Start in headless daemon mode
    Daemon,
    /// Run the MCP server over stdio for agent status updates
    Mcp {
        #[arg(long)]
        agent: Option<String>,
        #[arg(long)]
        task: Option<String>,
    },
    /// Submit a new task to an agent's queue
    Submit {
        #[arg(short, long)]
        agent: String,
        #[arg(short, long)]
        title: String,
        #[arg(short, long)]
        prompt: String,
        #[arg(long)]
        id: Option<String>,
        #[arg(short, long)]
        workspace: Option<String>,
    },
    /// Print a one-shot status table of all agents and queues
    Status,
    /// Run automated end-to-end integration tests
    TestE2e,
}
