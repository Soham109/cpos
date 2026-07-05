//! The central practice engine — one scoring core behind the TUI Practice tab
//! and the browser companion's Recommend tab (via `GET /recommend`).
//!
//! What it models, per user, from the full local history:
//! - **Per-tag skill**: a recency-decayed, clean-solve-weighted 75th percentile
//!   of the ratings you've ACed in that tag. Solves bled through many WAs count
//!   less than first-try ACs; last year's grind counts less than last week's.
//! - **Freshness**: problems are dated by their contest (joined through the
//!   contests table, contest-id ordering as fallback), so recommendations skew
//!   to recent problemsets instead of decade-old classics.
//! - **Fragility**: attempted-but-never-solved problems are tracked separately
//!   and surface through the `upsolve` mode and skill discounts.
//!
//! Query modes:
//! - `auto`     — balanced: learning zone + weak topics + fresh problems.
//! - `weakness` — heaviest on the tags your skill lags behind your level.
//! - `push`     — above your ceiling on your strongest tags.
//! - `refresh`  — spaced repetition: topics you knew but haven't touched lately.
//! - `upsolve`  — problems you attempted and never got accepted.
//! - `explore`  — core topics you have never solved, at an accessible level.
//! - `plan`     — the goal-driven rung-by-rung curriculum (the old Target tab).

use std::collections::{HashMap, HashSet};

use chrono::{Datelike, Utc};
use serde::Serialize;

use crate::data::models::*;
use crate::engine::target::{self, topic_essential};

pub const DEFAULT_COUNT: usize = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Auto,
    Weakness,
    Push,
    Refresh,
    Upsolve,
    Explore,
    Plan,
}

impl Mode {
    pub const ALL: [Mode; 7] = [
        Mode::Auto,
        Mode::Weakness,
        Mode::Push,
        Mode::Refresh,
        Mode::Upsolve,
        Mode::Explore,
        Mode::Plan,
    ];

    pub fn parse(s: &str) -> Mode {
        match s.trim().to_lowercase().as_str() {
            "weakness" | "weak" => Mode::Weakness,
            "push" | "stretch" => Mode::Push,
            "refresh" | "rusty" => Mode::Refresh,
            "upsolve" | "redeem" | "unfinished" => Mode::Upsolve,
            "explore" | "new" => Mode::Explore,
            "plan" | "target" | "roadmap" => Mode::Plan,
            _ => Mode::Auto,
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Mode::Auto => "Auto",
            Mode::Weakness => "Weakness",
            Mode::Push => "Push",
            Mode::Refresh => "Refresh",
            Mode::Upsolve => "Upsolve",
            Mode::Explore => "Explore",
            Mode::Plan => "Plan",
        }
    }

    pub fn describe(&self) -> &'static str {
        match self {
            Mode::Auto => "balanced mix: learning zone, weak topics, fresh problems",
            Mode::Weakness => "attack the tags where your skill lags your level",
            Mode::Push => "above your ceiling, on your strongest topics",
            Mode::Refresh => "topics you knew but haven't touched in a while",
            Mode::Upsolve => "upsolve: problems you attempted but never got accepted",
            Mode::Explore => "core topics you've never solved, at an entry level",
            Mode::Plan => "rung-by-rung curriculum toward your goal rating",
        }
    }

    pub fn next(&self) -> Mode {
        let i = Mode::ALL.iter().position(|m| m == self).unwrap_or(0);
        Mode::ALL[(i + 1) % Mode::ALL.len()]
    }

    pub fn prev(&self) -> Mode {
        let i = Mode::ALL.iter().position(|m| m == self).unwrap_or(0);
        Mode::ALL[(i + Mode::ALL.len() - 1) % Mode::ALL.len()]
    }
}

#[derive(Debug, Clone)]
pub struct PracticeQuery {
    pub mode: Mode,
    /// Lowercased tag filters: problem must carry at least one (empty = any).
    pub tags: Vec<String>,
    pub exclude_tags: Vec<String>,
    pub min_rating: Option<u32>,
    pub max_rating: Option<u32>,
    /// Only problems from contests in or after this year (freshness hard filter).
    pub min_year: Option<i32>,
    pub count: usize,
    /// Goal rating; defaults to the next rank milestone above the user.
    pub goal: Option<u32>,
}

impl Default for PracticeQuery {
    fn default() -> Self {
        Self {
            mode: Mode::Auto,
            tags: Vec::new(),
            exclude_tags: Vec::new(),
            min_rating: None,
            max_rating: None,
            min_year: None,
            count: DEFAULT_COUNT,
            goal: None,
        }
    }
}

