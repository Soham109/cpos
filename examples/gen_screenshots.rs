//! Renders each CPOS screen to a JSON cell-grid using the real UI code and a
//! synthetic-but-realistic dataset. `tools/render_screens.py` turns those grids
//! into the PNG screenshots used in the README.
//!
//! Run with: `cargo run --example gen_screenshots`

use std::fs;

use chrono::{Duration, Utc};
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Position;
use ratatui::style::{Color, Modifier};
use ratatui::Terminal;
use serde::Serialize;

use cpos::app::{App, Tab};
use cpos::data::config::Config;
use cpos::data::models::*;
use cpos::ui;

#[derive(Serialize)]
struct CellOut {
    x: u16,
    y: u16,
    ch: String,
    fg: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    bg: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    b: bool,
}

#[derive(Serialize)]
struct ScreenOut {
    cols: u16,
    rows: u16,
    bg: String,
    cells: Vec<CellOut>,
}

const DEFAULT_BG: &str = "#0d0d14";
const DEFAULT_FG: &str = "#d6d6e0";

fn hex(c: Color) -> Option<String> {
    match c {
        Color::Rgb(r, g, b) => Some(format!("#{r:02x}{g:02x}{b:02x}")),
        Color::Reset => None,
        Color::Black => Some("#0d0d14".to_string()),
        Color::White => Some("#ffffff".to_string()),
        Color::Gray => Some("#a0a0aa".to_string()),
        Color::DarkGray => Some("#6c6c84".to_string()),
        _ => None,
    }
}

fn dump_buffer(buf: &Buffer) -> ScreenOut {
    let area = buf.area;
    let mut cells = Vec::new();

    for y in 0..area.height {
        for x in 0..area.width {
            let Some(cell) = buf.cell(Position::new(x, y)) else {
                continue;
            };
            let symbol = cell.symbol().to_string();

            let bg = match cell.bg {
                Color::Rgb(13, 13, 20) | Color::Reset => None,
                other => hex(other),
            };

            let is_blank = symbol.trim().is_empty();
            if is_blank && bg.is_none() {
                continue;
            }

            let fg = hex(cell.fg).unwrap_or_else(|| DEFAULT_FG.to_string());
            let b = cell.modifier.contains(Modifier::BOLD);

            cells.push(CellOut {
                x,
                y,
                ch: symbol,
                fg,
                bg,
                b,
            });
        }
    }

    ScreenOut {
        cols: area.width,
        rows: area.height,
        bg: DEFAULT_BG.to_string(),
        cells,
    }
}

fn render(app: &mut App, width: u16, height: u16) -> ScreenOut {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| ui::draw(frame, app)).unwrap();
    dump_buffer(terminal.backend().buffer())
}

fn cf_problem(id: &str, name: &str, rating: u32, tags: &[&str], solved: u64) -> Problem {
    Problem {
        platform: Platform::Codeforces,
        id: id.to_string(),
        name: name.to_string(),
        url: format!("https://codeforces.com/problemset/problem/{}", id),
        rating: Some(rating),
        tags: tags.iter().map(|s| s.to_string()).collect(),
        category: None,
        solved_count: Some(solved),
        status: SolveStatus::Unsolved,
    }
}

fn cses_problem(id: &str, name: &str, category: &str, rating: u32) -> Problem {
    Problem {
        platform: Platform::Cses,
        id: id.to_string(),
        name: name.to_string(),
        url: format!("https://cses.fi/problemset/task/{id}"),
        rating: Some(rating),
        tags: vec![category.to_string()],
        category: Some(category.to_string()),
        solved_count: None,
        status: SolveStatus::Unsolved,
    }
}

fn ac(problem: &Problem, days_ago: i64) -> Submission {
    submission(problem, Verdict::Accepted, days_ago)
}

