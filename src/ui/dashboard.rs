use ratatui::prelude::*;
use ratatui::widgets::*;

use crate::app::App;
use crate::ui::progress;

const C: [&str; 5] = [" ████ ", "█     ", "█     ", "█     ", " ████ "];
const P: [&str; 5] = ["█████ ", "█    █", "█████ ", "█     ", "█     "];
const O: [&str; 5] = [" ████ ", "█    █", "█    █", "█    █", " ████ "];
const S: [&str; 5] = [" █████", "█     ", " ████ ", "     █", "█████ "];

pub fn draw(frame: &mut Frame, app: &App, area: Rect) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(10),
            Constraint::Length(6),
            Constraint::Min(6),
        ])
        .split(area);

    draw_banner(frame, app, chunks[0]);
    draw_stat_cards(frame, app, chunks[1]);
    draw_lower(frame, app, chunks[2]);
}

fn draw_banner(frame: &mut Frame, app: &App, area: Rect) {
    let t = &app.theme;
    let mut lines: Vec<Line> = Vec::new();
    lines.push(Line::from(""));

    for r in 0..5 {
        let row = format!("{} {} {} {}", C[r], P[r], O[r], S[r]);
        let color = if r < 2 {
            t.accent
        } else if r < 4 {
            t.accent
        } else {
            t.accent_dim
        };
        lines.push(
            Line::from(Span::styled(
                row,
                Style::default().fg(color).add_modifier(Modifier::BOLD),
            ))
            .alignment(Alignment::Center),
        );
    }

    lines.push(Line::from(""));

    let cf_handle = app.config.handles.get("codeforces").cloned().unwrap_or_default();
    let (cf_label, cf_color) = if cf_handle.is_empty() {
        ("not set".to_string(), t.dim)
    } else {
        (cf_handle, t.success)
    };
    let (cses_label, cses_color) = match app.cses_solved.len() {
        n if n > 0 => (format!("connected ✓  ({n} solved)"), t.success),
        _ if !app.cses_attempted.is_empty() => {
            (format!("connected ({}) attempted", app.cses_attempted.len()), t.warning)
        }
        _ if app.config.cses_session.is_some() => {
            ("cookie set — visit problemset list in browser".to_string(), t.warning)
        }
        _ => (
            "log in on cses.fi + visit problemset list".to_string(),
            t.dim,
        ),
    };
    lines.push(
        Line::from(vec![
            Span::styled("Codeforces ", Style::default().fg(t.dim)),
            Span::styled(cf_label, Style::default().fg(cf_color).add_modifier(Modifier::BOLD)),
            Span::styled("     CSES ", Style::default().fg(t.dim)),
            Span::styled(cses_label, Style::default().fg(cses_color).add_modifier(Modifier::BOLD)),
        ])
        .alignment(Alignment::Center),
    );

    if let Some(port) = app.capture_port {
        lines.push(
            Line::from(vec![
                Span::styled("Browser companion ", Style::default().fg(t.dim)),
                Span::styled(
                    format!("connected :{port}"),
                    Style::default().fg(t.success).add_modifier(Modifier::BOLD),
                ),
            ])
            .alignment(Alignment::Center),
        );
    } else {
        lines.push(
            Line::from(vec![
                Span::styled("Browser companion ", Style::default().fg(t.dim)),
                Span::styled("off", Style::default().fg(t.dim)),
                Span::styled("  — install from ", Style::default().fg(t.dim)),
                Span::styled(
                    "Chrome Web Store",
                    Style::default().fg(t.accent_dim).add_modifier(Modifier::BOLD),
                ),
            ])
            .alignment(Alignment::Center),
        );
    }

    let root = crate::engine::workspace::root(&app.config);
    lines.push(
        Line::from(vec![
            Span::styled("VS Code saves to your open folder  ·  terminal: ", Style::default().fg(t.dim)),
            Span::styled(
                root.display().to_string(),
                Style::default().fg(t.accent_dim).add_modifier(Modifier::BOLD),
            ),
        ])
        .alignment(Alignment::Center),
    );

    let banner = Paragraph::new(lines).style(Style::default().bg(t.bg));
    frame.render_widget(banner, area);
}

fn draw_stat_cards(frame: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Ratio(1, 4),
            Constraint::Ratio(1, 4),
            Constraint::Ratio(1, 4),
            Constraint::Ratio(1, 4),
        ])
        .split(area);

    let rating = app
        .current_rating()
        .map(|r| r.to_string())
        .unwrap_or_else(|| "—".to_string());
    let rating_color = app.theme.rating_color(app.current_rating());

    stat_card(frame, app, cols[0], "PROBLEMS", &app.problems.len().to_string(), app.theme.accent);
    stat_card(
        frame,
        app,
        cols[1],
        "SOLVED",
        &app.solved_count().to_string(),
        app.theme.success,
    );
    stat_card(frame, app, cols[2], "RATING", &rating, rating_color);
    stat_card(
        frame,
        app,
        cols[3],
        "STREAK",
        &format!("{}d", app.current_streak()),
        app.theme.warning,
    );
}

