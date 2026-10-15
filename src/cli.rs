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
    Daemon {
        /// Start a background daemon that survives the launching application
        #[arg(long)]
        detach: bool,
    },
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
    /// Reserve a dormant owner for a deterministically created PR without running an agent
    ReservePrOwner {
        #[arg(long)] id: String,
        #[arg(long)] agent: String,
        #[arg(long)] title: String,
        #[arg(long)] workspace: String,
        #[arg(long)] branch: String,
        #[arg(long)] commit: String,
    },
    /// Recover timestamped provider credits without invoking agents or estimating prices
    UsageSync,
    /// Pause new work for an agent without terminating its current execution
    Pause { agent: String },
    /// Allow a paused agent to take new work again
    Resume { agent: String },
    /// Import issues and run history from Paperclip instance
    ImportPaperclip {
        #[arg(long, default_value = "http://127.0.0.1:3400")]
        url: String,
        #[arg(long, default_value = "b15271fe-75c2-4273-b08e-08c41b2101c2")]
        company: String,
    },
    /// Run automated end-to-end integration tests
    TestE2e,
}
