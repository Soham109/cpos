use std::collections::{HashMap, HashSet};

use chrono::{Duration, Utc};

use crate::data::models::*;
use crate::engine::target::topic_essential;
use crate::engine::weakness::compute_tag_stats;

pub const DEFAULT_COUNT: usize = 50;

pub struct Recommendation {
    pub problem: Problem,
    pub reason: String,
}

/// Recommend unsolved problems to practice next.
///
/// Two regimes:
/// - **Cold start** (no accepted submissions): surface popular, well-known problems
///   around a sensible default level, spread across topics and ratings.
/// - **Warm** (history present): infer a practical level from solved/attempted
///   history, target a real stretch above it, boost weak topics and unfinished
///   attempts, and keep the list diverse.
pub fn recommend_problems(
    submissions: &[Submission],
    all_problems: &[Problem],
    user_rating: Option<u32>,
    count: usize,
) -> Vec<Recommendation> {
    let count = count.max(1);

    let mut solved_ids: HashSet<String> = all_problems
        .iter()
        .filter(|p| p.status == SolveStatus::Solved)
        .map(problem_key)
        .collect();
    solved_ids.extend(
        submissions
            .iter()
            .filter(|s| s.verdict == Verdict::Accepted)
            .map(submission_key),
    );

    let mut attempted_ids: HashSet<String> = all_problems
        .iter()
        .filter(|p| p.status == SolveStatus::Attempted)
        .map(problem_key)
        .collect();
    attempted_ids.extend(submissions.iter().map(submission_key));

    let profile = PracticeProfile::from_history(submissions, user_rating);
    let has_history = profile.has_history || !solved_ids.is_empty();

    let tag_stats = compute_tag_stats(submissions, all_problems);
    // Tag → weakness weight in [0, 1]: 1.0 means 0% solve rate, 0.0 means mastered.
    let weak_weights: HashMap<String, f64> = tag_stats
        .iter()
        .filter(|t| t.solved + t.attempted >= 2)
        .take(14)
        .map(|t| {
            let total = (t.solved + t.attempted) as f64;
            let rate = t.solved as f64 / total;
            (t.tag.to_lowercase(), (1.0 - rate).clamp(0.0, 1.0))
        })
        .collect();

    // Topics the user has solved at least once (any rating). The old scoring
    // treated an *untouched* topic as if it were mastered (0 weak weight), which
    // hides prerequisite blind spots. With history we instead flag core topics
    // the user has never solved as coverage gaps, and nudge topics they've only
    // practiced well below their target band. Gated on history so cold-start
    // behavior (popular mid-tier classics) is unchanged.
    let solved_tags: HashSet<String> = submissions
        .iter()
        .filter(|s| s.verdict == Verdict::Accepted)
        .flat_map(|s| s.tags.iter().map(|t| t.to_lowercase()))
        .chain(
            all_problems
                .iter()
                .filter(|p| p.status == SolveStatus::Solved)
                .flat_map(|p| p.tags.iter().map(|t| t.to_lowercase())),
        )
        .collect();

    // Tag → average rating at which it's been solved, to spot below-band practice.
    let tag_avg_rating: HashMap<String, f64> = tag_stats
        .iter()
        .filter_map(|t| t.avg_rating.map(|r| (t.tag.to_lowercase(), r)))
        .collect();

    let mut scored: Vec<Scored> = Vec::new();
    for problem in all_problems {
        let key = problem_key(problem);
        if solved_ids.contains(&key) {
            continue;
        }
        let Some(rating) = problem.rating else {
            continue;
        };

        let attempted = attempted_ids.contains(&key);
        let Some(tier) = profile.candidate_tier(rating, attempted) else {
            continue;
        };

        let tags_lower: Vec<String> = problem.tags.iter().map(|t| t.to_lowercase()).collect();
        let weak_hits: Vec<(String, f64)> = tags_lower
            .iter()
            .filter_map(|t| weak_weights.get(t).map(|&w| (t.clone(), w)))
            .collect();

        let mut score = 0.0_f64;

        // Rating fit is the backbone: prefer a stretch above inferred level,
        // with fallback candidates only used when the strong band is thin.
        score += profile.rating_score(rating, attempted);

        // Popularity is useful for quality, but log-scaled and subdued so it
        // doesn't drag the list down toward very easy classics.
        let pop = (problem.solved_count.unwrap_or(0) as f64 + 1.0).ln();
        score += pop * 0.65;

        // Weighted weak-topic emphasis: a 0%-rate tag counts more than a 50%-rate tag.
        let weak_score: f64 = weak_hits.iter().map(|(_, w)| w * 5.5).sum();
        score += weak_score;

        // Extra nudge when a problem hits multiple weak areas at once.
        if weak_hits.len() >= 2 {
            score += 2.0;
        }

        // Coverage + band-gap emphasis (history only — cold start stays popularity-led).
        let mut coverage_gap = false;
        if has_history {
            // Core prerequisite topics for this level the user has never solved.
            let coverage_hits = tags_lower
                .iter()
                .filter(|t| {
                    let t = t.as_str();
                    !solved_tags.contains(t)
                        && topic_essential(t)
                            .map(|e| e <= profile.target + 100)
                            .unwrap_or(false)
                })
                .count();
            if coverage_hits > 0 {
                coverage_gap = true;
                score += 2.6 + ((coverage_hits.min(3) as f64) - 1.0).max(0.0) * 1.1;
            }
            // Weak topics you've only ever cleared well below your target band.
            for (tag, w) in &weak_hits {
                if let Some(avg) = tag_avg_rating.get(tag.as_str()) {
                    if *avg + 150.0 < profile.target as f64 {
                        score += *w * 1.5;
                    }
                }
            }
        }

        // Unfinished problems you've already started.
        if attempted {
            score += 3.5;
        }

        // Cold start: prefer mid-tier popular problems over extreme highs/lows.
        if !has_history {
            let mid = 1200.0;
            score += (3.5 - (rating as f64 - mid).abs() / 350.0).max(0.0);
        }

        let reason = build_reason(&weak_hits, coverage_gap, attempted, has_history, rating, &profile);

        let primary_tag = tags_lower
            .first()
            .cloned()
            .unwrap_or_else(|| "misc".to_string());

        scored.push(Scored {
            problem: problem.clone(),
            reason,
            score,
            primary_tag,
            rating,
            tier,
        });
    }

    scored.sort_by(|a, b| {
        a.tier.cmp(&b.tier).then_with(|| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });

    diversify(scored, count, has_history)
}

#[derive(Debug, Clone)]
struct PracticeProfile {
    has_history: bool,
    level: u32,
    preferred_min: u32,
    target: u32,
    upper: u32,
    fallback_min: u32,
    fallback_upper: u32,
}

impl PracticeProfile {
    fn from_history(submissions: &[Submission], user_rating: Option<u32>) -> Self {
        let base = user_rating.unwrap_or(1200).max(800);
        let mut accepted_by_problem: HashMap<String, (u32, chrono::DateTime<Utc>)> = HashMap::new();
        let mut attempted_by_problem: HashMap<String, (u32, chrono::DateTime<Utc>)> =
            HashMap::new();

        for sub in submissions {
            if let Some(rating) = sub.rating {
                let key = submission_key(sub);
                attempted_by_problem
                    .entry(key.clone())
                    .and_modify(|entry| {
                        if sub.submitted_at > entry.1 {
                            *entry = (rating, sub.submitted_at);
                        }
                    })
                    .or_insert((rating, sub.submitted_at));

                if sub.verdict == Verdict::Accepted {
                    accepted_by_problem
                        .entry(key)
                        .and_modify(|entry| {
                            if sub.submitted_at > entry.1 {
                                *entry = (rating, sub.submitted_at);
                            }
                        })
                        .or_insert((rating, sub.submitted_at));
                }
            }
        }

        let accepted: Vec<(u32, chrono::DateTime<Utc>)> =
            accepted_by_problem.values().copied().collect();
        let solved_ratings: Vec<u32> = accepted.iter().map(|(r, _)| *r).collect();
        let recent_cutoff = Utc::now() - Duration::days(90);
        let recent_solved: Vec<u32> = accepted
            .iter()
            .filter(|(_, at)| *at >= recent_cutoff)
            .map(|(r, _)| *r)
            .collect();
        let attempted_ratings: Vec<u32> = attempted_by_problem.values().map(|(r, _)| *r).collect();

        let solved_level = percentile_rating(&solved_ratings, 70).unwrap_or(base);
        let recent_level = percentile_rating(&recent_solved, 70).unwrap_or(solved_level);
        let ambition = percentile_rating(&attempted_ratings, 60).unwrap_or(solved_level);
        let has_history = !solved_ratings.is_empty();
        let knows_level = has_history || user_rating.is_some();

        let level = base.max(solved_level).max(recent_level);
        let preferred_min =
            round_up_rating(level.saturating_add(if knows_level { 200 } else { 0 }));
        let target = round_up_rating(
            level
                .saturating_add(if knows_level { 300 } else { 100 })
                .max(ambition.saturating_add(100)),
        )
        .min(round_up_rating(level.saturating_add(650)))
        .max(preferred_min);
        let upper = round_up_rating(target.saturating_add(450));
        let fallback_min = if has_history {
            round_up_rating(level)
        } else if user_rating.is_some() {
            round_up_rating(level.saturating_add(50))
        } else {
            round_up_rating(level.saturating_sub(200))
        };
        let fallback_upper = round_up_rating(upper.saturating_add(300));

        Self {
            has_history,
            level,
            preferred_min,
            target,
            upper,
            fallback_min,
            fallback_upper,
        }
    }

    fn candidate_tier(&self, rating: u32, attempted: bool) -> Option<u8> {
        if rating >= self.preferred_min && rating <= self.upper {
            return Some(0);
        }
        if attempted && rating >= self.fallback_min && rating <= self.fallback_upper {
            return Some(1);
        }
        if rating >= self.fallback_min && rating <= self.fallback_upper {
            return Some(1);
        }
        None
    }

    fn rating_score(&self, rating: u32, attempted: bool) -> f64 {
        let dist = (rating as f64 - self.target as f64).abs();
        let mut score = (11.0 - dist / 70.0).max(-4.0);

        if rating >= self.preferred_min {
            score += 4.0;
        } else {
            score -= (self.preferred_min - rating) as f64 / 35.0;
        }

        if rating < self.level {
            score -= 8.0;
        }
        if rating > self.upper {
            score -= (rating - self.upper) as f64 / 45.0;
        }
        if attempted && rating >= self.fallback_min {
            score += 1.0;
        }

        score
    }
}

fn build_reason(
    weak_hits: &[(String, f64)],
    coverage_gap: bool,
    attempted: bool,
    has_history: bool,
    rating: u32,
    profile: &PracticeProfile,
) -> String {
    // Only call out topics with a real shortfall — mastered tags carry weight 0.
    let mut meaningful: Vec<(String, f64)> = weak_hits
        .iter()
        .filter(|(_, w)| *w > 0.05)
        .cloned()
        .collect();
    if !meaningful.is_empty() {
        meaningful.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let tags = meaningful
            .iter()
            .take(2)
            .map(|(t, _)| t.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        format!("Weak topic: {tags}")
    } else if coverage_gap {
        "New topic to cover".to_string()
    } else if attempted {
        "Unfinished — give it another go".to_string()
    } else if has_history && rating >= profile.preferred_min {
        format!("Stretch target · {rating}")
    } else if has_history {
        format!("Solid practice · {rating}")
    } else {
        format!("Popular {rating} problem")
    }
}

struct Scored {
    problem: Problem,
    reason: String,
    score: f64,
    primary_tag: String,
    rating: u32,
    tier: u8,
}

fn problem_key(problem: &Problem) -> String {
    format!("{:?}:{}", problem.platform, problem.id)
}

fn submission_key(submission: &Submission) -> String {
    format!("{:?}:{}", submission.platform, submission.problem_id)
}

fn round_up_rating(rating: u32) -> u32 {
    ((rating + 99) / 100) * 100
}

fn percentile_rating(ratings: &[u32], percentile: usize) -> Option<u32> {
    if ratings.is_empty() {
        return None;
    }
    let mut sorted = ratings.to_vec();
    sorted.sort_unstable();
    let idx = ((sorted.len() - 1) * percentile + 50) / 100;
    sorted.get(idx).copied()
}

/// Greedily pick high-scoring problems while capping duplicate tags/ratings so
/// the list stays varied. Top up from the remainder if caps are too strict.
fn diversify(scored: Vec<Scored>, count: usize, has_history: bool) -> Vec<Recommendation> {
    if count == 0 || scored.is_empty() {
        return Vec::new();
    }

    let tag_cap = (count / 3).max(4);
    let rating_cap = if has_history {
        (count / 5).max(3)
    } else {
        (count / 4).max(4)
    };

    let mut tag_count: HashMap<String, usize> = HashMap::new();
    let mut rating_count: HashMap<u32, usize> = HashMap::new();
    let mut chosen: Vec<bool> = vec![false; scored.len()];
    let mut out: Vec<Recommendation> = Vec::new();

    for (i, s) in scored.iter().enumerate() {
        if out.len() >= count {
            break;
        }
        let t = tag_count.get(&s.primary_tag).copied().unwrap_or(0);
        let r = rating_count.get(&s.rating).copied().unwrap_or(0);
        if t >= tag_cap || r >= rating_cap {
            continue;
        }
        *tag_count.entry(s.primary_tag.clone()).or_insert(0) += 1;
        *rating_count.entry(s.rating).or_insert(0) += 1;
        chosen[i] = true;
        out.push(Recommendation {
            problem: s.problem.clone(),
            reason: s.reason.clone(),
        });
    }

    if out.len() < count {
        for (i, s) in scored.iter().enumerate() {
            if out.len() >= count {
                break;
            }
            if !chosen[i] {
                out.push(Recommendation {
                    problem: s.problem.clone(),
                    reason: s.reason.clone(),
                });
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn prob(id: &str, rating: u32, tags: &[&str]) -> Problem {
        Problem {
            platform: Platform::Codeforces,
            id: id.to_string(),
            name: id.to_string(),
            url: format!("https://codeforces.com/problemset/problem/{id}"),
            rating: Some(rating),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            category: None,
            solved_count: Some(10_000),
            status: SolveStatus::Unsolved,
        }
    }

    fn sub(problem_id: &str, verdict: Verdict, rating: u32, tags: &[&str]) -> Submission {
        Submission {
            platform: Platform::Codeforces,
            id: format!("sub-{problem_id}"),
            problem_id: problem_id.to_string(),
            problem_name: problem_id.to_string(),
            verdict,
            language: "cpp".into(),
            time_ms: None,
            memory_kb: None,
            submitted_at: Utc::now(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            rating: Some(rating),
        }
    }

    #[test]
    fn prefers_weak_topic_problems() {
        let problems = vec![
            prob("1A", 800, &["math"]),
            prob("2B", 1200, &["dp"]),
            prob("3C", 1210, &["greedy"]),
        ];
        let subs = vec![Submission {
            platform: Platform::Codeforces,
            id: "1".into(),
            problem_id: "9D".into(),
            problem_name: "x".into(),
            verdict: Verdict::WrongAnswer,
            language: "cpp".into(),
            time_ms: None,
            memory_kb: None,
            submitted_at: Utc::now(),
            tags: vec!["dp".into()],
            rating: Some(1200),
        }];
        let recs = recommend_problems(&subs, &problems, Some(1100), 2);
        assert!(!recs.is_empty());
        assert!(recs.iter().any(|r| r.problem.id == "2B"));
    }

    #[test]
    fn fills_default_count_when_pool_is_large() {
        let problems: Vec<Problem> = (700u32..1300)
            .flat_map(|r| {
                (0..3).map(move |i| {
                    prob(
                        &format!("{r}{i}"),
                        r,
                        &[match i {
                            0 => "dp",
                            1 => "greedy",
                            _ => "math",
                        }],
                    )
                })
            })
            .collect();
        let recs = recommend_problems(&[], &problems, Some(924), DEFAULT_COUNT);
        assert_eq!(recs.len(), DEFAULT_COUNT);
    }

    #[test]
    fn known_rating_prefers_stretch_band_before_easy_fallbacks() {
        let problems = vec![
            prob("easy", 900, &["math"]),
            prob("ok", 1200, &["greedy"]),
            prob("stretch-a", 1300, &["dp"]),
            prob("stretch-b", 1400, &["graphs"]),
            prob("stretch-c", 1500, &["data structures"]),
        ];
        let recs = recommend_problems(&[], &problems, Some(1000), 3);

        assert_eq!(recs.len(), 3);
        assert!(recs.iter().all(|r| r.problem.rating.unwrap() >= 1200));
        assert!(recs.iter().any(|r| r.problem.id == "stretch-a"));
    }

    #[test]
    fn solved_history_raises_the_recommendation_floor() {
        let problems = vec![
            prob("too-easy", 1000, &["math"]),
            prob("same-level", 1200, &["greedy"]),
            prob("stretch-a", 1400, &["dp"]),
            prob("stretch-b", 1500, &["graphs"]),
        ];
        let subs = vec![
            sub("old-1000", Verdict::Accepted, 1000, &["math"]),
            sub("old-1100", Verdict::Accepted, 1100, &["greedy"]),
            sub("old-1200", Verdict::Accepted, 1200, &["dp"]),
        ];
        let recs = recommend_problems(&subs, &problems, Some(1000), 2);

        assert_eq!(recs.len(), 2);
        assert!(recs.iter().all(|r| r.problem.rating.unwrap() >= 1400));
    }

    #[test]
    fn skips_cses_tasks_marked_solved_by_progress_sync() {
        let mut solved = prob("1068", 800, &["Introductory Problems"]);
        solved.platform = Platform::Cses;
        solved.status = SolveStatus::Solved;
        let mut unsolved = prob("1635", 1400, &["Dynamic Programming"]);
        unsolved.platform = Platform::Cses;

        let recs = recommend_problems(&[], &[solved, unsolved], Some(1000), 5);

        assert!(recs.iter().all(|r| r.problem.id != "1068"));
        assert!(recs.iter().any(|r| r.problem.id == "1635"));
    }

    #[test]
    fn fills_recommendations_from_local_cache_if_present() {
        let cache = match crate::data::cache::Cache::open() {
            Ok(c) => c,
            Err(_) => return,
        };
        let mut problems = cache.get_problems(Platform::Codeforces).unwrap_or_default();
        problems.extend(cache.get_problems(Platform::Cses).unwrap_or_default());
        if problems.len() < 100 {
            return;
        }
        let submissions = cache.get_all_submissions().unwrap_or_default();
        let rating = cache
            .get_rating_history(Platform::Codeforces)
            .ok()
            .and_then(|h| h.last().map(|r| r.new_rating));
        let recs = recommend_problems(&submissions, &problems, rating, DEFAULT_COUNT);
        assert!(
            recs.len() >= 20,
            "expected at least 20 recommendations from real cache, got {}",
            recs.len()
        );
    }

    #[test]
    fn skips_solved_problems() {
        let problems = vec![prob("1A", 1000, &["math"])];
        let subs = vec![Submission {
            platform: Platform::Codeforces,
            id: "1".into(),
            problem_id: "1A".into(),
            problem_name: "x".into(),
            verdict: Verdict::Accepted,
            language: "cpp".into(),
            time_ms: None,
            memory_kb: None,
            submitted_at: Utc::now(),
            tags: vec![],
            rating: Some(1000),
        }];
        let recs = recommend_problems(&subs, &problems, Some(1000), 5);
        assert!(recs.is_empty());
    }

    #[test]
    fn untouched_core_topic_is_surfaced_for_coverage() {
        // History solving dp, but graphs is a never-touched core prerequisite for
        // the target band. With two equally-rated in-band candidates, the uncovered
        // core topic should rank ahead of the already-known one.
        let problems = vec![
            prob("dp-known", 1700, &["dp"]),
            prob("graphs-new", 1700, &["graphs"]),
        ];
        let subs = vec![
            sub("dpx0", Verdict::Accepted, 1400, &["dp"]),
            sub("dpx1", Verdict::Accepted, 1400, &["dp"]),
            sub("dpx2", Verdict::Accepted, 1400, &["dp"]),
        ];
        let recs = recommend_problems(&subs, &problems, Some(1500), 2);
        assert_eq!(recs.len(), 2);
        assert_eq!(
            recs[0].problem.id, "graphs-new",
            "uncovered core topic should be surfaced first"
        );
    }
}
