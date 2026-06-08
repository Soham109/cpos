//! Targeted, goal-driven recommendations for Codeforces.
//!
//! Where [`crate::engine::recommender`] answers *"what should I solve next?"*,
//! this module answers *"I want to reach rating N — where am I, what topics am I
//! missing, and in what order should I practice to get there?"*.
//!
//! It produces a [`TargetPlan`] with three pieces:
//! - a current-status read (effective level, gap to the goal, overall readiness),
//! - per-topic [`TopicReadiness`] (which prerequisite topics for the goal are a
//!   `Gap`/`Untouched` vs already `Ready`), and
//! - a step-by-step [`TargetStep`] curriculum that ramps from the user's level up
//!   to the target rating while front-loading their weakest relevant topics.

use std::collections::{HashMap, HashSet};

use crate::data::models::*;

/// Codeforces rank milestones as `(entry rating, rank name)`, ascending.
/// Used both for the goal selector and to name a rating.
pub const CF_MILESTONES: [(u32, &str); 9] = [
    (1200, "Pupil"),
    (1400, "Specialist"),
    (1600, "Expert"),
    (1900, "Candidate Master"),
    (2100, "Master"),
    (2300, "Int'l Master"),
    (2400, "Grandmaster"),
    (2600, "Int'l GM"),
    (3000, "Legendary GM"),
];

pub const TARGET_MIN: u32 = 900;
pub const TARGET_MAX: u32 = 3500;

/// Upper bound on how many problems the step plan contains.
const MAX_STEPS: usize = 32;

/// Codeforces topic → the rating at which the topic typically becomes essential.
///
/// This is the curriculum backbone: for a given target we keep the topics that
/// matter at or below that rating, rank how relevant each is to the goal band,
/// and drive both the readiness analysis and the step ordering from it.
const CURRICULUM: [(&str, u32); 33] = [
    ("implementation", 900),
    ("brute force", 1000),
    ("math", 1000),
    ("greedy", 1100),
    ("sortings", 1100),
    ("constructive algorithms", 1300),
    ("binary search", 1300),
    ("two pointers", 1400),
    ("strings", 1400),
    ("number theory", 1500),
    ("dp", 1500),
    ("dfs and similar", 1500),
    ("graphs", 1600),
    ("dsu", 1600),
    ("bitmasks", 1600),
    ("combinatorics", 1700),
    ("trees", 1700),
    ("data structures", 1700),
    ("shortest paths", 1800),
    ("hashing", 1800),
    ("expression parsing", 1900),
    ("divide and conquer", 1900),
    ("probabilities", 1900),
    ("geometry", 1900),
    ("matrices", 2000),
    ("ternary search", 2000),
    ("games", 2000),
    ("meet-in-the-middle", 2100),
    ("2-sat", 2300),
    ("flows", 2300),
    ("string suffix structures", 2300),
    ("fft", 2400),
    ("graph matchings", 2400),
];

/// How prepared the user is in a single topic for the chosen target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Readiness {
    /// Solid coverage at or above the band this topic matters at.
    Ready,
    /// Some solves in the band, but not yet consistent.
    Developing,
    /// Solved only easy versions — needs work at the target band.
    Gap,
    /// Never solved a problem in this topic.
    Untouched,
}

impl Readiness {
    pub fn label(&self) -> &'static str {
        match self {
            Readiness::Ready => "Ready",
            Readiness::Developing => "Developing",
            Readiness::Gap => "Gap",
            Readiness::Untouched => "Untouched",
        }
    }
}

/// Per-topic standing relative to the target.
#[derive(Debug, Clone)]
pub struct TopicReadiness {
    pub topic: String,
    /// Rating band this topic becomes essential at, for context.
    pub needed_rating: u32,
    /// Total problems solved in this topic (any rating).
    pub solved_total: u32,
    /// Problems solved at or above the level this topic matters at for the goal.
    pub solved_at_level: u32,
    /// Highest rating solved in this topic, if any.
    pub max_solved: Option<u32>,
    pub status: Readiness,
    /// 0..1 — how much attention this topic deserves for the goal (higher = more).
    pub priority: f64,
    /// 0..1 — how relevant this topic is to the goal band (used for the overall %).
    pub relevance: f64,
}

