use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    widgets::{Block, Borders, Cell, Paragraph, Row, Table},
    Frame,
};

use crate::tui::app::TuiApp;

pub fn draw_ui(f: &mut Frame, app: &mut TuiApp) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // Header stats
            Constraint::Min(8),    // Agent Table
            Constraint::Length(8), // Activity Logs
            Constraint::Length(1), // Footer
        ])
        .split(f.area());

    draw_header(f, app, chunks[0]);
    draw_table(f, app, chunks[1]);
    draw_logs(f, app, chunks[2]);
    draw_footer(f, chunks[3]);
}

fn draw_header(f: &mut Frame, app: &TuiApp, area: Rect) {
    let state = app.state.read();
    let total_agents = state.agents.len();
    let active_agents = state.active_tasks.len();
    let cost = state.total_cost_usd;
    let tokens = state.total_tokens;

    let header_text = format!(
        " 📦 SPOOL RUNNER | Agents: {} active / {} total | Tokens: {} | Total Cost: ${:.4} ",
        active_agents, total_agents, tokens, cost
    );

    let p = Paragraph::new(header_text)
        .style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))
        .block(Block::default().borders(Borders::ALL).title(" Overview "));
    f.render_widget(p, area);
}

fn draw_table(f: &mut Frame, app: &mut TuiApp, area: Rect) {
    let summaries = app.get_agent_summaries();
    let header_cells = ["Agent", "Model", "Status", "Active Task", "Inc", "Prog", "Done", "Fail", "Cost ($)", "Tokens"]
        .iter()
        .map(|h| Cell::from(*h).style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)));
    let header = Row::new(header_cells).height(1).bottom_margin(1);

    let rows = summaries.iter().enumerate().map(|(idx, s)| {
        let is_selected = idx == app.selected_agent_idx;
        let status_cell = if s.running {
            Cell::from("● RUNNING").style(Style::default().fg(Color::Green).add_modifier(Modifier::BOLD))
        } else {
            Cell::from("○ IDLE").style(Style::default().fg(Color::DarkGray))
        };

        let task_str = s.active_task.as_deref().unwrap_or("-");
        let cost_str = format!("${:.4}", s.total_cost_usd);

        let row_style = if is_selected {
            Style::default().bg(Color::Rgb(40, 40, 60))
        } else {
            Style::default()
        };

        Row::new(vec![
            Cell::from(s.name.clone()).style(Style::default().fg(Color::White).add_modifier(Modifier::BOLD)),
            Cell::from(s.model.clone()).style(Style::default().fg(Color::Blue)),
            status_cell,
            Cell::from(task_str.to_string()),
            Cell::from(s.incoming_count.to_string()),
            Cell::from(s.in_progress_count.to_string()).style(if s.in_progress_count > 0 { Style::default().fg(Color::Green) } else { Style::default() }),
            Cell::from(s.completed_count.to_string()).style(Style::default().fg(Color::Cyan)),
            Cell::from(s.failed_count.to_string()).style(if s.failed_count > 0 { Style::default().fg(Color::Red) } else { Style::default() }),
            Cell::from(cost_str).style(Style::default().fg(Color::Magenta)),
            Cell::from(s.total_tokens.to_string()),
        ]).style(row_style)
    });

    let widths = [
        Constraint::Length(16),
        Constraint::Length(14),
        Constraint::Length(12),
        Constraint::Length(20),
        Constraint::Length(6),
        Constraint::Length(6),
        Constraint::Length(6),
        Constraint::Length(6),
        Constraint::Length(12),
        Constraint::Length(10),
    ];

    let t = Table::new(rows, widths)
        .header(header)
        .block(Block::default().borders(Borders::ALL).title(" Agent Fleet "));
    f.render_widget(t, area);
}

fn draw_logs(f: &mut Frame, app: &TuiApp, area: Rect) {
    let state = app.state.read();
    let logs_str = state.recent_logs.iter().rev().take(6).cloned().collect::<Vec<_>>();
    let logs_text = logs_str.into_iter().rev().collect::<Vec<_>>().join("\n");

    let p = Paragraph::new(logs_text)
        .style(Style::default().fg(Color::Gray))
        .block(Block::default().borders(Borders::ALL).title(" Live Activity & Transcripts "));
    f.render_widget(p, area);
}

fn draw_footer(f: &mut Frame, area: Rect) {
    let p = Paragraph::new(" [Q] Quit   [↑/↓] Select Agent   [R] Refresh")
        .style(Style::default().fg(Color::DarkGray));
    f.render_widget(p, area);
}
