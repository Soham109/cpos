pub mod analytics;
pub mod config_view;
pub mod contests;
pub mod dashboard;
pub mod problems;
pub mod progress;
pub mod recommend;
pub mod setup;
pub mod target;
pub mod theme;

use ratatui::prelude::*;
use ratatui::widgets::*;

use crate::app::{App, Tab};

/// Rotating-arc spinner shown while data is syncing.
pub const SPINNER: [&str; 6] = ["◜", "◠", "◝", "◞", "◡", "◟"];

pub fn draw(frame: &mut Frame, app: &App) {
    // Paint the whole background first so themed panels sit on a flat canvas.
    frame.render_widget(
        Block::default().style(Style::default().bg(app.theme.bg)),
        frame.area(),
    );

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .horizontal_margin(1)
        .constraints([
            Constraint::Length(3), // header
            Constraint::Length(1), // tabs
            Constraint::Length(1), // spacer
            Constraint::Min(8),    // content
            Constraint::Length(1), // status
        ])
        .split(frame.area());

    draw_header(frame, app, chunks[0]);
    draw_tabs(frame, app, chunks[1]);

    let content = chunks[3];
    match app.active_tab {
        Tab::Dashboard => dashboard::draw(frame, app, content),
        Tab::Problems => problems::draw(frame, app, content),
        Tab::Contests => contests::draw(frame, app, content),
        Tab::Analytics => analytics::draw(frame, app, content),
        Tab::Recommend => recommend::draw(frame, app, content),
        Tab::Target => target::draw(frame, app, content),
        Tab::Config => config_view::draw(frame, app, content),
    }

    draw_status_bar(frame, app, chunks[4]);

    // First-run wizard sits on top of everything.
    if app.setup_active {
        setup::draw(frame, app);
    }
}

fn draw_header(frame: &mut Frame, app: &App, area: Rect) {
    let t = &app.theme;
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(t.accent_dim))
        .style(Style::default().bg(t.bg));
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Min(20), Constraint::Length(46)])
        .split(inner);

    let brand = Paragraph::new(Line::from(vec![
        Span::styled(" ◆ ", Style::default().fg(t.accent)),
        Span::styled(
            "CPOS",
            Style::default().fg(t.accent).add_modifier(Modifier::BOLD),
        ),
        Span::styled("  Competitive Programming OS", Style::default().fg(t.dim)),
    ]));
    frame.render_widget(brand, cols[0]);

    let rating = app.current_rating();
    let rating_span = match rating {
        Some(r) => Span::styled(
            format!("CF {r}"),
            Style::default()
                .fg(app.theme.rating_color(Some(r)))
                .add_modifier(Modifier::BOLD),
        ),
        None => Span::styled("CF —", Style::default().fg(t.dim)),
    };

    let stats = Paragraph::new(Line::from(vec![
        rating_span,
        Span::styled("   ", Style::default()),
        Span::styled("solved ", Style::default().fg(t.dim)),
        Span::styled(
            format!("{}", app.solved_count()),
            Style::default().fg(t.success),
        ),
        Span::styled("/", Style::default().fg(t.dim)),
        Span::styled(format!("{}", app.problems.len()), Style::default().fg(t.fg)),
        Span::styled("   streak ", Style::default().fg(t.dim)),
        Span::styled(
            format!("{}d ", app.current_streak()),
            Style::default()
                .fg(t.warning)
                .add_modifier(Modifier::BOLD),
        ),
    ]))
    .alignment(Alignment::Right);
    frame.render_widget(stats, cols[1]);
}

fn draw_tabs(frame: &mut Frame, app: &App, area: Rect) {
    let t = &app.theme;
    let mut spans: Vec<Span> = vec![Span::raw(" ")];

    for tab in Tab::ALL.iter() {
        if *tab == app.active_tab {
            spans.push(Span::styled(
                format!(" {} ", tab.label()),
                Style::default()
                    .fg(t.bg)
                    .bg(t.accent)
                    .add_modifier(Modifier::BOLD),
            ));
        } else {
            spans.push(Span::styled(
                format!(" {} ", tab.label()),
                Style::default().fg(t.dim),
            ));
        }
        spans.push(Span::raw("  "));
    }

    let tabs = Paragraph::new(Line::from(spans)).style(Style::default().bg(t.bg));
    frame.render_widget(tabs, area);
}

fn draw_status_bar(frame: &mut Frame, app: &App, area: Rect) {
    let t = &app.theme;
    let mut spans: Vec<Span> = Vec::new();

    if app.loading {
        let frame_char = SPINNER[app.spinner_frame % SPINNER.len()];
        spans.push(Span::styled(
            format!(" {frame_char} "),
            Style::default().fg(t.accent).add_modifier(Modifier::BOLD),
        ));
    } else {
        spans.push(Span::styled(" › ", Style::default().fg(t.accent_dim)));
    }

    spans.push(Span::styled(
        app.status_message.clone(),
        Style::default().fg(t.dim),
    ));

    let status = Paragraph::new(Line::from(spans)).style(Style::default().bg(t.bg));
    frame.render_widget(status, area);
}