/// A single ordered move in the plan: solve this problem next.
#[derive(Debug, Clone)]
pub struct TargetStep {
    pub problem: Problem,
    pub reason: String,
    pub topic: String,
    /// Rating rung this step belongs to.
    pub band: u32,
    /// Coarse phase label: Base / Build / Push / Target.
    pub stage: &'static str,
}

/// The full goal-driven plan rendered by the Target tab.
#[derive(Debug, Clone)]
pub struct TargetPlan {
    pub target_rating: u32,
    pub target_rank: &'static str,
    pub current_level: u32,
    pub current_rank: &'static str,
    /// `target - current_level` (can be negative if already past the goal).
    pub gap: i64,
    /// 0..100 — weighted share of relevant topics that are ready.
    pub readiness_pct: u32,
    /// Topics that need attention for the goal, most important first.
    pub focus_topics: Vec<TopicReadiness>,
    /// Step-by-step problem curriculum, easiest first.
    pub steps: Vec<TargetStep>,
    /// Unsolved problems already solved inside the goal band.
    pub solved_in_band: u32,
    /// Lower edge of the goal band (`target - 200`).
    pub band_floor: u32,
}

/// The rating a topic becomes essential at, if it's a tracked core topic.
/// Returns `None` for tags outside the curriculum (obscure/secondary tags).
pub fn topic_essential(tag: &str) -> Option<u32> {
    let lower = tag.to_lowercase();
    CURRICULUM
        .iter()
        .find(|(name, _)| *name == lower)
        .map(|(_, rating)| *rating)
}

/// Clamp a free-entered goal to the supported range.
pub fn clamp_target(rating: u32) -> u32 {
    rating.clamp(TARGET_MIN, TARGET_MAX)
}

/// The Codeforces rank name for a rating (e.g. 1650 → "Expert").
pub fn rank_name(rating: u32) -> &'static str {
    let mut name = "Newbie";
    for (threshold, label) in CF_MILESTONES {
        if rating >= threshold {
            name = label;
        }
    }
    name
}

/// The next milestone strictly above `rating` — a sensible default goal.
pub fn next_milestone_above(rating: u32) -> u32 {
    for (threshold, _) in CF_MILESTONES {
        if threshold > rating {
            return threshold;
        }
    }
    TARGET_MAX
}

/// Step the goal to the next/previous milestone. For a custom value that doesn't
/// sit on a milestone, this jumps to the nearest milestone in `dir`.
pub fn cycle_milestone(current: u32, dir: i32) -> u32 {
    if dir >= 0 {
        for (threshold, _) in CF_MILESTONES {
            if threshold > current {
                return threshold;
            }
        }
        clamp_target(current.saturating_add(100))
    } else {
        for (threshold, _) in CF_MILESTONES.iter().rev() {
            if *threshold < current {
                return *threshold;
            }
        }
        clamp_target(current.saturating_sub(100))
    }
}

