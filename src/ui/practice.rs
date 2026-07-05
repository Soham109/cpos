//! The Practice tab — the merged Recommend + Target view, driven entirely by
//! the central engine in `engine::practice` (the same one behind /recommend).

use ratatui::prelude::*;
use ratatui::widgets::*;

use crate::app::{App, PracticeInput};
use crate::engine::practice::Mode;

pub fn draw(frame: &mut Frame, app: &App, area: Rect) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(5),
            Constraint::Min(5),
            Constraint::Length(1),
        ])
        .split(area);

    draw_header(frame, app, chunks[0]);
    draw_list(frame, app, chunks[1]);
    draw_help(frame, app, chunks[2]);
}

fn draw_header(frame: &mut Frame, app: &App, area: Rect) {
    let t = &app.theme;
    let block = t.panel("Practice");
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines: Vec<Line> = Vec::new();

    // Mode strip: every mode, the active one highlighted.
    let mut mode_spans = vec![Span::raw(" ")];
    for (i, m) in Mode::ALL.iter().enumerate() {
        if i > 0 {
            mode_spans.push(Span::styled(" · ", Style::default().fg(t.dim)));
        }
        if *m == app.practice_mode {
            mode_spans.push(Span::styled(
                m.label(),
                Style::default().fg(t.accent).add_modifier(Modifier::BOLD),
            ));
        } else {
            mode_spans.push(Span::styled(m.label(), Style::default().fg(t.dim)));
        }
    }
    lines.push(Line::from(mode_spans));

    // Status line: level, goal, readiness, active filters.
    if let Some(report) = &app.practice {
        let s = &report.summary;
        let mut spans = vec![
            Span::raw(" "),
            Span::styled("level ≈", Style::default().fg(t.dim)),
            Span::styled(
                s.level.to_string(),
                Style::default().fg(t.fg).add_modifier(Modifier::BOLD),
            ),
        ];
        if let Some(official) = s.official_rating {
            spans.push(Span::styled(
                format!("  rated {official}"),
                Style::default().fg(t.dim),
            ));
        }
        spans.push(Span::styled("  goal ", Style::default().fg(t.dim)));
        spans.push(Span::styled(
            format!("{} {}", s.goal, s.goal_rank),
            Style::default().fg(t.accent),
        ));
        if let Some(pct) = s.readiness_pct {
            spans.push(Span::styled(
                format!("  readiness {pct}%"),
                Style::default().fg(if pct >= 70 { t.success } else { t.warning }),
            ));
        }
        if !app.practice_tags.is_empty() {
            spans.push(Span::styled(
                format!("  tags: {}", app.practice_tags.join(",")),
                Style::default().fg(t.warning),
            ));
        }
        if let Some(y) = app.practice_min_year {
            spans.push(Span::styled(
                format!("  ≥{y}"),
                Style::default().fg(t.warning),
            ));
        }
        lines.push(Line::from(spans));

        // Weak-topic strip from the skill model.
        let mut weak_spans = vec![Span::styled(" weak: ", Style::default().fg(t.dim))];
        if s.weak_tags.is_empty() {
            weak_spans.push(Span::styled(
                "none detected yet — sync more history",
                Style::default().fg(t.dim),
            ));
        }
        for (i, w) in s.weak_tags.iter().take(5).enumerate() {
            if i > 0 {
                weak_spans.push(Span::styled("  ", Style::default()));
            }
            weak_spans.push(Span::styled(w.tag.clone(), Style::default().fg(t.warning)));
            weak_spans.push(Span::styled(
                format!(" ≈{}", w.skill),
                Style::default().fg(t.dim),
            ));
        }
        lines.push(Line::from(weak_spans));
    } else {
        lines.push(Line::from(Span::styled(
            " Press 'r' to sync — recommendations come from your solve history.",
            Style::default().fg(t.dim),
        )));
    }

    // Text-entry overlay for goal / tag filter.
    match app.practice_input {
        PracticeInput::Goal => {
            lines.push(Line::from(vec![
                Span::styled(" goal rating: ", Style::default().fg(t.accent)),
                Span::styled(
                    format!("{}▏", app.practice_input_buf),
                    Style::default().fg(t.fg).add_modifier(Modifier::BOLD),
                ),
                Span::styled("  (enter to set, esc to cancel)", Style::default().fg(t.dim)),
            ]));
        }
        PracticeInput::Tags => {
            lines.push(Line::from(vec![
                Span::styled(" tag filter: ", Style::default().fg(t.accent)),
                Span::styled(
                    format!("{}▏", app.practice_input_buf),
                    Style::default().fg(t.fg).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    "  (comma-separated, empty clears, esc cancels)",
                    Style::default().fg(t.dim),
                ),
            ]));
        }
        PracticeInput::None => {}
    }

    frame.render_widget(Paragraph::new(lines), inner);
}

