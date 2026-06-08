use ratatui::prelude::*;
use ratatui::widgets::*;

use crate::app::App;
use crate::engine::target::{Readiness, TargetPlan};
use crate::ui::progress;

pub fn draw(frame: &mut Frame, app: &App, area: Rect) {
    let t = &app.theme;
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(5), // goal + status header
            Constraint::Length(10), // topics to cover
            Constraint::Min(6),    // step-by-step plan
        ])
        .split(area);

    draw_goal_header(frame, app, chunks[0]);

    let Some(plan) = app.target_plan.as_ref() else {
        let empty = t.panel("Topics to Cover");
        frame.render_widget(
            Paragraph::new("  Sync your Codeforces data (press 'r'), then pick a goal above.")
                .style(Style::default().fg(t.dim))
                .block(empty),
            chunks[1],
        );
        return;
    };

    draw_focus_topics(frame, app, plan, chunks[1]);
    draw_plan(frame, app, plan, chunks[2]);
}

fn draw_goal_header(frame: &mut Frame, app: &App, area: Rect) {
    let t = &app.theme;
    let block = t.panel_accent("Target Rating");
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .split(inner);

    // Line 1 — the goal selector (or the custom-entry field when typing).
    if app.target_input_active {
        let buf = if app.target_input_buf.is_empty() {
            "____".to_string()
        } else {
            app.target_input_buf.clone()
        };
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(" Goal  ", Style::default().fg(t.dim)),
                Span::styled(
                    format!("[{buf}]"),
                    Style::default().fg(t.accent).add_modifier(Modifier::BOLD),
                ),
                Span::styled("  enter to set · esc to cancel", Style::default().fg(t.dim)),
            ])),
            rows[0],
        );
    } else {
        let rating = app.target_rating;
        let rank = crate::engine::target::rank_name(rating);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(" Goal  ", Style::default().fg(t.dim)),
                Span::styled("◂ ", Style::default().fg(t.accent_dim)),
                Span::styled(
                    format!("{rating}"),
                    Style::default()
                        .fg(app.theme.rating_color(Some(rating)))
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(format!(" {rank}"), Style::default().fg(t.fg)),
                Span::styled(" ▸", Style::default().fg(t.accent_dim)),
                Span::styled("    [ ] change · t type exact", Style::default().fg(t.dim)),
            ])),
            rows[0],
        );
    }

    // Line 2 — where you stand and the gap.
    let Some(plan) = app.target_plan.as_ref() else {
        return;
    };
    let gap_span = if plan.gap > 0 {
        Span::styled(
            format!("+{} to go", plan.gap),
            Style::default().fg(t.warning).add_modifier(Modifier::BOLD),
        )
    } else {
        Span::styled(
            "goal reached — push higher".to_string(),
            Style::default().fg(t.success).add_modifier(Modifier::BOLD),
        )
    };
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(" Now  ", Style::default().fg(t.dim)),
            Span::styled(
                format!("~{}", plan.current_level),
                Style::default().fg(app.theme.rating_color(Some(plan.current_level))),
            ),
            Span::styled(format!(" {}", plan.current_rank), Style::default().fg(t.dim)),
            Span::styled("    Gap ", Style::default().fg(t.dim)),
            gap_span,
            Span::styled(
                format!("    {} solved in {}–{} band", plan.solved_in_band, plan.band_floor, plan.target_rating),
                Style::default().fg(t.dim),
            ),
        ])),
        rows[1],
    );

    // Line 3 — overall readiness bar.
    let ratio = plan.readiness_pct as f64 / 100.0;
    let color = progress::rate_color(t, plan.readiness_pct);
    let bar = progress::bar_line(20, ratio, color);
    let mut spans = vec![Span::styled(" Readiness ", Style::default().fg(t.dim))];
    spans.extend(bar.spans);
    spans.push(Span::styled(
        format!(" {}%", plan.readiness_pct),
        Style::default().fg(color).add_modifier(Modifier::BOLD),
    ));
    frame.render_widget(Paragraph::new(Line::from(spans)), rows[2]);
}

