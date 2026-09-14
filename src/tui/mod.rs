use std::io::stdout;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use anyhow::Result;
use crossterm::{
    event::{self, Event, KeyCode},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use parking_lot::RwLock;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use tokio::sync::mpsc;

pub mod app;
pub mod ui;

use app::TuiApp;
use crate::engine::state::AppState;
use ui::draw_ui;

pub async fn run_tui(
    state: Arc<RwLock<AppState>>,
    queues_root: impl AsRef<Path>,
    shutdown_tx: mpsc::Sender<()>,
) -> Result<()> {
    enable_raw_mode()?;
    let mut stdout = stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = TuiApp::new(state, queues_root);

    loop {
        terminal.draw(|f| draw_ui(f, &mut app))?;

        if event::poll(Duration::from_millis(200))? {
            if let Event::Key(key) = event::read()? {
                let count = app.get_agent_summaries().len();
                match key.code {
                    KeyCode::Char('q') | KeyCode::Esc => {
                        let _ = shutdown_tx.send(()).await;
                        break;
                    }
                    KeyCode::Down | KeyCode::Char('j') => app.next_agent(count),
                    KeyCode::Up | KeyCode::Char('k') => app.prev_agent(count),
                    _ => {}
                }
            }
        }
    }

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    Ok(())
}