fn submission(problem: &Problem, verdict: Verdict, days_ago: i64) -> Submission {
    Submission {
        platform: problem.platform,
        id: format!("{}-{}-{}", problem.id, days_ago, verdict),
        problem_id: problem.id.clone(),
        problem_name: problem.name.clone(),
        verdict,
        language: "GNU C++17".to_string(),
        time_ms: Some(46),
        memory_kb: Some(3200),
        submitted_at: Utc::now() - Duration::days(days_ago),
        tags: problem.tags.clone(),
        rating: problem.rating,
    }
}

fn demo_app() -> App {
    let mut app = App::new(Config::default());

    let problems = vec![
        cf_problem("1A", "Theatre Square", 1000, &["math", "implementation"], 312000),
        cf_problem("4A", "Watermelon", 800, &["brute force", "math"], 480000),
        cf_problem("71A", "Way Too Long Words", 800, &["strings", "implementation"], 410000),
        cf_problem("158A", "Next Round", 800, &["implementation"], 360000),
        cf_problem("231A", "Team", 800, &["brute force", "greedy"], 330000),
        cf_problem("282A", "Bit++", 800, &["implementation"], 280000),
        cf_problem("339A", "Helpful Maths", 800, &["greedy", "sortings", "strings"], 240000),
        cf_problem("466C", "Number of Ways", 1700, &["binary search", "dp", "two pointers"], 41000),
        cf_problem("455A", "Boredom", 1500, &["dp", "sortings"], 88000),
        cf_problem("486C", "Palindrome Transformation", 1900, &["greedy", "two pointers"], 9000),
        cf_problem("520B", "Two Buttons", 1400, &["bfs", "dp", "graphs", "shortest paths"], 96000),
        cf_problem("525D", "Arthur and Walls", 2000, &["dfs and similar", "greedy"], 7800),
        cf_problem("550C", "Divisibility by Eight", 1500, &["brute force", "dp", "math"], 33000),
        cf_problem("577B", "Modulo Sum", 1600, &["dp", "math", "number theory"], 18000),
        cf_problem("600D", "Area of Two Circles", 2700, &["geometry", "math"], 2100),
        cf_problem("604B", "More Cowbell", 1500, &["binary search", "greedy"], 22000),
        cf_problem("616D", "Longest k-Good Segment", 1600, &["binary search", "data structures", "two pointers"], 17000),
        cf_problem("652D", "Nested Segments", 2200, &["data structures", "sortings"], 6400),
        cf_problem("706C", "Hard Problem", 1900, &["dp"], 9100),
        cf_problem("718C", "Sasha and Array", 2400, &["data structures", "math", "matrices"], 2900),
        cf_problem("733D", "Kostya the Sculptor", 1900, &["greedy", "sortings"], 5600),
        cf_problem("761B", "Dasha and friends", 1700, &["brute force", "implementation"], 8800),
        cf_problem("792C", "Divide by Three", 1900, &["dp", "greedy", "math"], 11000),
        cf_problem("803C", "Maximal GCD", 1800, &["constructive", "greedy", "math", "number theory"], 9700),
        cf_problem("814C", "An impassioned Circulation", 1800, &["binary search", "dp", "two pointers"], 7300),
        cf_problem("834D", "The Bakery", 2400, &["data structures", "dp", "divide and conquer"], 4100),
        cf_problem("862B", "Mahmoud and Ehab", 1300, &["dfs and similar", "graphs", "greedy"], 19000),
        cf_problem("877D", "Olya and Energy Drinks", 1900, &["bfs", "dfs and similar", "graphs", "shortest paths"], 6600),
        cf_problem("919D", "Substring", 1900, &["dfs and similar", "dp", "graphs"], 7100),
        cf_problem("950C", "Zebras", 1700, &["constructive", "greedy"], 8200),
        cf_problem("977F", "Consecutive Subsequence", 1700, &["dp"], 16000),
        cf_problem("1003D", "Coins and Queries", 1500, &["bitmasks", "greedy"], 24000),
        cf_problem("1006F", "Xor-Paths", 2300, &["bitmasks", "dp", "meet-in-the-middle"], 3400),
        cf_problem("1break", "Segment Tree Drills", 2000, &["data structures", "trees"], 5000),
        cf_problem("1095F", "Make It Connected", 2000, &["dsu", "graphs", "greedy", "trees"], 4700),
        cf_problem("1110C", "Meaningless Operations", 1600, &["bitmasks", "constructive", "math", "number theory"], 13000),
    ];

    let cses = vec![
        cses_problem("1068", "Weird Algorithm", "Introductory Problems", 800),
        cses_problem("1083", "Missing Number", "Introductory Problems", 800),
        cses_problem("1622", "Permutations", "Introductory Problems", 900),
        cses_problem("1635", "Coin Combinations I", "Dynamic Programming", 1300),
        cses_problem("1636", "Coin Combinations II", "Dynamic Programming", 1400),
        cses_problem("1158", "Book Shop", "Dynamic Programming", 1500),
        cses_problem("1671", "Shortest Routes I", "Graph Algorithms", 1500),
        cses_problem("1672", "Shortest Routes II", "Graph Algorithms", 1700),
        cses_problem("1648", "Dynamic Range Sum Queries", "Range Queries", 1600),
        cses_problem("1132", "Tree Diameter", "Tree Algorithms", 1700),
        cses_problem("1640", "Sum of Two Values", "Sorting and Searching", 1100),
        cses_problem("1090", "Ferris Wheel", "Sorting and Searching", 1200),
    ];

    app.problems = problems.iter().cloned().chain(cses.iter().cloned()).collect();

    // Submissions: solve most easy/medium problems, attempt some hard ones.
    let mut subs = Vec::new();
    let solved_specs: &[(&str, i64)] = &[
        ("1A", 320), ("4A", 318), ("71A", 300), ("158A", 290), ("231A", 250),
        ("282A", 240), ("339A", 232), ("455A", 60), ("520B", 58), ("550C", 41),
        ("577B", 30), ("604B", 21), ("761B", 14), ("862B", 12), ("977F", 9),
        ("1003D", 7), ("1110C", 6), ("466C", 5), ("950C", 4), ("792C", 3),
        ("803C", 2), ("706C", 1), ("814C", 0),
        ("1068", 200), ("1083", 196), ("1622", 120), ("1635", 40), ("1636", 38),
        ("1158", 22), ("1640", 16), ("1090", 11),
    ];
    for (id, days) in solved_specs {
        if let Some(p) = app.problems.iter().find(|p| &p.id == id) {
            subs.push(ac(p, *days));
        }
    }
    // Attempts that never got solved (drive the "weak topics" analysis).
    let attempt_specs: &[(&str, i64)] = &[
        ("718C", 8), ("834D", 7), ("1006F", 5), ("652D", 9), ("525D", 10),
        ("877D", 12), ("919D", 13), ("1095F", 6), ("1671", 15), ("1672", 14),
        ("1132", 18),
    ];
    for (id, days) in attempt_specs {
        if let Some(p) = app.problems.iter().find(|p| &p.id == id) {
            subs.push(submission(p, Verdict::WrongAnswer, *days));
            subs.push(submission(p, Verdict::TimeLimitExceeded, *days));
        }
    }
    // Extra activity sprinkled across the year for a fuller heatmap.
    for d in [2, 3, 4, 6, 8, 11, 17, 23, 35, 44, 51, 70, 95, 130, 180, 210, 240, 280, 300] {
        if let Some(p) = app.problems.first() {
            subs.push(ac(p, d));
        }
    }
    app.submissions = subs;

    // Rating history climbing to 1847.
    let ratings = [
        ("Codeforces Round 600 (Div. 2)", 0u32, 1043u32, 360i64),
        ("Educational Codeforces Round 78", 1043, 1188, 320),
        ("Codeforces Round 612 (Div. 2)", 1188, 1305, 280),
        ("Codeforces Round 631 (Div. 2)", 1305, 1422, 240),
        ("Educational Codeforces Round 90", 1422, 1499, 200),
        ("Codeforces Round 660 (Div. 2)", 1499, 1607, 165),
        ("Codeforces Round 690 (Div. 1)", 1607, 1566, 130),
        ("Educational Codeforces Round 102", 1566, 1672, 95),
        ("Codeforces Round 720 (Div. 2)", 1672, 1740, 60),
        ("Codeforces Round 745 (Div. 1)", 1740, 1788, 30),
        ("Educational Codeforces Round 130", 1788, 1847, 8),
    ];
    app.rating_history = ratings
        .iter()
        .map(|(name, old, new, days)| RatingChange {
            contest_name: name.to_string(),
            old_rating: *old,
            new_rating: *new,
            timestamp: Utc::now() - Duration::days(*days),
        })
        .collect();

    // A few synthetic contests for the Contests screen.
    let now = Utc::now();
    let mk = |id: &str, name: &str, start: chrono::DateTime<Utc>, dur: u64, phase: ContestPhase| {
        Contest {
            platform: Platform::Codeforces,
            id: id.to_string(),
            name: name.to_string(),
            url: format!("https://codeforces.com/contest/{id}"),
            start_time: start,
            duration_seconds: dur,
            phase,
        }
    };
    app.set_contests(vec![
        mk("1990", "Codeforces Round 990 (Div. 2)", now + Duration::days(2) + Duration::hours(3), 7800, ContestPhase::Before),
        mk("1991", "Educational Codeforces Round 178", now + Duration::days(5), 7200, ContestPhase::Before),
        mk("1989", "Codeforces Round 989 (Div. 1 + Div. 2)", now - Duration::days(3), 9000, ContestPhase::Finished),
        mk("1988", "Codeforces Round 988 (Div. 2)", now - Duration::days(6), 7200, ContestPhase::Finished),
        mk("1987", "Educational Codeforces Round 177", now - Duration::days(11), 7200, ContestPhase::Finished),
        mk("1986", "Codeforces Round 986 (Div. 3)", now - Duration::days(14), 8100, ContestPhase::Finished),
    ]);

    // Pretend both platforms are connected so the dashboard status reads true.
    app.config
        .handles
        .insert("codeforces".to_string(), "tourist_fan".to_string());
    app.config.cses_session = Some("demo-session-cookie".to_string());
    app.cses_solved = ["1068", "1083", "1622", "1635", "1636", "1158", "1640", "1090"]
        .iter()
        .map(|s| s.to_string())
        .collect();

    app.mark_solved_problems();
    app.apply_filters();
    app.compute_analytics();
    app.compute_practice();
    app
}