fn draw_focus_topics(frame: &mut Frame, app: &App, plan: &TargetPlan, area: Rect) {
    let t = &app.theme;
    let title = format!("Topics to Cover — to reach {}", plan.target_rating);
    let block = t.panel(&title);

    if plan.focus_topics.is_empty() {
        frame.render_widget(
            Paragraph::new("  Strong coverage — you're on track for this goal. Keep grinding the plan below.")
                .style(Style::default().fg(t.success))
                .block(block),
            area,
        );
        return;
    }

    let visible = block.inner(area).height.saturating_sub(1) as usize;

    let rows: Vec<Row> = plan
        .focus_topics
        .iter()
        .take(visible)
        .map(|tr| {
            let color = status_color(t, tr.status);
            let best = tr
                .max_solved
                .map(|r| r.to_string())
                .unwrap_or_else(|| "—".to_string());
            let bar = progress::bar_line(14, tr.priority, color);
            Row::new(vec![
                Cell::from(format!(" {}", truncate(&tr.topic, 22)))
                    .style(Style::default().fg(t.fg)),
                Cell::from(tr.status.label()).style(Style::default().fg(color)),
                Cell::from(format!("{:>5}", tr.needed_rating)).style(Style::default().fg(t.dim)),
                Cell::from(format!("{best:>5}")).style(Style::default().fg(t.dim)),
                Cell::from(bar),
            ])
        })
        .collect();

    let header = Row::new(vec![
        Cell::from(" Topic"),
        Cell::from("Status"),
        Cell::from(" Needs"),
        Cell::from(" Best"),
        Cell::from(" Priority"),
    ])
    .style(t.header_style())
    .bottom_margin(1);

    let widths = [
        Constraint::Length(24),
        Constraint::Length(12),
        Constraint::Length(7),
        Constraint::Length(7),
        Constraint::Length(16),
    ];

    let table = Table::new(rows, widths)
        .header(header)
        .column_spacing(1)
        .block(block);
    frame.render_widget(table, area);
}

fn draw_plan(frame: &mut Frame, app: &App, plan: &TargetPlan, area: Rect) {
    let t = &app.theme;
    let block = t.panel("Your Step-by-Step Plan");

    if plan.steps.is_empty() {
        frame.render_widget(
            Paragraph::new("  No Codeforces problems cached for this band yet — press 'r' to sync.")
                .style(Style::default().fg(t.dim))
                .block(block),
            area,
        );
        return;
    }

    let body = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(3), Constraint::Length(1)])
        .split(area);
    let table_area = body[0];
    let help_area = body[1];

    let header = Row::new(vec![
        Cell::from("  Step"),
        Cell::from("Name"),
        Cell::from("Rating"),
        Cell::from("Focus"),
    ])
    .style(t.header_style());

    let visible = (table_area.height.saturating_sub(3)) as usize;
    let start = if app.target_selected >= visible {
        app.target_selected - visible + 1
    } else {
        0
    };

    let rows: Vec<Row> = plan
        .steps
        .iter()
        .enumerate()
        .skip(start)
        .take(visible)
        .map(|(i, step)| {
            let p = &step.problem;
            let selected = i == app.target_selected;
            let row_style = if selected {
                t.selection()
            } else {
                Style::default().fg(t.fg)
            };
            let marker = if selected { "▸" } else { " " };
            let focus_color = if step.reason.contains("(focus)") {
                t.warning
            } else {
                t.dim
            };
            Row::new(vec![
                Cell::from(Line::from(vec![
                    Span::styled(format!(" {marker} "), Style::default().fg(t.accent)),
                    Span::styled(format!("{:>2} ", i + 1), Style::default().fg(t.dim)),
                    Span::styled(p.display_id().to_string(), Style::default().fg(t.dim)),
                ])),
                Cell::from(p.name.clone()),
                Cell::from(p.difficulty_label())
                    .style(Style::default().fg(app.theme.rating_color(p.rating))),
                Cell::from(format!("{} · {}", step.stage, truncate(&step.topic, 18)))
                    .style(Style::default().fg(focus_color)),
            ])
            .style(row_style)
        })
        .collect();

    let widths = [
        Constraint::Length(18),
        Constraint::Min(18),
        Constraint::Length(8),
        Constraint::Min(18),
    ];

    let table = Table::new(rows, widths).header(header).block(block);
    frame.render_widget(table, table_area);

    let help = Paragraph::new(Line::from(vec![
        Span::styled(
            format!("  {}/{}  ", app.target_selected + 1, plan.steps.len()),
            Style::default().fg(t.dim),
        ),
        Span::styled("j/k ", Style::default().fg(t.accent).add_modifier(Modifier::BOLD)),
        Span::styled("move   ", Style::default().fg(t.dim)),
        Span::styled("enter/o ", Style::default().fg(t.accent).add_modifier(Modifier::BOLD)),
        Span::styled("open & solve   ", Style::default().fg(t.dim)),
        Span::styled("[ ] ", Style::default().fg(t.accent).add_modifier(Modifier::BOLD)),
        Span::styled("goal   ", Style::default().fg(t.dim)),
        Span::styled("t ", Style::default().fg(t.accent).add_modifier(Modifier::BOLD)),
        Span::styled("type goal", Style::default().fg(t.dim)),
    ]));
    frame.render_widget(help, help_area);
}

fn status_color(theme: &crate::ui::theme::Theme, status: Readiness) -> Color {
    match status {
        Readiness::Untouched => theme.danger,
        Readiness::Gap => theme.warning,
        Readiness::Developing => theme.accent,
        Readiness::Ready => theme.success,
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