fn stat_card(frame: &mut Frame, app: &App, area: Rect, label: &str, value: &str, color: Color) {
    let t = &app.theme;
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(t.border))
        .style(Style::default().bg(t.bg));
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let v = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(0),
            Constraint::Length(2),
            Constraint::Min(0),
        ])
        .split(inner);

    let content = Paragraph::new(vec![
        Line::from(Span::styled(
            value.to_string(),
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        ))
        .alignment(Alignment::Center),
        Line::from(Span::styled(label, Style::default().fg(t.dim))).alignment(Alignment::Center),
    ]);
    frame.render_widget(content, v[1]);
}

fn draw_lower(frame: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(area);

    draw_weak_tags(frame, app, cols[0]);
    draw_up_next(frame, app, cols[1]);
}

fn draw_weak_tags(frame: &mut Frame, app: &App, area: Rect) {
    let t = &app.theme;
    let block = t.panel("Weakest Topics");
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let weak: Vec<_> = app
        .tag_stats
        .iter()
        .filter(|s| s.solved + s.attempted >= 2)
        .collect();

    if weak.is_empty() {
        let hint = Paragraph::new("  Sync your account to see where to focus.")
            .style(Style::default().fg(t.dim))
            .wrap(Wrap { trim: true });
        frame.render_widget(hint, inner);
        return;
    }

    let max_rows = inner.height as usize;
    for (i, s) in weak.iter().take(max_rows).enumerate() {
        let row = Rect {
            x: inner.x,
            y: inner.y + i as u16,
            width: inner.width,
            height: 1,
        };
        if row.y >= inner.y + inner.height {
            break;
        }

        let cols = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Length(18),
                Constraint::Length(progress::BAR_WIDTH as u16 + 1),
                Constraint::Min(4),
                Constraint::Length(5),
            ])
            .split(row);

        let total = s.solved + s.attempted;
        let rate = if total > 0 {
            s.solved as f64 / total as f64
        } else {
            0.0
        };
        let rate_pct = (rate * 100.0).round() as u32;
        let color = progress::rate_color(t, rate_pct);

        frame.render_widget(
            Paragraph::new(format!(" {}", truncate(&s.tag, 16)))
                .style(Style::default().fg(t.fg)),
            cols[0],
        );

        frame.render_widget(
            Paragraph::new(progress::bar_line(
                progress::BAR_WIDTH,
                rate,
                color,
            )),
            cols[1],
        );

        frame.render_widget(
            Paragraph::new(format!("{rate_pct:>3}%"))
                .style(Style::default().fg(color))
                .alignment(Alignment::Right),
            cols[3],
        );
    }
}

fn draw_up_next(frame: &mut Frame, app: &App, area: Rect) {
    let t = &app.theme;
    let block = t.panel("Recommended Next");
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let recs = app.practice.as_ref().map(|r| &r.recs[..]).unwrap_or(&[]);
    if recs.is_empty() {
        let hint = Paragraph::new("  Sync to get problems picked for your level.")
            .style(Style::default().fg(t.dim))
            .wrap(Wrap { trim: true });
        frame.render_widget(hint, inner);
        return;
    }

    let visible = inner.height.saturating_sub(1) as usize;
    let total = recs.len();
    let rows: Vec<Row> = recs
        .iter()
        .take(visible)
        .map(|rec| {
            let p = &rec.problem;
            Row::new(vec![
                Cell::from(Line::from(Span::styled(
                    format!("  {}", p.display_id()),
                    Style::default().fg(t.dim),
                ))),
                Cell::from(truncate(&p.name, 22)),
                Cell::from(p.difficulty_label())
                    .style(Style::default().fg(app.theme.rating_color(p.rating))),
            ])
        })
        .collect();

    let widths = [
        Constraint::Length(10),
        Constraint::Min(6),
        Constraint::Length(6),
    ];

    let table = Table::new(rows, widths);
    frame.render_widget(table, inner);

    if total > visible {
        let hint = Paragraph::new(format!(
            " +{} more on Practice tab ",
            total - visible.min(total)
        ))
        .style(Style::default().fg(t.dim))
        .alignment(Alignment::Right);
        frame.render_widget(
            hint,
            Rect::new(
                inner.x,
                inner.y + inner.height.saturating_sub(1),
                inner.width,
                1,
            ),
        );
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{truncated}…")
    }
}