fn main() {
    let out_dir = "docs/screens";
    fs::create_dir_all(out_dir).unwrap();

    // A realistic, comfortably-sized terminal — not full screen — so the README
    // reflects what most people actually see.
    let width = 100u16;
    let height = 30u16;

    let screens = [
        (Tab::Dashboard, "dashboard"),
        (Tab::Problems, "problems"),
        (Tab::Contests, "contests"),
        (Tab::Analytics, "analytics"),
        (Tab::Practice, "practice"),
        (Tab::Config, "config"),
    ];

    for (tab, name) in screens {
        let mut app = demo_app();
        app.active_tab = tab;
        if tab == Tab::Problems {
            app.problem_selected = 7;
        }
        let screen = render(&mut app, width, height);
        let json = serde_json::to_string(&screen).unwrap();
        let path = format!("{out_dir}/{name}.json");
        fs::write(&path, json).unwrap();
        println!("wrote {path}");
    }

    // Theme showcase: dashboard rendered in each accent.
    for theme_name in cpos::ui::theme::Theme::NAMES {
        let mut app = demo_app();
        app.active_tab = Tab::Dashboard;
        app.config.theme = theme_name.to_string();
        app.theme = cpos::ui::theme::Theme::from_name(theme_name);
        let screen = render(&mut app, width, 20);
        let json = serde_json::to_string(&screen).unwrap();
        let path = format!("{out_dir}/theme_{theme_name}.json");
        fs::write(&path, json).unwrap();
        println!("wrote {path}");
    }
}
