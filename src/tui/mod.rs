use std::io::stdout;
use std::path::Path;
use std::sync::Arc;
use anyhow::Result;
use crossterm::{
    event::{self, EventStream, KeyCode, KeyModifiers},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures::StreamExt;
use parking_lot::RwLock;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use tokio::sync::mpsc;

pub mod app;
pub mod ui;

use app::TuiApp;
use crate::engine::state::AppState;
use crate::queue::watcher::{QueueEvent, QueueWatcher};
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

    let mut app = TuiApp::new(state, &queues_root);
    let mut event_stream = EventStream::new();
    let notify = app.state.read().notify.clone();

    let (queue_tx, mut queue_rx) = mpsc::channel::<QueueEvent>(100);
    let _watcher = QueueWatcher::start(&queues_root, queue_tx)?;

    // Initial render
    terminal.draw(|f| draw_ui(f, &mut app))?;

    loop {
        tokio::select! {
            maybe_event = event_stream.next() => {
                match maybe_event {
                    Some(Ok(event::Event::Key(key))) => {
                        match key.code {
                            KeyCode::Char('q') | KeyCode::Esc => {
                                let _ = shutdown_tx.send(()).await;
                                break;
                            }
                            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                                let _ = shutdown_tx.send(()).await;
                                break;
                            }
                            KeyCode::Down | KeyCode::Char('j') => {
                                let count = app.get_agent_summaries().len();
                                app.next_agent(count);
                            }
                            KeyCode::Up | KeyCode::Char('k') => {
                                let count = app.get_agent_summaries().len();
                                app.prev_agent(count);
                            }
                            KeyCode::Char('r') => {
                                app.reload_summaries();
                            }
                            _ => {}
                        }
                        terminal.draw(|f| draw_ui(f, &mut app))?;
                    }
                    Some(Ok(event::Event::Resize(_, _))) => {
                        terminal.draw(|f| draw_ui(f, &mut app))?;
                    }
                    _ => {}
                }
            }

            _ = notify.notified() => {
                app.reload_summaries();
                terminal.draw(|f| draw_ui(f, &mut app))?;
            }

            Some(_q_event) = queue_rx.recv() => {
                while queue_rx.try_recv().is_ok() {}
                app.reload_summaries();
                terminal.draw(|f| draw_ui(f, &mut app))?;
            }
        }
    }

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    Ok(())
}