/// Parse an HTTP query string (`mode=weakness&tags=dp,graphs&min=1200…`).
pub fn parse_query(qs: &str) -> PracticeQuery {
    let mut q = PracticeQuery::default();
    for pair in qs.split('&') {
        let mut it = pair.splitn(2, '=');
        let key = it.next().unwrap_or("");
        let val = url_decode(it.next().unwrap_or(""));
        match key {
            "mode" => q.mode = Mode::parse(&val),
            "tags" => {
                q.tags = val
                    .split(',')
                    .map(|t| t.trim().to_lowercase())
                    .filter(|t| !t.is_empty())
                    .collect()
            }
            "exclude" | "exclude_tags" => {
                q.exclude_tags = val
                    .split(',')
                    .map(|t| t.trim().to_lowercase())
                    .filter(|t| !t.is_empty())
                    .collect()
            }
            "min" | "min_rating" => q.min_rating = val.parse().ok(),
            "max" | "max_rating" => q.max_rating = val.parse().ok(),
            "year" | "min_year" => q.min_year = val.parse().ok(),
            "count" => {
                if let Ok(n) = val.parse::<usize>() {
                    q.count = n.clamp(1, 100);
                }
            }
            "goal" => q.goal = val.parse().ok().map(target::clamp_target),
            _ => {}
        }
    }
    q
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else if bytes[i] == b'%' && i + 2 < bytes.len() {
            // %XX decode; fall back to the raw byte on bad input
            match std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                Some(v) => {
                    out.push(v);
                    i += 3;
                }
                None => {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Debug, Clone, Serialize)]
pub struct TagSkill {
    pub tag: String,
    /// Estimated comfortable rating in this tag.
    pub skill: u32,
    /// How much (decayed) evidence backs the estimate.
    pub volume: f64,
    pub solved: u32,
    /// Distinct problems attempted but never ACed.
    pub attempted_only: u32,
    /// Days since the last submission touching this tag.
    pub days_since: Option<i64>,
    /// True when this tag drags noticeably below the user's overall level.
    pub weak: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PracticeRec {
    pub problem: Problem,
    pub score: f64,
    pub reasons: Vec<String>,
    /// Contest year, when the contest is known.
    pub year: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PracticeSummary {
    /// Practice level estimated from solves (blended with official rating).
    pub level: u32,
    pub official_rating: Option<u32>,
    pub goal: u32,
    pub goal_rank: &'static str,
    /// 0..100 goal readiness (from the curriculum analysis), when history exists.
    pub readiness_pct: Option<u32>,
    pub total_solved: usize,
    pub mode: Mode,
    pub mode_note: &'static str,
    /// Weakest curriculum tags first (the ones worth practicing).
    pub weak_tags: Vec<TagSkill>,
    pub strong_tags: Vec<TagSkill>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PracticeReport {
    pub summary: PracticeSummary,
    pub recs: Vec<PracticeRec>,
}

// ---------------------------------------------------------------------------
// history digestion

struct ProblemHistory {
    rating: Option<u32>,
    tags: Vec<String>,
    first_ac: Option<chrono::DateTime<Utc>>,
    attempts_before_ac: u32,
    total_attempts: u32,
    last_touch: chrono::DateTime<Utc>,
}

fn digest_history(submissions: &[Submission]) -> HashMap<String, ProblemHistory> {
    // Order submissions oldest → newest per problem so "attempts before AC"
    // means what it says. get_submissions returns newest-first; don't rely on it.
    let mut by_problem: HashMap<String, Vec<&Submission>> = HashMap::new();
    for s in submissions {
        by_problem.entry(submission_key(s)).or_default().push(s);
    }
    let mut out = HashMap::new();
    for (key, mut subs) in by_problem {
        subs.sort_by_key(|s| s.submitted_at);
        let mut h = ProblemHistory {
            rating: None,
            tags: Vec::new(),
            first_ac: None,
            attempts_before_ac: 0,
            total_attempts: 0,
            last_touch: subs[0].submitted_at,
        };
        for s in &subs {
            h.total_attempts += 1;
            h.last_touch = h.last_touch.max(s.submitted_at);
            if h.rating.is_none() {
                h.rating = s.rating;
            }
            if h.tags.is_empty() && !s.tags.is_empty() {
                h.tags = s.tags.iter().map(|t| t.to_lowercase()).collect();
            }
            if s.verdict == Verdict::Accepted && h.first_ac.is_none() {
                h.first_ac = Some(s.submitted_at);
                h.attempts_before_ac = h.total_attempts - 1;
            }
        }
        out.insert(key, h);
    }
    out
}

/// Weight of one solve as skill evidence: decays with age, discounted when the
/// AC needed many wrong attempts.
fn solve_weight(days_old: f64, wa_before_ac: u32) -> f64 {
    let decay = 0.5_f64.powf(days_old / 240.0).max(0.05);
    let clean = 1.0 / (1.0 + 0.3 * wa_before_ac as f64);
    decay * clean
}

fn weighted_percentile(mut values: Vec<(u32, f64)>, pct: f64) -> Option<u32> {
    if values.is_empty() {
        return None;
    }
    values.sort_by_key(|(r, _)| *r);
    let total: f64 = values.iter().map(|(_, w)| w).sum();
    if total <= 0.0 {
        return values.last().map(|(r, _)| *r);
    }
    let cut = total * pct;
    let mut acc = 0.0;
    for (r, w) in &values {
        acc += w;
        if acc >= cut {
            return Some(*r);
        }
    }
    values.last().map(|(r, _)| *r)
}

fn compute_skills(
    history: &HashMap<String, ProblemHistory>,
    now: chrono::DateTime<Utc>,
) -> (HashMap<String, TagSkill>, Option<u32>) {
    let mut per_tag: HashMap<String, Vec<(u32, f64)>> = HashMap::new();
    let mut per_tag_meta: HashMap<String, (u32, u32, Option<i64>)> = HashMap::new(); // solved, attempted_only, min days
    let mut overall: Vec<(u32, f64)> = Vec::new();

    for h in history.values() {
        let days_since = (now - h.last_touch).num_days();
        let solved = h.first_ac.is_some();
        if let (Some(rating), Some(ac_at)) = (h.rating, h.first_ac) {
            let w = solve_weight((now - ac_at).num_days().max(0) as f64, h.attempts_before_ac);
            overall.push((rating, w));
            for tag in &h.tags {
                per_tag.entry(tag.clone()).or_default().push((rating, w));
            }
        }
        for tag in &h.tags {
            let meta = per_tag_meta.entry(tag.clone()).or_insert((0, 0, None));
            if solved {
                meta.0 += 1;
            } else {
                meta.1 += 1;
            }
            meta.2 = Some(match meta.2 {
                Some(d) => d.min(days_since),
                None => days_since,
            });
        }
    }

    let overall_level = weighted_percentile(overall, 0.75);

    let mut skills = HashMap::new();
    for (tag, samples) in per_tag {
        let volume: f64 = samples.iter().map(|(_, w)| w).sum();
        let skill = weighted_percentile(samples, 0.75).unwrap_or(800);
        let (solved, attempted_only, days_since) =
            per_tag_meta.get(&tag).copied().unwrap_or((0, 0, None));
        skills.insert(
            tag.clone(),
            TagSkill {
                tag,
                skill,
                volume,
                solved,
                attempted_only,
                days_since,
                weak: false, // filled in once the level is known
            },
        );
    }
    // Tags attempted but never solved still deserve an entry (deep weakness).
    for (tag, (solved, attempted_only, days_since)) in &per_tag_meta {
        if *solved == 0 && !skills.contains_key(tag) {
            skills.insert(
                tag.clone(),
                TagSkill {
                    tag: tag.clone(),
                    skill: overall_level.unwrap_or(1000).saturating_sub(300),
                    volume: 0.0,
                    solved: 0,
                    attempted_only: *attempted_only,
                    days_since: *days_since,
                    weak: true,
                },
            );
        }
    }

    (skills, overall_level)
}

// ---------------------------------------------------------------------------
// freshness

/// Map each problem to its contest's start year. Contest ids are the numeric
/// prefix of CF problem ids ("1974B" → 1974). When the contests table doesn't
/// know a contest, approximate by linear interpolation over known contests —
/// CF ids grow roughly monotonically with time.
struct FreshnessIndex {
    year_by_contest: HashMap<u32, i32>,
    id_year_fit: Option<(f64, f64)>, // (slope, intercept) year ≈ slope*id + intercept
    now_year: i32,
}

impl FreshnessIndex {
    fn build(contests: &[Contest], now: chrono::DateTime<Utc>) -> Self {
        let mut year_by_contest = HashMap::new();
        let mut points: Vec<(f64, f64)> = Vec::new();
        for c in contests {
            if let Ok(id) = c.id.parse::<u32>() {
                let year = c.start_time.year();
                year_by_contest.insert(id, year);
                points.push((id as f64, year as f64));
            }
        }
        let id_year_fit = if points.len() >= 10 {
            let n = points.len() as f64;
            let sx: f64 = points.iter().map(|(x, _)| x).sum();
            let sy: f64 = points.iter().map(|(_, y)| y).sum();
            let sxx: f64 = points.iter().map(|(x, _)| x * x).sum();
            let sxy: f64 = points.iter().map(|(x, y)| x * y).sum();
            let denom = n * sxx - sx * sx;
            if denom.abs() > f64::EPSILON {
                let slope = (n * sxy - sx * sy) / denom;
                let intercept = (sy - slope * sx) / n;
                Some((slope, intercept))
            } else {
                None
            }
        } else {
            None
        };
        Self {
            year_by_contest,
            id_year_fit,
            now_year: now.year(),
        }
    }

    fn contest_of(problem_id: &str) -> Option<u32> {
        let digits: String = problem_id.chars().take_while(|c| c.is_ascii_digit()).collect();
        digits.parse().ok()
    }

    fn year_of(&self, problem: &Problem) -> Option<i32> {
        if problem.platform != Platform::Codeforces {
            return None;
        }
        let cid = Self::contest_of(&problem.id)?;
        if let Some(y) = self.year_by_contest.get(&cid) {
            return Some(*y);
        }
        self.id_year_fit
            .map(|(m, b)| (m * cid as f64 + b).round() as i32)
            .map(|y| y.clamp(2010, self.now_year))
    }

    /// 0..1, 1.0 = this year, decaying with a ~3 year half-life.
    fn freshness(&self, year: Option<i32>) -> f64 {
        match year {
            Some(y) => {
                let age = (self.now_year - y).max(0) as f64;
                0.5_f64.powf(age / 3.0)
            }
            None => 0.25, // unknown age: assume oldish
        }
    }
}

// ---------------------------------------------------------------------------
// scoring

struct ModeWeights {
    zone: f64,
    learn: f64,
    fresh: f64,
    quality: f64,
    refresh: f64,
    novelty: f64,
    upsolve: f64,
    /// Preferred gap above the anchor skill, and its tolerance.
    gap_center: f64,
    gap_sigma: f64,
}

fn weights_for(mode: Mode) -> ModeWeights {
    match mode {
        Mode::Auto => ModeWeights { zone: 3.0, learn: 2.2, fresh: 1.6, quality: 0.8, refresh: 0.4, novelty: 0.6, upsolve: 0.3, gap_center: 200.0, gap_sigma: 150.0 },
        Mode::Weakness => ModeWeights { zone: 2.4, learn: 3.6, fresh: 1.1, quality: 0.6, refresh: 0.3, novelty: 0.4, upsolve: 0.3, gap_center: 100.0, gap_sigma: 130.0 },
        Mode::Push => ModeWeights { zone: 3.6, learn: 0.4, fresh: 1.5, quality: 0.9, refresh: 0.0, novelty: 0.0, upsolve: 0.0, gap_center: 350.0, gap_sigma: 140.0 },
        Mode::Refresh => ModeWeights { zone: 2.4, learn: 0.4, fresh: 1.0, quality: 0.6, refresh: 3.4, novelty: 0.0, upsolve: 0.2, gap_center: 0.0, gap_sigma: 130.0 },
        Mode::Upsolve => ModeWeights { zone: 1.2, learn: 0.8, fresh: 0.4, quality: 0.3, refresh: 0.0, novelty: 0.0, upsolve: 4.0, gap_center: 100.0, gap_sigma: 250.0 },
        Mode::Explore => ModeWeights { zone: 2.2, learn: 0.4, fresh: 1.2, quality: 1.4, refresh: 0.0, novelty: 3.6, upsolve: 0.0, gap_center: -50.0, gap_sigma: 140.0 },
        Mode::Plan => ModeWeights { zone: 0.0, learn: 0.0, fresh: 0.0, quality: 0.0, refresh: 0.0, novelty: 0.0, upsolve: 0.0, gap_center: 0.0, gap_sigma: 1.0 },
    }
}

/// Build the full practice report for a query.
pub fn build_report(
    problems: &[Problem],
    submissions: &[Submission],
    contests: &[Contest],
    official_rating: Option<u32>,
    query: &PracticeQuery,
) -> PracticeReport {
    let now = Utc::now();
    let history = digest_history(submissions);
    let (mut skills, computed_level) = compute_skills(&history, now);

    // Level: solve-derived estimate, floored by the official rating (contest
    // performance is real evidence even when practice history is thin).
    let level = match (computed_level, official_rating) {
        (Some(c), Some(o)) => c.max(o),
        (Some(c), None) => c,
        (None, Some(o)) => o,
        (None, None) => 1200,
    };
    for s in skills.values_mut() {
        s.weak = s.solved == 0 || s.skill + 150 < level || (s.volume < 1.0 && s.attempted_only > 0);
    }

    let goal = query
        .goal
        .unwrap_or_else(|| target::next_milestone_above(official_rating.unwrap_or(level)));

    // Solved / attempted sets (CSES progress arrives via Problem.status).
    let mut solved: HashSet<String> = problems
        .iter()
        .filter(|p| p.status == SolveStatus::Solved)
        .map(problem_key)
        .collect();
    let mut attempted: HashSet<String> = problems
        .iter()
        .filter(|p| p.status == SolveStatus::Attempted)
        .map(problem_key)
        .collect();
    for (key, h) in &history {
        if h.first_ac.is_some() {
            solved.insert(key.clone());
        } else {
            attempted.insert(key.clone());
        }
    }
    let has_history = !history.is_empty() || !solved.is_empty();

    // Goal readiness reuses the curriculum analysis.
    let readiness_pct = if has_history {
        Some(target::analyze_target(submissions, problems, official_rating, goal).readiness_pct)
    } else {
        None
    };

    let summary = |mode: Mode, skills: &HashMap<String, TagSkill>| -> PracticeSummary {
        let mut curriculum: Vec<&TagSkill> = skills
            .values()
            .filter(|s| topic_essential(&s.tag).is_some())
            .collect();
        curriculum.sort_by(|a, b| a.skill.cmp(&b.skill));
        let weak_tags = curriculum
            .iter()
            .filter(|s| s.weak)
            .take(6)
            .map(|s| (*s).clone())
            .collect();
        let strong_tags = curriculum
            .iter()
            .rev()
            .filter(|s| !s.weak && s.volume >= 1.5)
            .take(3)
            .map(|s| (*s).clone())
            .collect();
        PracticeSummary {
            level,
            official_rating,
            goal,
            goal_rank: target::rank_name(goal),
            readiness_pct,
            total_solved: solved.len(),
            mode,
            mode_note: mode.describe(),
            weak_tags,
            strong_tags,
        }
    };

    // Plan mode delegates to the curriculum planner and keeps its ordering.
    if query.mode == Mode::Plan {
        let plan = target::analyze_target(submissions, problems, official_rating, goal);
        let total = plan.steps.len().max(1) as f64;
        let recs = plan
            .steps
            .into_iter()
            .take(query.count)
            .enumerate()
            .map(|(i, step)| {
                let year = FreshnessIndex::build(contests, now).year_of(&step.problem);
                PracticeRec {
                    problem: step.problem,
                    score: (total - i as f64) / total,
                    reasons: vec![format!("{} rung {} · {}", step.stage, step.band, step.reason)],
                    year,
                }
            })
            .collect();
        return PracticeReport { summary: summary(Mode::Plan, &skills), recs };
    }

    let fresh_idx = FreshnessIndex::build(contests, now);
    let w = weights_for(query.mode);

    // Anchor skill for a problem: the weakest curriculum tag it carries — the
    // learning opportunity — or the overall level for tag-less/unknown tags.
    let anchor_for = |tags: &[String]| -> (u32, Option<String>) {
        let mut best: Option<(u32, String)> = None;
        for t in tags {
            if topic_essential(t).is_none() {
                continue;
            }
            let s = skills
                .get(t)
                .map(|s| s.skill)
                .unwrap_or_else(|| level.saturating_sub(150));
            if best.as_ref().map(|(b, _)| s < *b).unwrap_or(true) {
                best = Some((s, t.clone()));
            }
        }
        match best {
            Some((s, t)) => (s, Some(t)),
            None => (level, None),
        }
    };

    let mut scored: Vec<(PracticeRec, String)> = Vec::new();
    for p in problems {
        let key = problem_key(p);
        if solved.contains(&key) {
            continue;
        }
        let Some(rating) = p.rating else { continue };
        let was_attempted = attempted.contains(&key);
        if query.mode == Mode::Upsolve && !was_attempted {
            continue;
        }

        let tags: Vec<String> = p.tags.iter().map(|t| t.to_lowercase()).collect();
        if !query.tags.is_empty() && !tags.iter().any(|t| query.tags.contains(t)) {
            continue;
        }
        if tags.iter().any(|t| query.exclude_tags.contains(t)) {
            continue;
        }
        if let Some(min) = query.min_rating {
            if rating < min {
                continue;
            }
        }
        if let Some(max) = query.max_rating {
            if rating > max {
                continue;
            }
        }
        let year = fresh_idx.year_of(p);
        if let Some(min_year) = query.min_year {
            if year.map(|y| y < min_year).unwrap_or(true) {
                continue;
            }
        }
        // Guardrails when the user didn't pin a range: not far below level, not
        // hopelessly above it.
        if query.min_rating.is_none() {
            let floor = match query.mode {
                Mode::Refresh => level.saturating_sub(250),
                Mode::Upsolve => 0,
                Mode::Explore => level.saturating_sub(400),
                _ => level.saturating_sub(200),
            };
            if rating < floor {
                continue;
            }
        }
        if query.max_rating.is_none() && rating > level + 700 {
            continue;
        }

        let (anchor, anchor_tag) = anchor_for(&tags);
        let gap = rating as f64 - anchor as f64;
        let zone = (-((gap - w.gap_center).powi(2)) / (2.0 * w.gap_sigma.powi(2))).exp();

        // Learning value: the weakest curriculum tag this problem exercises.
        let mut learn = 0.0_f64;
        let mut learn_tag: Option<&TagSkill> = None;
        let mut novelty = 0.0_f64;
        let mut novelty_tag: Option<&str> = None;
        let mut refresh = 0.0_f64;
        let mut refresh_tag: Option<&TagSkill> = None;
        for t in &tags {
            let Some(essential) = topic_essential(t) else { continue };
            match skills.get(t) {
                Some(s) => {
                    let lag = ((level as f64 - s.skill as f64) / 300.0).clamp(0.0, 1.0);
                    let thin = (1.0 - s.volume / 4.0).clamp(0.0, 1.0);
                    let val = if s.solved == 0 { 1.0 } else { lag * 0.65 + thin * 0.35 };
                    if val > learn {
                        learn = val;
                        learn_tag = Some(s);
                    }
                    if s.solved > 0 && s.volume >= 1.0 {
                        let days = s.days_since.unwrap_or(0) as f64;
                        let rusty = (days / 120.0).clamp(0.0, 1.0);
                        if rusty > refresh {
                            refresh = rusty;
                            refresh_tag = Some(s);
                        }
                    }
                }
                None => {
                    // Never touched this topic at all.
                    if essential <= goal + 200 {
                        if 1.0 > novelty {
                            novelty = 1.0;
                            novelty_tag = Some(t.as_str());
                        }
                        if 0.9 > learn {
                            learn = 0.9;
                        }
                    }
                }
            }
        }

        let fresh = fresh_idx.freshness(year);
        let quality = {
            let sc = p.solved_count.unwrap_or(0) as f64;
            let q = ((sc + 1.0).ln() / (50_000.0_f64).ln()).clamp(0.0, 1.0);
            if sc < 200.0 { q * 0.6 } else { q }
        };
        let upsolve = if was_attempted {
            let days = history
                .get(&key)
                .map(|h| (now - h.last_touch).num_days())
                .unwrap_or(365) as f64;
            (0.5_f64).powf(days / 180.0).max(0.15)
        } else {
            0.0
        };
        // Push wants strong tags, not weak ones.
        let push_affinity = if query.mode == Mode::Push {
            tags.iter()
                .filter_map(|t| skills.get(t))
                .map(|s| (s.volume / 4.0).clamp(0.0, 1.0) * ((s.skill as f64 / level.max(1) as f64).min(1.2)))
                .fold(0.0, f64::max)
        } else {
            0.0
        };

        let mut score = w.zone * zone
            + w.learn * learn
            + w.fresh * fresh
            + w.quality * quality
            + w.refresh * refresh
            + w.novelty * novelty
            + w.upsolve * upsolve
            + push_affinity * 1.4;
        if !has_history {
            // Cold start: quality- and mid-band-led.
            score += (1.0 - ((rating as f64 - 1200.0).abs() / 400.0)).max(0.0);
        }

        // Reasons — the "why this teaches you something" strings.
        let mut reasons: Vec<String> = Vec::new();
        if query.mode == Mode::Upsolve && was_attempted {
            if let Some(h) = history.get(&key) {
                let days = (now - h.last_touch).num_days();
                reasons.push(format!(
                    "unfinished: {} attempt{} — last try {}d ago",
                    h.total_attempts,
                    if h.total_attempts == 1 { "" } else { "s" },
                    days
                ));
            }
        }
        if let Some(nt) = novelty_tag {
            reasons.push(format!("new core topic for you: {nt}"));
        } else if let Some(s) = learn_tag {
            if learn > 0.35 {
                reasons.push(format!(
                    "weak topic {}: your skill ≈{} vs level {}",
                    s.tag, s.skill, level
                ));
            }
        }
        if query.mode == Mode::Refresh {
            if let Some(s) = refresh_tag {
                reasons.push(format!(
                    "rusty: no {} activity in {}d",
                    s.tag,
                    s.days_since.unwrap_or(0)
                ));
            }
        }
        match anchor_tag {
            Some(t) if gap.abs() >= 50.0 => reasons.push(format!(
                "{} at {} ({}{}) vs your {} ≈{}",
                if gap > 0.0 { "stretch" } else { "consolidate" },
                rating,
                if gap > 0.0 { "+" } else { "" },
                gap as i64,
                t,
                anchor
            )),
            _ => reasons.push(format!("in your zone at {rating} (level ≈{level})")),
        }
        if let Some(y) = year {
            if y >= fresh_idx.now_year - 2 {
                reasons.push(format!("{y} contest"));
            }
        }
        if was_attempted && query.mode != Mode::Upsolve {
            reasons.push("you've started this one".into());
        }
        reasons.truncate(3);

        let primary = tags.first().cloned().unwrap_or_else(|| "misc".into());
        scored.push((
            PracticeRec { problem: p.clone(), score, reasons, year },
            primary,
        ));
    }

    scored.sort_by(|a, b| b.0.score.partial_cmp(&a.0.score).unwrap_or(std::cmp::Ordering::Equal));

    // Diversify: cap repeats of the same leading tag and the same rating bucket.
    let count = query.count.max(1);
    let tag_cap = (count / 4).max(2);
    let rating_cap = (count / 4).max(2);
    let mut tag_seen: HashMap<String, usize> = HashMap::new();
    let mut band_seen: HashMap<u32, usize> = HashMap::new();
    let mut picked: Vec<PracticeRec> = Vec::new();
    let mut skipped: Vec<PracticeRec> = Vec::new();
    for (rec, primary) in scored {
        if picked.len() >= count {
            break;
        }
        let band = rec.problem.rating.unwrap_or(0) / 100;
        let t = tag_seen.get(&primary).copied().unwrap_or(0);
        let b = band_seen.get(&band).copied().unwrap_or(0);
        if t >= tag_cap || b >= rating_cap {
            skipped.push(rec);
            continue;
        }
        *tag_seen.entry(primary).or_insert(0) += 1;
        *band_seen.entry(band).or_insert(0) += 1;
        picked.push(rec);
    }
    for rec in skipped {
        if picked.len() >= count {
            break;
        }
        picked.push(rec);
    }

    PracticeReport { summary: summary(query.mode, &skills), recs: picked }
}

fn problem_key(p: &Problem) -> String {
    format!("{:?}:{}", p.platform, p.id)
}

fn submission_key(s: &Submission) -> String {
    format!("{:?}:{}", s.platform, s.problem_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn prob(id: &str, rating: u32, tags: &[&str], solved_count: u64) -> Problem {
        Problem {
            platform: Platform::Codeforces,
            id: id.into(),
            name: id.into(),
            url: format!("https://codeforces.com/problemset/problem/{id}"),
            rating: Some(rating),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            category: None,
            solved_count: Some(solved_count),
            status: SolveStatus::Unsolved,
        }
    }

    fn sub(pid: &str, verdict: Verdict, rating: u32, tags: &[&str], days_ago: i64) -> Submission {
        Submission {
            platform: Platform::Codeforces,
            id: format!("s-{pid}-{verdict:?}-{days_ago}"),
            problem_id: pid.into(),
            problem_name: pid.into(),
            verdict,
            language: "cpp".into(),
            time_ms: None,
            memory_kb: None,
            submitted_at: Utc::now() - Duration::days(days_ago),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            rating: Some(rating),
        }
    }

    fn contest(id: u32, years_ago: i64) -> Contest {
        Contest {
            platform: Platform::Codeforces,
            id: id.to_string(),
            name: format!("Round {id}"),
            url: String::new(),
            start_time: Utc::now() - Duration::days(365 * years_ago),
            duration_seconds: 7200,
            phase: ContestPhase::Finished,
        }
    }

    #[test]
    fn parse_query_roundtrip() {
        let q = parse_query("mode=weakness&tags=dp,binary%20search&min=1200&max=1800&year=2023&count=15&goal=1600");
        assert_eq!(q.mode, Mode::Weakness);
        assert_eq!(q.tags, vec!["dp".to_string(), "binary search".to_string()]);
        assert_eq!(q.min_rating, Some(1200));
        assert_eq!(q.max_rating, Some(1800));
        assert_eq!(q.min_year, Some(2023));
        assert_eq!(q.count, 15);
        assert_eq!(q.goal, Some(1600));
        let plus = parse_query("tags=two+pointers");
        assert_eq!(plus.tags, vec!["two pointers".to_string()]);
    }

    #[test]
    fn weakness_mode_prefers_lagging_tag() {
        // Strong at math (1500s), weak at dp (only an old 900 with many WAs).
        let mut subs = vec![
            sub("10A", Verdict::Accepted, 1500, &["math"], 10),
            sub("11A", Verdict::Accepted, 1500, &["math"], 12),
            sub("12A", Verdict::Accepted, 1450, &["math"], 15),
            sub("13A", Verdict::WrongAnswer, 900, &["dp"], 200),
            sub("13A", Verdict::WrongAnswer, 900, &["dp"], 199),
        ];
        subs.push(sub("13A", Verdict::Accepted, 900, &["dp"], 198));
        let problems = vec![
            prob("100A", 1500, &["math"], 8000),
            prob("101B", 1500, &["dp"], 8000),
        ];
        let q = PracticeQuery { mode: Mode::Weakness, count: 2, ..Default::default() };
        let report = build_report(&problems, &subs, &[], Some(1400), &q);
        assert_eq!(report.recs.len(), 2);
        assert_eq!(report.recs[0].problem.id, "101B", "dp problem should lead: {:?}", report.recs[0].reasons);
        assert!(report.summary.weak_tags.iter().any(|t| t.tag == "dp"));
    }

    #[test]
    fn freshness_prefers_recent_contest() {
        let subs = vec![
            sub("500A", Verdict::Accepted, 1200, &["greedy"], 20),
            sub("501A", Verdict::Accepted, 1250, &["greedy"], 25),
        ];
        // Same rating/tags/popularity; one from an old contest, one recent.
        let problems = vec![
            prob("100A", 1400, &["greedy"], 5000),  // contest 100 = old
            prob("2000A", 1400, &["greedy"], 5000), // contest 2000 = recent
        ];
        let contests = vec![contest(100, 12), contest(2000, 0)];
        let q = PracticeQuery { mode: Mode::Auto, count: 2, ..Default::default() };
        let report = build_report(&problems, &subs, &contests, Some(1200), &q);
        assert_eq!(report.recs[0].problem.id, "2000A", "recent contest should lead");
        assert_eq!(report.recs[0].year, Some(Utc::now().year()));
    }

    #[test]
    fn min_year_filter_drops_old_problems() {
        let problems = vec![
            prob("100A", 1300, &["math"], 5000),
            prob("2000A", 1300, &["math"], 5000),
        ];
        let contests = vec![contest(100, 12), contest(2000, 0)];
        let q = PracticeQuery { min_year: Some(Utc::now().year() - 1), count: 10, ..Default::default() };
        let report = build_report(&problems, &[], &contests, Some(1200), &q);
        assert_eq!(report.recs.len(), 1);
        assert_eq!(report.recs[0].problem.id, "2000A");
    }

    #[test]
    fn upsolve_mode_returns_only_attempted() {
        let subs = vec![
            sub("42A", Verdict::WrongAnswer, 1300, &["dp"], 30),
            sub("50B", Verdict::Accepted, 1200, &["math"], 10),
        ];
        let problems = vec![
            prob("42A", 1300, &["dp"], 3000),
            prob("60C", 1300, &["dp"], 3000),
        ];
        let q = PracticeQuery { mode: Mode::Upsolve, count: 5, ..Default::default() };
        let report = build_report(&problems, &subs, &[], Some(1200), &q);
        assert_eq!(report.recs.len(), 1);
        assert_eq!(report.recs[0].problem.id, "42A");
        assert!(report.recs[0].reasons[0].contains("unfinished"));
    }

    #[test]
    fn explore_mode_surfaces_untouched_core_topics() {
        let subs = vec![
            sub("1A", Verdict::Accepted, 1400, &["math"], 5),
            sub("2A", Verdict::Accepted, 1400, &["math"], 6),
            sub("3A", Verdict::Accepted, 1450, &["greedy"], 7),
        ];
        let problems = vec![
            prob("10A", 1300, &["math"], 9000),
            prob("11B", 1300, &["graphs"], 9000), // never touched
        ];
        let q = PracticeQuery { mode: Mode::Explore, count: 2, ..Default::default() };
        let report = build_report(&problems, &subs, &[], Some(1400), &q);
        assert_eq!(report.recs[0].problem.id, "11B");
        assert!(report.recs[0].reasons.iter().any(|r| r.contains("new core topic")));
    }

    #[test]
    fn tag_filter_restricts_results() {
        let problems = vec![
            prob("1A", 1300, &["dp"], 5000),
            prob("2B", 1300, &["geometry"], 5000),
        ];
        let q = PracticeQuery { tags: vec!["dp".into()], count: 10, ..Default::default() };
        let report = build_report(&problems, &[], &[], Some(1200), &q);
        assert!(report.recs.iter().all(|r| r.problem.tags.iter().any(|t| t == "dp")));
        assert_eq!(report.recs.len(), 1);
    }

    #[test]
    fn solved_problems_never_recommended() {
        let subs = vec![sub("7A", Verdict::Accepted, 1300, &["dp"], 3)];
        let problems = vec![prob("7A", 1300, &["dp"], 5000)];
        let report = build_report(&problems, &subs, &[], Some(1200), &PracticeQuery::default());
        assert!(report.recs.is_empty());
    }

    #[test]
    fn bled_solves_count_less_than_clean_ones() {
        // Ten clean 1600 ACs vs ten 1600 ACs each after 4 WAs: the clean history
        // must produce an equal or higher dp skill than the bled history.
        let clean: Vec<Submission> = (0..10).map(|i| sub(&format!("c{i}"), Verdict::Accepted, 1600, &["dp"], 10 + i)).collect();
        let mut bled: Vec<Submission> = Vec::new();
        for i in 0..10 {
            for _ in 0..4 {
                bled.push(sub(&format!("b{i}"), Verdict::WrongAnswer, 1600, &["dp"], 12 + i));
            }
            bled.push(sub(&format!("b{i}"), Verdict::Accepted, 1600, &["dp"], 10 + i));
        }
        // add a lower anchor so percentile has range
        let mut clean_all = clean;
        clean_all.push(sub("cl", Verdict::Accepted, 1000, &["dp"], 9));
        let mut bled_all = bled;
        bled_all.push(sub("bl", Verdict::Accepted, 1000, &["dp"], 9));

        let (skills_clean, _) = compute_skills(&digest_history(&clean_all), Utc::now());
        let (skills_bled, _) = compute_skills(&digest_history(&bled_all), Utc::now());
        let sc = skills_clean.get("dp").unwrap();
        let sb = skills_bled.get("dp").unwrap();
        assert!(sc.volume > sb.volume, "clean evidence should weigh more: {} vs {}", sc.volume, sb.volume);
    }

    #[test]
    fn plan_mode_returns_curriculum_steps() {
        const TAGS: [&str; 3] = ["dp", "math", "greedy"];
        let problems: Vec<Problem> = (0..40u32)
            .map(|i| {
                let tag = TAGS[(i % 3) as usize];
                prob(&format!("{}A", 1000 + i), 1000 + (i % 10) * 100, &[tag], 5000)
            })
            .collect();
        let subs = vec![sub("999Z", Verdict::Accepted, 1100, &["math"], 5)];
        let q = PracticeQuery { mode: Mode::Plan, goal: Some(1400), count: 10, ..Default::default() };
        let report = build_report(&problems, &subs, &[], Some(1100), &q);
        assert!(!report.recs.is_empty());
        assert_eq!(report.summary.goal, 1400);
    }
}