/// Analyze the user's standing against `target_rating` and build the plan.
pub fn analyze_target(
    submissions: &[Submission],
    all_problems: &[Problem],
    user_rating: Option<u32>,
    target_rating: u32,
) -> TargetPlan {
    let target = clamp_target(target_rating);

    // Merge solved problems from explicit status (CSES progress / CF) and accepted
    // submissions (the richer source of CF tags + ratings), keyed by problem.
    let mut solved: HashMap<String, (Option<u32>, Vec<String>)> = HashMap::new();
    for p in all_problems {
        if p.status == SolveStatus::Solved {
            solved
                .entry(problem_key(p))
                .or_insert_with(|| (p.rating, lower_tags(&p.tags)));
        }
    }
    for s in submissions {
        if s.verdict == Verdict::Accepted {
            let entry = solved
                .entry(submission_key(s))
                .or_insert_with(|| (s.rating, Vec::new()));
            if entry.0.is_none() {
                entry.0 = s.rating;
            }
            if entry.1.is_empty() && !s.tags.is_empty() {
                entry.1 = lower_tags(&s.tags);
            }
        }
    }

    let solved_ids: HashSet<String> = solved.keys().cloned().collect();
    let mut solved_ratings: Vec<u32> = Vec::new();
    let mut topic_ratings: HashMap<String, Vec<u32>> = HashMap::new();
    for (rating, tags) in solved.values() {
        if let Some(r) = rating {
            solved_ratings.push(*r);
            for tag in tags {
                topic_ratings.entry(tag.clone()).or_default().push(*r);
            }
        }
    }

    // Effective level: floor at the user's known rating, lift toward the 70th
    // percentile of what they've actually solved.
    let base = user_rating.unwrap_or(1200).max(800);
    let solved_level = percentile(&solved_ratings, 70).unwrap_or(base);
    let current_level = base.max(solved_level);

    let band_floor = target.saturating_sub(200);
    let solved_in_band = solved_ratings
        .iter()
        .filter(|r| **r >= band_floor && **r <= target + 100)
        .count() as u32;

    // Per-topic readiness across every in-scope curriculum topic.
    let mut all_readiness: Vec<TopicReadiness> = Vec::new();
    let mut weighted_score = 0.0_f64;
    let mut weight_total = 0.0_f64;
    for (topic, essential) in CURRICULUM {
        // In scope when the topic matters at or below the target band.
        if essential > target + 100 {
            continue;
        }
        let ratings = topic_ratings.get(topic).cloned().unwrap_or_default();
        let solved_total = ratings.len() as u32;
        let max_solved = ratings.iter().copied().max();
        let level_floor = essential.min(target).saturating_sub(100);
        let solved_at_level = ratings.iter().filter(|r| **r >= level_floor).count() as u32;

        let status = if solved_total == 0 {
            Readiness::Untouched
        } else if solved_at_level == 0 || max_solved.unwrap_or(0) + 100 < level_floor {
            Readiness::Gap
        } else if solved_at_level <= 2 {
            Readiness::Developing
        } else {
            Readiness::Ready
        };

        // Topics whose essential band sits near the target matter most.
        let relevance =
            (1.0 - (target as f64 - essential as f64).abs() / 900.0).clamp(0.1, 1.0);
        let status_mult = match status {
            Readiness::Untouched => 1.0,
            Readiness::Gap => 0.9,
            Readiness::Developing => 0.55,
            Readiness::Ready => 0.15,
        };
        let priority = relevance * status_mult;

        let readiness_score = match status {
            Readiness::Ready => 1.0,
            Readiness::Developing => 0.6,
            Readiness::Gap => 0.25,
            Readiness::Untouched => 0.0,
        };
        weighted_score += readiness_score * relevance;
        weight_total += relevance;

        all_readiness.push(TopicReadiness {
            topic: topic.to_string(),
            needed_rating: essential,
            solved_total,
            solved_at_level,
            max_solved,
            status,
            priority,
            relevance,
        });
    }

    let readiness_pct = if weight_total > 0.0 {
        ((weighted_score / weight_total) * 100.0).round() as u32
    } else {
        0
    };

    // Focus list: things that aren't already Ready, most important first.
    let mut focus_topics: Vec<TopicReadiness> = all_readiness
        .iter()
        .filter(|t| t.status != Readiness::Ready)
        .cloned()
        .collect();
    focus_topics.sort_by(|a, b| {
        b.priority
            .partial_cmp(&a.priority)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    focus_topics.truncate(8);

    // Topic → priority map drives step scoring (covers all in-scope topics so we
    // can still down-rank already-Ready ones rather than dropping them).
    let topic_priority: HashMap<String, f64> = all_readiness
        .iter()
        .map(|t| (t.topic.clone(), t.priority))
        .collect();

    let steps = build_steps(
        all_problems,
        &solved_ids,
        &topic_priority,
        current_level,
        target,
    );

    TargetPlan {
        target_rating: target,
        target_rank: rank_name(target),
        current_level,
        current_rank: rank_name(current_level),
        gap: target as i64 - current_level as i64,
        readiness_pct,
        focus_topics,
        steps,
        solved_in_band,
        band_floor,
    }
}

/// Build the ascending rung-by-rung problem plan.
fn build_steps(
    all_problems: &[Problem],
    solved_ids: &HashSet<String>,
    topic_priority: &HashMap<String, f64>,
    current_level: u32,
    target: u32,
) -> Vec<TargetStep> {
    // Ramp from a little below where you are (but no more than 400 under the goal)
    // up to the goal itself, in 100-point rungs.
    let start = round_down_100(current_level)
        .max(target.saturating_sub(400))
        .min(target.saturating_sub(100))
        .max(TARGET_MIN);

    let mut rungs: Vec<u32> = Vec::new();
    let mut r = round_down_100(start).max(100);
    let top = round_down_100(target).max(r);
    while r <= top {
        rungs.push(r);
        r += 100;
    }
    if rungs.is_empty() {
        rungs.push(round_down_100(target).max(100));
    }
    // Keep at most the five rungs nearest the target.
    if rungs.len() > 5 {
        rungs = rungs.split_off(rungs.len() - 5);
    }

    let n_rungs = rungs.len();
    let mut chosen: HashSet<String> = HashSet::new();
    let mut steps: Vec<TargetStep> = Vec::new();

    for (idx, &band) in rungs.iter().enumerate() {
        if steps.len() >= MAX_STEPS {
            break;
        }
        let stage = stage_label(idx, n_rungs);

        // Score every unsolved Codeforces problem at this rung.
        let mut cands: Vec<(f64, &Problem, String, bool)> = Vec::new();
        for p in all_problems {
            if p.platform != Platform::Codeforces {
                continue;
            }
            let Some(pr) = p.rating else {
                continue;
            };
            if pr != band {
                continue;
            }
            let key = problem_key(p);
            if solved_ids.contains(&key) || chosen.contains(&key) {
                continue;
            }

            let mut best_pri = 0.0_f64;
            let mut best_topic = String::new();
            for tag in &p.tags {
                let tl = tag.to_lowercase();
                if let Some(&pri) = topic_priority.get(&tl) {
                    if pri > best_pri {
                        best_pri = pri;
                        best_topic = tl;
                    }
                }
            }
            let is_focus = best_pri > 0.3;
            if best_topic.is_empty() {
                best_topic = p
                    .tags
                    .first()
                    .map(|t| t.to_lowercase())
                    .unwrap_or_else(|| "misc".to_string());
            }

            let pop = (p.solved_count.unwrap_or(0) as f64 + 1.0).ln();
            let score = best_pri * 10.0 + pop * 0.5;
            cands.push((score, p, best_topic, is_focus));
        }

        cands.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let budget = rung_budget(idx, n_rungs);
        let mut taken = 0usize;
        let mut per_topic: HashMap<String, usize> = HashMap::new();
        for (_score, problem, topic, is_focus) in cands {
            if taken >= budget || steps.len() >= MAX_STEPS {
                break;
            }
            // Keep each rung varied — no more than two of the same topic.
            if per_topic.get(&topic).copied().unwrap_or(0) >= 2 {
                continue;
            }
            *per_topic.entry(topic.clone()).or_insert(0) += 1;
            chosen.insert(problem_key(problem));
            let reason = build_step_reason(stage, &topic, band, is_focus);
            steps.push(TargetStep {
                problem: problem.clone(),
                reason,
                topic,
                band,
                stage,
            });
            taken += 1;
        }
    }

    steps
}

/// Per-rung problem budget — rungs nearer the goal get a couple extra.
fn rung_budget(idx: usize, n: usize) -> usize {
    let base = (MAX_STEPS / n.max(1)).max(3);
    if idx + 1 == n {
        base + 2
    } else if idx + 2 == n {
        base + 1
    } else {
        base
    }
}

fn stage_label(idx: usize, n: usize) -> &'static str {
    if n <= 1 {
        return "Target";
    }
    if idx + 1 == n {
        return "Target";
    }
    let frac = idx as f64 / (n as f64 - 1.0);
    if frac < 0.34 {
        "Base"
    } else if frac < 0.67 {
        "Build"
    } else {
        "Push"
    }
}

fn build_step_reason(stage: &str, topic: &str, band: u32, is_focus: bool) -> String {
    if is_focus {
        format!("{stage} · {topic} @ {band} (focus)")
    } else {
        format!("{stage} · {topic} @ {band}")
    }
}

fn lower_tags(tags: &[String]) -> Vec<String> {
    tags.iter().map(|t| t.to_lowercase()).collect()
}

fn problem_key(problem: &Problem) -> String {
    format!("{:?}:{}", problem.platform, problem.id)
}

fn submission_key(submission: &Submission) -> String {
    format!("{:?}:{}", submission.platform, submission.problem_id)
}

fn round_down_100(rating: u32) -> u32 {
    (rating / 100) * 100
}

fn percentile(ratings: &[u32], percentile: usize) -> Option<u32> {
    if ratings.is_empty() {
        return None;
    }
    let mut sorted = ratings.to_vec();
    sorted.sort_unstable();
    let idx = ((sorted.len() - 1) * percentile + 50) / 100;
    sorted.get(idx).copied()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn prob(id: &str, rating: u32, tags: &[&str]) -> Problem {
        Problem {
            platform: Platform::Codeforces,
            id: id.to_string(),
            name: format!("Problem {id}"),
            url: format!("https://codeforces.com/problemset/problem/{id}"),
            rating: Some(rating),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            category: None,
            solved_count: Some(5_000),
            status: SolveStatus::Unsolved,
        }
    }

    fn ac(problem_id: &str, rating: u32, tags: &[&str]) -> Submission {
        Submission {
            platform: Platform::Codeforces,
            id: format!("sub-{problem_id}"),
            problem_id: problem_id.to_string(),
            problem_name: problem_id.to_string(),
            verdict: Verdict::Accepted,
            language: "cpp".into(),
            time_ms: None,
            memory_kb: None,
            submitted_at: Utc::now(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            rating: Some(rating),
        }
    }

    #[test]
    fn rank_names_match_milestones() {
        assert_eq!(rank_name(1150), "Newbie");
        assert_eq!(rank_name(1200), "Pupil");
        assert_eq!(rank_name(1650), "Expert");
        assert_eq!(rank_name(2100), "Master");
    }

    #[test]
    fn next_milestone_picks_strictly_above() {
        assert_eq!(next_milestone_above(1150), 1200);
        assert_eq!(next_milestone_above(1400), 1600);
        assert_eq!(next_milestone_above(1600), 1900);
    }

    #[test]
    fn cycle_moves_between_milestones() {
        assert_eq!(cycle_milestone(1400, 1), 1600);
        assert_eq!(cycle_milestone(1500, 1), 1600); // custom value jumps up
        assert_eq!(cycle_milestone(1600, -1), 1400);
        assert_eq!(cycle_milestone(1500, -1), 1400);
    }

    #[test]
    fn untouched_prerequisite_topic_is_flagged_and_focused() {
        // Solved plenty of dp, never touched graphs; aiming for Expert (1600).
        let mut subs = Vec::new();
        for i in 0..4 {
            subs.push(ac(&format!("dp{i}"), 1500, &["dp"]));
        }
        let problems = vec![
            prob("g1", 1500, &["graphs"]),
            prob("g2", 1600, &["graphs"]),
            prob("d1", 1600, &["dp"]),
        ];
        let plan = analyze_target(&subs, &problems, Some(1450), 1600);

        let graphs = plan
            .focus_topics
            .iter()
            .find(|t| t.topic == "graphs")
            .expect("graphs should be a focus topic");
        assert_eq!(graphs.status, Readiness::Untouched);
        // dp is well-covered, so it should not dominate the focus list.
        assert!(plan
            .focus_topics
            .iter()
            .find(|t| t.topic == "dp")
            .map(|t| t.status == Readiness::Ready)
            .unwrap_or(true));
    }

    #[test]
    fn steps_ramp_upward_toward_the_target() {
        // A broad pool so every rung can be filled.
        let mut problems = Vec::new();
        for rating in (1100u32..=1600).step_by(100) {
            for (i, tag) in ["dp", "graphs", "greedy", "math"].iter().enumerate() {
                problems.push(prob(&format!("p{rating}_{i}"), rating, &[tag]));
            }
        }
        let plan = analyze_target(&[], &problems, Some(1200), 1600);

        assert!(!plan.steps.is_empty(), "expected a non-empty plan");
        // Bands are non-decreasing across the ordered plan (a ramp, not a jumble).
        let mut prev = 0u32;
        for step in &plan.steps {
            assert!(
                step.band >= prev,
                "bands should not decrease: {} after {}",
                step.band,
                prev
            );
            prev = step.band;
        }
        // The plan should reach the target band by the end.
        assert_eq!(plan.steps.last().unwrap().band, 1600);
        assert!(plan.steps.iter().all(|s| s.problem.rating.unwrap() <= 1600));
    }

    #[test]
    fn already_solved_problems_are_never_recommended() {
        let problems = vec![prob("solved1", 1400, &["dp"]), prob("fresh1", 1400, &["dp"])];
        let subs = vec![ac("solved1", 1400, &["dp"])];
        let plan = analyze_target(&subs, &problems, Some(1300), 1500);
        assert!(plan.steps.iter().all(|s| s.problem.id != "solved1"));
    }

    #[test]
    fn readiness_pct_is_within_bounds() {
        let plan = analyze_target(&[], &[], Some(1200), 1600);
        assert!(plan.readiness_pct <= 100);
        // No solves at all → not ready.
        assert!(plan.readiness_pct < 50);
    }
}