fn draw_list(frame: &mut Frame, app: &App, area: Rect) {
    let t = &app.theme;
    let mode = app.practice_mode;
    let block = t.panel(&format!("{} — {}", mode.label(), mode.describe()));

    let Some(report) = &app.practice else {
        frame.render_widget(
            Paragraph::new("  Nothing yet — set your Codeforces handle in Config and press 'r'.")
                .style(Style::default().fg(t.dim))
                .block(block),
            area,
        );
        return;
    };
    if report.recs.is_empty() {
        frame.render_widget(
            Paragraph::new(
                "  No matches for this mode/filter. Try clearing the tag filter (f), the year floor (y), or another mode (m).",
            )
            .style(Style::default().fg(t.dim))
            .block(block),
            area,
        );
        return;
    }

    let header = Row::new(vec![
        Cell::from("  Problem"),
        Cell::from("Name"),
        Cell::from("Rating"),
        Cell::from("Year"),
        Cell::from("Why"),
    ])
    .style(t.header_style());

    let visible = (area.height.saturating_sub(4)) as usize;
    let start = if app.practice_selected >= visible {
        app.practice_selected - visible + 1
    } else {
        0
    };

    let rows: Vec<Row> = report
        .recs
        .iter()
        .enumerate()
        .skip(start)
        .take(visible.max(1))
        .map(|(i, rec)| {
            let p = &rec.problem;
            let selected = i == app.practice_selected;
            let row_style = if selected {
                t.selection()
            } else {
                Style::default().fg(t.fg)
            };
            let marker = if selected { "▸" } else { " " };
            let why = rec.reasons.first().cloned().unwrap_or_default();
            Row::new(vec![
                Cell::from(Line::from(vec![
                    Span::styled(format!(" {marker} "), Style::default().fg(t.accent)),
                    Span::styled(p.display_id().to_string(), Style::default().fg(t.dim)),
                ])),
                Cell::from(p.name.clone()),
                Cell::from(p.difficulty_label())
                    .style(Style::default().fg(t.rating_color(p.rating))),
                Cell::from(rec.year.map(|y| y.to_string()).unwrap_or_else(|| "—".into()))
                    .style(Style::default().fg(t.dim)),
                Cell::from(why).style(Style::default().fg(t.dim)),
            ])
            .style(row_style)
        })
        .collect();

    let widths = [
        Constraint::Length(11),
        Constraint::Min(18),
        Constraint::Length(7),
        Constraint::Length(6),
        Constraint::Min(24),
    ];

    frame.render_widget(Table::new(rows, widths).header(header).block(block), area);
}

fn draw_help(frame: &mut Frame, app: &App, area: Rect) {
    let t = &app.theme;
    let total = app.practice.as_ref().map(|r| r.recs.len()).unwrap_or(0);
    let pos = if total > 0 {
        format!("  {}/{}  ", app.practice_selected + 1, total)
    } else {
        "  ".to_string()
    };
    let key = |k: &'static str| Span::styled(k, Style::default().fg(t.accent).add_modifier(Modifier::BOLD));
    let txt = |s: &'static str| Span::styled(s, Style::default().fg(t.dim));
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(pos, Style::default().fg(t.dim)),
            key("j/k "),
            txt("move  "),
            key("enter "),
            txt("solve  "),
            key("m "),
            txt("mode  "),
            key("f "),
            txt("tags  "),
            key("[/] "),
            txt("goal  "),
            key("t "),
            txt("goal#  "),
            key("y "),
            txt("recency"),
        ])),
        area,
    );
}
