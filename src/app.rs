use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;

use crate::data::cache::Cache;
use crate::data::config::Config;
use crate::data::models::*;
use crate::engine::recommender::{self, Recommendation};
use crate::engine::weakness;
use crate::engine::workspace;
use crate::platforms::PlatformClient;
use crate::platforms::codeforces::CodeforcesClient;
use crate::platforms::cses::CsesClient;
use crate::ui::theme::Theme;

/// Messages sent from the background refresh task back to the UI thread.
pub enum RefreshMsg {
    Status(String),
    Contests(Vec<Contest>),
    Done,
}

/// Result of the local test runner, sent from the background test task.
pub enum TestMsg {
    Done(Vec<TestResult>),
    Failed(String),
}

/// Persisted CSES progress (solved/attempted task ids) from a logged-in session.
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct CsesProgress {
    pub solved: Vec<String>,
    pub attempted: Vec<String>,
}

fn cses_progress_path() -> PathBuf {
    Config::data_dir().join("cses_progress.json")
}

fn legacy_cses_progress_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".cpos-vscode/cses-progress.json"))
}

fn has_saved_cses_progress() -> bool {
    cses_progress_path().exists()
        || legacy_cses_progress_path()
            .as_ref()
            .map_or(false, |path| path.exists())
}

pub fn load_cses_progress() -> CsesProgress {
    std::fs::read_to_string(cses_progress_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .or_else(|| {
            legacy_cses_progress_path().and_then(|path| {
                std::fs::read_to_string(path)
                    .ok()
                    .and_then(|s| serde_json::from_str(&s).ok())
            })
        })
        .unwrap_or_default()
}

pub fn save_cses_progress(p: &CsesProgress) {
    let _ = std::fs::create_dir_all(Config::data_dir());
    if let Ok(s) = serde_json::to_string_pretty(p) {
        let _ = std::fs::write(cses_progress_path(), &s);
        if let Some(home) = dirs::home_dir() {
            let vscode_dir = home.join(".cpos-vscode");
            let _ = std::fs::create_dir_all(&vscode_dir);
            let _ = std::fs::write(vscode_dir.join("cses-progress.json"), s);
        }
    }
}

/// Save CSES progress and record newly observed CSES activity with today's
/// timestamp. Existing solved history is kept as a baseline so CPOS does not
/// invent dates for old CSES solves.
pub fn save_cses_progress_with_activity(
    progress: &CsesProgress,
    cache: &Cache,
) -> anyhow::Result<Vec<Submission>> {
    use std::collections::{HashMap, HashSet};

    let had_previous = has_saved_cses_progress();
    let previous = load_cses_progress();

    if !had_previous {
        save_cses_progress(progress);
        return Ok(Vec::new());
    }

    let previous_solved: HashSet<&str> = previous.solved.iter().map(String::as_str).collect();
    let previous_attempted: HashSet<&str> = previous.attempted.iter().map(String::as_str).collect();
    let current_solved: HashSet<&str> = progress.solved.iter().map(String::as_str).collect();

    let problems: HashMap<String, Problem> = cache
        .get_problems(Platform::Cses)
        .unwrap_or_default()
        .into_iter()
        .map(|p| (p.id.clone(), p))
        .collect();
    let now = chrono::Utc::now();

    let mut submissions = Vec::new();
    for task_id in &progress.solved {
        if previous_solved.contains(task_id.as_str()) {
            continue;
        }
        let problem = problems.get(task_id);
        submissions.push(cses_progress_submission(
            task_id,
            Verdict::Accepted,
            now,
            problem,
        ));
    }
    for task_id in &progress.attempted {
        if current_solved.contains(task_id.as_str())
            || previous_solved.contains(task_id.as_str())
            || previous_attempted.contains(task_id.as_str())
        {
            continue;
        }
        let problem = problems.get(task_id);
        submissions.push(cses_progress_submission(
            task_id,
            Verdict::Other,
            now,
            problem,
        ));
    }

    if !submissions.is_empty() {
        cache.upsert_submissions(&submissions)?;
    }
    save_cses_progress(progress);
    Ok(submissions)
}

fn cses_progress_submission(
    task_id: &str,
    verdict: Verdict,
    submitted_at: chrono::DateTime<chrono::Utc>,
    problem: Option<&Problem>,
) -> Submission {
    let suffix = match verdict {
        Verdict::Accepted => "solved",
        _ => "attempted",
    };
    Submission {
        platform: Platform::Cses,
        id: format!("cses-{suffix}-{task_id}"),
        problem_id: task_id.to_string(),
        problem_name: problem
            .map(|p| p.name.clone())
            .unwrap_or_else(|| format!("CSES {task_id}")),
        verdict,
        language: "CSES progress".to_string(),
        time_ms: None,
        memory_kb: None,
        submitted_at,
        tags: problem.map(|p| p.tags.clone()).unwrap_or_default(),
        rating: problem.and_then(|p| p.rating),
    }
}

/// Everything the UI thread needs after the user starts working on a problem:
/// where the solution lives and which page to open in the browser.
pub struct StartedProblem {
    pub problem: Problem,
    pub solution_path: PathBuf,
    pub url: String,
    pub already_existed: bool,
}

/// A submission action prepared for the browser: the submit page to open and
/// the source code to drop onto the clipboard.
pub struct SubmitAction {
    pub submit_url: String,
    pub code: String,
    /// Human-readable language to pick on the submit page (e.g. "C++").
    pub language: String,
    /// The exact file whose contents are being submitted.
    pub file_name: String,
}

/// A friendly language name for the user's configured language key. Used to
/// tell the user which language to select on the submit page.
pub fn language_display(lang: &str) -> String {
    match lang {
        "c" => "C".to_string(),
        "cpp" => "C++".to_string(),
        "python" => "Python 3".to_string(),
        "pypy" => "PyPy 3".to_string(),
        "java" => "Java".to_string(),
        "kotlin" => "Kotlin".to_string(),
        "rust" => "Rust".to_string(),
        "go" => "Go".to_string(),
        "csharp" => "C#".to_string(),
        "javascript" => "JavaScript".to_string(),
        "ruby" => "Ruby".to_string(),
        "haskell" => "Haskell".to_string(),
        "pascal" => "Pascal".to_string(),
        other => other.to_string(),
    }
}

/// Normalize template text pasted from an editor or the terminal clipboard.
pub fn normalize_template_text(text: &str) -> String {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    text.lines()
        .map(|line| line.trim_end())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// Languages CPOS ships compile/run commands for, in a friendly display order.
/// Used by the setup wizard and config picker.
pub const LANGUAGES: [&str; 13] = [
    "cpp",
    "python",
    "java",
    "c",
    "rust",
    "go",
    "kotlin",
    "csharp",
    "javascript",
    "ruby",
    "haskell",
    "pascal",
    "pypy",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    Dashboard,
    Problems,
    Contests,
    Analytics,
    Recommend,
    Target,
    Config,
}

impl Tab {
    pub const ALL: [Tab; 7] = [
        Tab::Dashboard,
        Tab::Problems,
        Tab::Contests,
        Tab::Analytics,
        Tab::Recommend,
        Tab::Target,
        Tab::Config,
    ];

    pub fn label(&self) -> &str {
        match self {
            Tab::Dashboard => "Dashboard",
            Tab::Problems => "Problems",
            Tab::Contests => "Contests",
            Tab::Analytics => "Analytics",
            Tab::Recommend => "Recommend",
            Tab::Target => "Target",
            Tab::Config => "Config",
        }
    }

    pub fn next(&self) -> Tab {
        let idx = Tab::ALL.iter().position(|t| t == self).unwrap_or(0);
        Tab::ALL[(idx + 1) % Tab::ALL.len()]
    }

    pub fn prev(&self) -> Tab {
        let idx = Tab::ALL.iter().position(|t| t == self).unwrap_or(0);
        Tab::ALL[(idx + Tab::ALL.len() - 1) % Tab::ALL.len()]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformFilter {
    All,
    Single(Platform),
}

impl PlatformFilter {
    pub fn label(&self) -> &str {
        match self {
            PlatformFilter::All => "All",
            PlatformFilter::Single(Platform::Codeforces) => "Codeforces",
            PlatformFilter::Single(Platform::Cses) => "CSES",
            PlatformFilter::Single(Platform::AtCoder) => "AtCoder",
        }
    }

    pub fn next(&self) -> PlatformFilter {
        match self {
            PlatformFilter::All => PlatformFilter::Single(Platform::Codeforces),
            PlatformFilter::Single(Platform::Codeforces) => PlatformFilter::Single(Platform::Cses),
            PlatformFilter::Single(Platform::Cses) => PlatformFilter::All,
            PlatformFilter::Single(Platform::AtCoder) => PlatformFilter::All,
        }
    }
}

pub struct App {
    pub running: bool,
    pub active_tab: Tab,
    pub config: Config,
    pub theme: Theme,

    pub problems: Vec<Problem>,
    pub filtered_problems: Vec<Problem>,
    pub problem_selected: usize,
    pub platform_filter: PlatformFilter,
    pub search_query: String,
    pub search_active: bool,
    pub tag_filter: Option<String>,
    /// When set, show only the problems of this Codeforces contest (by id prefix).
    pub contest_filter: Option<String>,
    pub rating_min: Option<u32>,
    pub rating_max: Option<u32>,
    pub rating_input_active: bool,
    pub rating_input_buf: String,
    pub url_input_active: bool,
    pub url_input_buf: String,

    pub submissions: Vec<Submission>,
    pub rating_history: Vec<RatingChange>,
    pub tag_stats: Vec<TagStats>,
    /// CSES solved/attempted task ids, read from a logged-in session.
    pub cses_solved: std::collections::HashSet<String>,
    pub cses_attempted: std::collections::HashSet<String>,

    pub recommendations: Vec<Recommendation>,
    pub recommend_selected: usize,

    // Targeted, goal-driven plan (Target tab).
    pub target_rating: u32,
    /// False until the user picks a goal, so we can auto-default from their rating.
    pub target_user_set: bool,
    pub target_plan: Option<crate::engine::target::TargetPlan>,
    pub target_selected: usize,
    pub target_input_active: bool,
    pub target_input_buf: String,

    pub contests: Vec<Contest>,
    pub contest_selected: usize,

    pub status_message: String,
    pub loading: bool,
    pub spinner_frame: usize,
    pub refresh_rx: Option<std::sync::mpsc::Receiver<RefreshMsg>>,

    // Local test runner state.
    pub testing: bool,
    pub test_rx: Option<std::sync::mpsc::Receiver<TestMsg>>,
    pub test_results: Option<Vec<TestResult>>,
    pub test_error: Option<String>,
    pub show_test_popup: bool,

    // Background status channel for non-blocking tasks (e.g. sample fetch).
    pub aux_rx: Option<std::sync::mpsc::Receiver<String>>,

    // Browser companion capture channel.
    pub capture_rx: Option<std::sync::mpsc::Receiver<crate::engine::capture::CaptureMsg>>,
    pub capture_port: Option<u16>,
    pub capture_server: Option<crate::engine::capture::CaptureServer>,

    /// External solution files (e.g. from VS Code capture) keyed by platform:id.
    pub solution_paths: std::collections::HashMap<String, PathBuf>,

    pub config_selected: usize,
    pub config_editing: bool,
    pub config_edit_buf: String,

    // First-run setup wizard.
    pub setup_active: bool,
    pub setup_step: SetupStep,
    pub setup_handle: String,
    pub setup_lang: String,
    pub setup_template: String,
    pub setup_template_scroll: u16,
    pub setup_cses: String,
    /// Paste vs. Upload sub-mode on the Template step.
    pub setup_template_mode: TemplateInput,
    /// File path being typed/pasted in Upload mode.
    pub setup_template_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupStep {
    Handle,
    Language,
    Template,
    Cses,
}

/// How the user is supplying their template on the Template step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemplateInput {
    /// Paste the whole template from the clipboard.
    Paste,
    /// Load the template from a file on disk.
    Upload,
}

impl App {
    pub fn new(config: Config) -> Self {
        let theme = Theme::from_name(&config.theme);
        App {
            running: true,
            active_tab: Tab::Dashboard,
            theme,
            config,
            problems: Vec::new(),
            filtered_problems: Vec::new(),
            problem_selected: 0,
            platform_filter: PlatformFilter::All,
            search_query: String::new(),
            search_active: false,
            tag_filter: None,
            contest_filter: None,
            rating_min: None,
            rating_max: None,
            rating_input_active: false,
            rating_input_buf: String::new(),
            url_input_active: false,
            url_input_buf: String::new(),
            submissions: Vec::new(),
            rating_history: Vec::new(),
            tag_stats: Vec::new(),
            cses_solved: std::collections::HashSet::new(),
            cses_attempted: std::collections::HashSet::new(),
            recommendations: Vec::new(),
            recommend_selected: 0,
            target_rating: crate::engine::target::next_milestone_above(1200),
            target_user_set: false,
            target_plan: None,
            target_selected: 0,
            target_input_active: false,
            target_input_buf: String::new(),
            contests: Vec::new(),
            contest_selected: 0,
            status_message: "Press 'r' to sync with Codeforces and CSES".to_string(),
            loading: false,
            spinner_frame: 0,
            refresh_rx: None,
            testing: false,
            test_rx: None,
            test_results: None,
            test_error: None,
            show_test_popup: false,
            aux_rx: None,
            capture_rx: None,
            capture_port: None,
            capture_server: None,
            solution_paths: std::collections::HashMap::new(),
            config_selected: 0,
            config_editing: false,
            config_edit_buf: String::new(),
            setup_active: false,
            setup_step: SetupStep::Handle,
            setup_handle: String::new(),
            setup_lang: "cpp".to_string(),
            setup_template: String::new(),
            setup_template_scroll: 0,
            setup_cses: String::new(),
            setup_template_mode: TemplateInput::Paste,
            setup_template_path: String::new(),
        }
    }

    /// Returns true if this looks like a first run (no Codeforces handle set),
    /// in which case the caller should open the setup wizard.
    pub fn needs_setup(&self) -> bool {
        self.config.cf_handle().is_none_or(|h| h.trim().is_empty())
    }

    /// Open the first-run setup wizard, pre-filling from any existing config.
    pub fn begin_setup(&mut self) {
        self.setup_active = true;
        self.setup_step = SetupStep::Handle;
        self.setup_handle = self.config.cf_handle().unwrap_or("").to_string();
        self.setup_lang = self.config.default_language.clone();
        self.setup_template.clear();
        self.setup_template_scroll = 0;
        self.setup_cses = self.config.cses_session.clone().unwrap_or_default();
        self.setup_template_mode = TemplateInput::Paste;
        self.setup_template_path.clear();
    }

    /// Load the file at `setup_template_path` into the template buffer (Upload
    /// mode). Returns an error message suitable for the status line on failure.
    pub fn load_template_from_path(&mut self) -> Result<usize, String> {
        let raw = self.setup_template_path.trim().trim_matches('"');
        if raw.is_empty() {
            return Err("Type a file path first.".to_string());
        }
        let path = PathBuf::from(raw);
        match std::fs::read_to_string(&path) {
            Ok(content) => {
                self.setup_template = normalize_template_text(&content);
                self.setup_template_scroll = 0;
                Ok(self.setup_template.lines().count())
            }
            Err(e) => Err(format!("Couldn't read {}: {e}", path.display())),
        }
    }

    /// Cycle the setup language selection through the supported list.
    /// `delta` of +1 moves forward, -1 backward.
    pub fn setup_cycle_lang(&mut self, delta: i32) {
        let cur = LANGUAGES
            .iter()
            .position(|l| *l == self.setup_lang)
            .unwrap_or(0) as i32;
        let len = LANGUAGES.len() as i32;
        let next = ((cur + delta) % len + len) % len;
        self.setup_lang = LANGUAGES[next as usize].to_string();
    }

    /// Persist the wizard's choices. Writes the pasted template to the workspace
    /// and points `template_file` at it. Returns the workspace root so the UI can
    /// open it in the user's editor.
    pub fn finish_setup(&mut self) -> PathBuf {
        let handle = self.setup_handle.trim().to_string();
        if !handle.is_empty() {
            self.config.handles.insert("codeforces".to_string(), handle);
        }
        self.config.default_language = self.setup_lang.clone();

        let root = workspace::root(&self.config);
        let _ = std::fs::create_dir_all(&root);

        if !self.setup_template.trim().is_empty() {
            let ext = self.solution_ext();
            let tdir = root.join("templates");
            let _ = std::fs::create_dir_all(&tdir);
            let tpath = tdir.join(format!("template.{ext}"));
            let content = normalize_template_text(&self.setup_template);
            if std::fs::write(&tpath, content).is_ok() {
                self.config.template_file = Some(tpath.to_string_lossy().to_string());
            }
        }

        let cses = self.setup_cses.trim().to_string();
        self.config.cses_session = if cses.is_empty() { None } else { Some(cses) };

        let _ = self.config.save();
        self.theme = Theme::from_name(&self.config.theme);
        self.setup_active = false;
        root
    }

    /// Close the wizard without saving (user chose to skip).
    pub fn skip_setup(&mut self) {
        self.setup_active = false;
        self.status_message =
            "Setup skipped — you can configure everything in the Config tab.".to_string();
    }

    pub fn apply_filters(&mut self) {
        let query_lower = self.search_query.to_lowercase();
        self.filtered_problems = self
            .problems
            .iter()
            .filter(|p| match self.platform_filter {
                PlatformFilter::All => true,
                PlatformFilter::Single(plat) => p.platform == plat,
            })
            .filter(|p| {
                if query_lower.is_empty() {
                    return true;
                }
                p.name.to_lowercase().contains(&query_lower)
                    || p.id.to_lowercase().contains(&query_lower)
                    || p.tags
                        .iter()
                        .any(|t| t.to_lowercase().contains(&query_lower))
            })
            .filter(|p| {
                if let Some(ref tag) = self.tag_filter {
                    p.tags
                        .iter()
                        .any(|t| t.to_lowercase() == tag.to_lowercase())
                        || p.category
                            .as_ref()
                            .map(|c| c.to_lowercase() == tag.to_lowercase())
                            .unwrap_or(false)
                } else {
                    true
                }
            })
            .filter(|p| match self.contest_filter {
                Some(ref cid) => {
                    p.platform == Platform::Codeforces
                        && p.id.starts_with(cid.as_str())
                        && p.id[cid.len()..]
                            .chars()
                            .next()
                            .is_some_and(|c| c.is_ascii_alphabetic())
                }
                None => true,
            })
            .filter(|p| {
                if self.rating_min.is_none() && self.rating_max.is_none() {
                    return true;
                }
                match p.rating {
                    Some(r) => {
                        self.rating_min.is_none_or(|lo| r >= lo)
                            && self.rating_max.is_none_or(|hi| r <= hi)
                    }
                    // With a rating window active, hide unrated problems.
                    None => false,
                }
            })
            .cloned()
            .collect();

        self.filtered_problems.sort_by(workspace::compare_problems);

        if self.problem_selected >= self.filtered_problems.len() {
            self.problem_selected = self.filtered_problems.len().saturating_sub(1);
        }
    }

    pub fn mark_solved_problems(&mut self) {
        let mut solved_set = std::collections::HashSet::new();
        let mut attempted_set = std::collections::HashSet::new();
        for sub in &self.submissions {
            let key = format!("{:?}:{}", sub.platform, sub.problem_id);
            if sub.verdict == Verdict::Accepted {
                solved_set.insert(key.clone());
            }
            attempted_set.insert(key);
        }

        for prob in &mut self.problems {
            // CSES solved status comes from the logged-in session, not submissions.
            if prob.platform == Platform::Cses {
                prob.status = if self.cses_solved.contains(&prob.id) {
                    SolveStatus::Solved
                } else if self.cses_attempted.contains(&prob.id) {
                    SolveStatus::Attempted
                } else {
                    SolveStatus::Unsolved
                };
                continue;
            }
            let key = format!("{:?}:{}", prob.platform, prob.id);
            if solved_set.contains(&key) {
                prob.status = SolveStatus::Solved;
            } else if attempted_set.contains(&key) {
                prob.status = SolveStatus::Attempted;
            } else {
                prob.status = SolveStatus::Unsolved;
            }
        }
    }

    pub fn compute_analytics(&mut self) {
        self.tag_stats = weakness::compute_tag_stats(&self.submissions, &self.problems);
    }

    pub fn compute_recommendations(&mut self) {
        let user_rating = self.rating_history.last().map(|r| r.new_rating);
        self.recommendations = recommender::recommend_problems(
            &self.submissions,
            &self.problems,
            user_rating,
            recommender::DEFAULT_COUNT,
        );
        if self.recommend_selected >= self.recommendations.len() {
            self.recommend_selected = 0;
        }
    }

    /// (Re)build the goal-driven plan for the Target tab. Auto-picks a sensible
    /// default goal (next rank milestone above the user's rating) until the user
    /// chooses one explicitly.
    pub fn compute_target_plan(&mut self) {
        use crate::engine::target;
        let user_rating = self.rating_history.last().map(|r| r.new_rating);
        if !self.target_user_set {
            let basis = user_rating.unwrap_or(1200).max(1100);
            self.target_rating = target::next_milestone_above(basis);
        }
        let plan = target::analyze_target(
            &self.submissions,
            &self.problems,
            user_rating,
            self.target_rating,
        );
        if self.target_selected >= plan.steps.len() {
            self.target_selected = 0;
        }
        self.target_plan = Some(plan);
    }

    /// Step the goal up/down through CF rank milestones and rebuild the plan.
    pub fn target_cycle(&mut self, dir: i32) {
        self.target_user_set = true;
        self.target_rating = crate::engine::target::cycle_milestone(self.target_rating, dir);
        self.target_selected = 0;
        self.compute_target_plan();
    }

    /// Set an exact custom goal rating and rebuild the plan.
    pub fn set_target_rating(&mut self, rating: u32) {
        self.target_user_set = true;
        self.target_rating = crate::engine::target::clamp_target(rating);
        self.target_selected = 0;
        self.compute_target_plan();
    }

    /// Commit the custom rating typed into the Target tab's input field.
    pub fn apply_target_input(&mut self) {
        if let Ok(rating) = self.target_input_buf.trim().parse::<u32>() {
            self.set_target_rating(rating);
        }
        self.target_input_buf.clear();
    }

    pub fn target_scroll_down(&mut self) {
        let len = self
            .target_plan
            .as_ref()
            .map(|p| p.steps.len())
            .unwrap_or(0);
        if len > 0 {
            self.target_selected = (self.target_selected + 1).min(len - 1);
        }
    }

    pub fn target_scroll_up(&mut self) {
        self.target_selected = self.target_selected.saturating_sub(1);
    }

    /// Start the selected plan step, jumping into the Problems workflow so
    /// test/submit target it (mirrors `start_recommended`).
    pub fn start_target_step(&mut self) -> Option<StartedProblem> {
        let problem = self
            .target_plan
            .as_ref()?
            .steps
            .get(self.target_selected)?
            .problem
            .clone();
        self.focus_problem(&problem);
        self.active_tab = Tab::Problems;
        self.start_problem_inner(problem)
    }

    pub async fn load_from_cache(&mut self) -> anyhow::Result<()> {
        let cache = Cache::open()?;
        let mut all_problems = Vec::new();
        for plat in &[Platform::Codeforces, Platform::Cses] {
            all_problems.extend(cache.get_problems(*plat)?);
        }
        self.problems = all_problems;
        self.submissions = cache.get_all_submissions()?;
        self.rating_history = cache.get_rating_history(Platform::Codeforces)?;

        let progress = load_cses_progress();
        self.cses_solved = progress.solved.into_iter().collect();
        self.cses_attempted = progress.attempted.into_iter().collect();

        self.mark_solved_problems();
        self.apply_filters();
        self.compute_analytics();
        self.compute_recommendations();
        self.compute_target_plan();

        let contests = cache.get_contests(Platform::Codeforces)?;
        self.set_contests(contests);
        Ok(())
    }

    /// Restore the last problem captured in the browser / VS Code extension.
    pub fn restore_session(&mut self) {
        let Some((problem, solution_path, _)) = workspace::load_latest_session() else {
            return;
        };

        if let Some(path) = solution_path {
            let can_restore_path = !workspace::has_explicit_workspace_dir(&self.config)
                || workspace::is_default_cpos_tree(&path, &self.config);
            if can_restore_path {
                self.set_solution_path(&problem, path);
            }
        }

        self.focus_problem(&problem);
        self.active_tab = Tab::Problems;
        self.status_message = format!(
            "Restored {} ({}) — press o to open, T to test",
            problem.id, problem.name
        );
    }

    pub fn persist_session(&self, problem: &Problem, solution_path: Option<&Path>) {
        let _ = workspace::save_session(problem, solution_path);
    }

    /// Friendly status line after loading cached data (before any background sync).
    pub fn note_cache_loaded(&mut self) {
        if self.loading {
            return;
        }
        if self.problems.is_empty() {
            return;
        }
        let n_problems = self.problems.len();
        let n_subs = self.submissions.len();
        let n_contests = self.contests.len();
        self.status_message = format!(
            "Ready — {n_problems} problems, {n_subs} submissions, {n_contests} contests (cached)"
        );
    }

    /// Number of consecutive CPOS activity days (ending today or yesterday).
    /// Any non-skipped submission counts, not only accepted submissions.
    pub fn current_streak(&self) -> u32 {
        use std::collections::HashSet;
        let mut days: HashSet<chrono::NaiveDate> = HashSet::new();
        for s in &self.submissions {
            if s.verdict != Verdict::Skipped {
                days.insert(s.submitted_at.with_timezone(&chrono::Local).date_naive());
            }
        }
        if days.is_empty() {
            return 0;
        }
        let mut day = chrono::Local::now().date_naive();
        if !days.contains(&day) {
            // Missing today doesn't break a streak yet; check yesterday.
            day = day.pred_opt().unwrap_or(day);
            if !days.contains(&day) {
                return 0;
            }
        }
        let mut streak = 0;
        while days.contains(&day) {
            streak += 1;
            match day.pred_opt() {
                Some(d) => day = d,
                None => break,
            }
        }
        streak
    }

    pub fn solved_count(&self) -> usize {
        self.problems
            .iter()
            .filter(|p| p.status == SolveStatus::Solved)
            .count()
    }

    pub fn current_rating(&self) -> Option<u32> {
        self.rating_history.last().map(|r| r.new_rating)
    }

    pub fn cycle_theme(&mut self) {
        let next = Theme::next_name(&self.config.theme);
        self.config.theme = next.to_string();
        self.theme = Theme::from_name(next);
        let _ = self.config.save();
        self.status_message = format!("Theme set to '{next}'");
    }

    pub fn scroll_down(&mut self) {
        if !self.filtered_problems.is_empty() {
            self.problem_selected =
                (self.problem_selected + 1).min(self.filtered_problems.len() - 1);
        }
    }

    pub fn scroll_up(&mut self) {
        self.problem_selected = self.problem_selected.saturating_sub(1);
    }

    pub fn page_down(&mut self) {
        if !self.filtered_problems.is_empty() {
            self.problem_selected =
                (self.problem_selected + 20).min(self.filtered_problems.len() - 1);
        }
    }

    pub fn page_up(&mut self) {
        self.problem_selected = self.problem_selected.saturating_sub(20);
    }

    pub fn selected_problem(&self) -> Option<&Problem> {
        self.filtered_problems.get(self.problem_selected)
    }

    pub fn open_selected_problem(&self) {
        if let Some(p) = self.selected_problem() {
            workspace::os_open(&p.url);
        }
    }

    /// File extension for the user's default language.
    pub fn solution_ext(&self) -> String {
        self.config
            .compile_commands
            .get(&self.config.default_language)
            .map(|c| c.extension.clone())
            .unwrap_or_else(|| "txt".to_string())
    }

    /// The managed solution file for a problem — the single source of truth that
    /// `o`/`T`/`s` all operate on. Uses a VS Code path when one was forwarded.
    pub fn solution_file(&self, problem: &Problem) -> PathBuf {
        if let Some(path) = self.solution_paths.get(&Self::problem_key(problem)) {
            if path.exists() {
                return path.clone();
            }
        }
        workspace::solution_path(&self.config, problem, &self.solution_ext())
    }

    pub fn set_solution_path(&mut self, problem: &Problem, path: PathBuf) {
        self.solution_paths.insert(Self::problem_key(problem), path);
    }

    fn problem_key(problem: &Problem) -> String {
        format!("{:?}:{}", problem.platform, problem.id)
    }

    /// Scaffold (or reopen) the solution file for the selected problem and
    /// return what the UI needs to open the statement + editor.
    pub fn start_problem(&mut self) -> Option<StartedProblem> {
        let problem = self.selected_problem()?.clone();
        self.start_problem_inner(problem)
    }

    /// Same as [`start_problem`] but resolving the problem from a pasted URL.
    /// Works even for problems that haven't been synced into the cache.
    pub fn start_problem_from_url(&mut self, url: &str) -> Option<StartedProblem> {
        let parsed = match parse_problem_url(url) {
            Some(p) => p,
            None => {
                self.status_message =
                    "Couldn't parse that as a Codeforces or CSES problem URL".to_string();
                return None;
            }
        };

        // Prefer the richer cached problem (has name/tags/rating) if we have it.
        let problem = self
            .problems
            .iter()
            .find(|p| p.platform == parsed.platform && p.id == parsed.id)
            .cloned()
            .unwrap_or(parsed);

        self.focus_problem(&problem);
        self.start_problem_inner(problem)
    }

    /// Start a problem received from the browser companion. Unlike the URL flow,
    /// we already have structured data and don't need to open the browser (the
    /// user is already on the page).
    pub fn start_problem_from_capture(&mut self, problem: Problem) -> Option<StartedProblem> {
        self.focus_problem(&problem);
        self.active_tab = Tab::Problems;

        if let Some(path) = self
            .solution_paths
            .get(&Self::problem_key(&problem))
            .cloned()
        {
            if path.exists() {
                let n = workspace::load_tests(&self.config, &problem).len();
                self.status_message = format!(
                    "Browser capture: {} — selected ({} sample{})",
                    problem.name,
                    n,
                    if n == 1 { "" } else { "s" },
                );
                self.persist_session(&problem, Some(&path));
                return Some(StartedProblem {
                    url: problem.url.clone(),
                    problem,
                    solution_path: path,
                    already_existed: true,
                });
            }
        }

        let started = self.start_problem_inner(problem)?;
        let n = workspace::load_tests(&self.config, &started.problem).len();
        self.status_message = format!(
            "Browser capture: {} — selected ({} sample{})",
            started.problem.name,
            n,
            if n == 1 { "" } else { "s" },
        );
        Some(started)
    }

    /// Start the currently-selected recommendation, jumping into the Problems
    /// workflow so test/submit target it.
    pub fn start_recommended(&mut self) -> Option<StartedProblem> {
        let problem = self
            .recommendations
            .get(self.recommend_selected)?
            .problem
            .clone();
        self.focus_problem(&problem);
        self.active_tab = Tab::Problems;
        self.start_problem_inner(problem)
    }

    /// Ensure a problem is present in the list, clear filters, and select it so
    /// subsequent actions (test/submit) target it.
    fn focus_problem(&mut self, problem: &Problem) {
        if !self
            .problems
            .iter()
            .any(|p| p.platform == problem.platform && p.id == problem.id)
        {
            self.problems.push(problem.clone());
        }
        self.platform_filter = PlatformFilter::All;
        self.search_query.clear();
        self.tag_filter = None;
        self.contest_filter = None;
        self.rating_min = None;
        self.rating_max = None;
        self.apply_filters();
        if let Some(idx) = self
            .filtered_problems
            .iter()
            .position(|p| p.platform == problem.platform && p.id == problem.id)
        {
            self.problem_selected = idx;
        } else {
            // Shouldn't happen once filters are cleared — keep the capture visible.
            self.filtered_problems.insert(0, problem.clone());
            self.problem_selected = 0;
        }
    }

    pub fn recommend_scroll_down(&mut self) {
        if !self.recommendations.is_empty() {
            self.recommend_selected =
                (self.recommend_selected + 1).min(self.recommendations.len() - 1);
        }
    }

    pub fn recommend_scroll_up(&mut self) {
        self.recommend_selected = self.recommend_selected.saturating_sub(1);
    }

    pub fn contest_scroll_down(&mut self) {
        if !self.contests.is_empty() {
            self.contest_selected = (self.contest_selected + 1).min(self.contests.len() - 1);
        }
    }

    pub fn contest_scroll_up(&mut self) {
        self.contest_selected = self.contest_selected.saturating_sub(1);
    }

    pub fn selected_contest_url(&self) -> Option<String> {
        self.contests
            .get(self.contest_selected)
            .map(|c| c.url.clone())
    }

    /// Filter the Problems tab to the selected contest's problems and switch to
    /// it. Returns the number of problems found (0 means none are cached yet —
    /// e.g. the contest hasn't started, so the caller should open the browser).
    pub fn open_contest_problems(&mut self) -> usize {
        let Some(contest) = self.contests.get(self.contest_selected).cloned() else {
            return 0;
        };
        self.search_query.clear();
        self.tag_filter = None;
        self.rating_min = None;
        self.rating_max = None;
        self.platform_filter = PlatformFilter::All;
        self.contest_filter = Some(contest.id.clone());
        self.problem_selected = 0;
        self.apply_filters();
        let n = self.filtered_problems.len();
        if n > 0 {
            self.active_tab = Tab::Problems;
            self.status_message = format!(
                "{n} problems from {} — press 'o' to start one",
                contest.name
            );
        } else {
            self.contest_filter = None;
            self.apply_filters();
        }
        n
    }

    /// Order contests for display: running + upcoming first (soonest first),
    /// then the most recent finished contests (capped, since CF returns years
    /// of history).
    pub fn set_contests(&mut self, mut contests: Vec<Contest>) {
        refresh_contest_phases(&mut contests);
        let mut upcoming: Vec<Contest> = contests
            .iter()
            .filter(|c| c.phase != ContestPhase::Finished)
            .cloned()
            .collect();
        upcoming.sort_by_key(|c| c.start_time);

        let mut finished: Vec<Contest> = contests
            .into_iter()
            .filter(|c| c.phase == ContestPhase::Finished)
            .collect();
        finished.sort_by(|a, b| b.start_time.cmp(&a.start_time));
        finished.truncate(40);

        upcoming.extend(finished);
        self.contests = upcoming;
        self.contest_selected = 0;
    }

    fn start_problem_inner(&mut self, problem: Problem) -> Option<StartedProblem> {
        let ext = self.solution_ext();
        let template = workspace::template_content(&self.config, &self.config.default_language);

        if let Some(external) = self
            .solution_paths
            .get(&Self::problem_key(&problem))
            .cloned()
        {
            let already_existed = external.exists();
            if !external.exists() {
                if let Some(parent) = external.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if std::fs::write(&external, &template).is_err() {
                    self.status_message =
                        format!("Could not create solution file at {}", external.display());
                    return None;
                }
            }
            self.persist_session(&problem, Some(&external));
            let url = problem.url.clone();
            self.status_message = format!(
                "{} {} — {}",
                if already_existed {
                    "Reopened"
                } else {
                    "Started"
                },
                problem.id,
                external.display()
            );
            return Some(StartedProblem {
                problem,
                solution_path: external,
                url,
                already_existed,
            });
        }

        if let Some(user_dir) = workspace::active_user_save_dir(&self.config, &self.solution_paths)
        {
            let solution_path = workspace::solution_path_in_dir(&user_dir, &problem, &ext);
            let already_existed = solution_path.exists();
            if let Some(parent) = solution_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if !already_existed {
                if std::fs::write(&solution_path, &template).is_err() {
                    self.status_message = format!(
                        "Could not create solution file at {}",
                        solution_path.display()
                    );
                    return None;
                }
            }
            self.set_solution_path(&problem, solution_path.clone());
            self.persist_session(&problem, Some(&solution_path));
            let url = problem.url.clone();
            self.status_message = format!(
                "{} {} — {}",
                if already_existed {
                    "Reopened"
                } else {
                    "Started"
                },
                problem.id,
                solution_path.display()
            );
            return Some(StartedProblem {
                problem,
                solution_path,
                url,
                already_existed,
            });
        }

        let already_existed = workspace::solution_path(&self.config, &problem, &ext).exists();
        let solution_path = match workspace::scaffold(&self.config, &problem, &ext, &template) {
            Ok(p) => p,
            Err(e) => {
                self.status_message = format!("Could not create solution file: {e}");
                return None;
            }
        };

        self.persist_session(&problem, Some(&solution_path));
        let url = problem.url.clone();
        self.status_message = format!(
            "{} {} — {}",
            if already_existed {
                "Reopened"
            } else {
                "Started"
            },
            problem.id,
            solution_path.display()
        );
        Some(StartedProblem {
            problem,
            solution_path,
            url,
            already_existed,
        })
    }

    /// Gather the solution code + submit URL for the selected problem.
    pub fn prepare_submit(&mut self) -> Option<SubmitAction> {
        let problem = self.selected_problem()?.clone();
        let ext = self.solution_ext();
        let path = self.solution_file(&problem);
        let code = match std::fs::read_to_string(&path) {
            Ok(c) if !c.trim().is_empty() => c,
            _ => {
                self.status_message =
                    "Nothing to submit yet — open the problem in your browser or press 'o', then write your solution"
                        .to_string();
                return None;
            }
        };
        let submit_url = match submit_url_for(&problem) {
            Some(u) => u,
            None => {
                self.status_message = "Submitting isn't supported for this platform".to_string();
                return None;
            }
        };
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("sol.{ext}"));
        Some(SubmitAction {
            submit_url,
            code,
            language: language_display(&self.config.default_language),
            file_name,
        })
    }

    /// Validate that the selected problem can be tested locally and return the
    /// inputs the background runner needs.
    pub fn prepare_test(
        &mut self,
    ) -> Option<(PathBuf, crate::data::config::CompileConfig, Vec<TestCase>)> {
        let problem = self.selected_problem()?.clone();
        let path = self.solution_file(&problem);
        if !path.exists() {
            self.status_message =
                "No solution file yet — press 'o' to open this problem first".to_string();
            return None;
        }
        let cfg = match self
            .config
            .compile_commands
            .get(&self.config.default_language)
        {
            Some(c) => c.clone(),
            None => {
                self.status_message =
                    format!("No compile command for '{}'", self.config.default_language);
                return None;
            }
        };
        let tests = workspace::load_tests(&self.config, &problem);
        if tests.is_empty() {
            self.status_message =
                "No samples cached — open the problem in your browser (companion auto-captures) or press 'o'".to_string();
            return None;
        }
        Some((path, cfg, tests))
    }

    /// Apply the free-text rating filter buffer (e.g. "1300-1600", "1500+",
    /// "1500"). An empty buffer clears the filter.
    pub fn apply_rating_input(&mut self) {
        let raw = self.rating_input_buf.trim();
        if raw.is_empty() {
            self.rating_min = None;
            self.rating_max = None;
        } else if let Some((lo, hi)) = raw.split_once('-') {
            self.rating_min = lo.trim().parse().ok();
            self.rating_max = hi.trim().parse().ok();
        } else if let Some(lo) = raw.strip_suffix('+') {
            self.rating_min = lo.trim().parse().ok();
            self.rating_max = None;
        } else {
            let v = raw.parse().ok();
            self.rating_min = v;
            self.rating_max = v;
        }
        self.problem_selected = 0;
        self.apply_filters();
    }

    pub fn rating_filter_label(&self) -> Option<String> {
        match (self.rating_min, self.rating_max) {
            (None, None) => None,
            (Some(lo), Some(hi)) if lo == hi => Some(lo.to_string()),
            (Some(lo), Some(hi)) => Some(format!("{lo}-{hi}")),
            (Some(lo), None) => Some(format!("{lo}+")),
            (None, Some(hi)) => Some(format!("≤{hi}")),
        }
    }

    pub fn clear_filters(&mut self) {
        self.tag_filter = None;
        self.contest_filter = None;
        self.search_query.clear();
        self.rating_min = None;
        self.rating_max = None;
        self.problem_selected = 0;
        self.apply_filters();
    }

    pub fn cycle_platform(&mut self) {
        self.platform_filter = self.platform_filter.next();
        self.problem_selected = 0;
        self.apply_filters();
    }

    pub fn config_fields(&self) -> Vec<(&str, String)> {
        vec![
            (
                "Codeforces Handle",
                self.config.cf_handle().unwrap_or("").to_string(),
            ),
            (
                "Default Language",
                language_display(&self.config.default_language),
            ),
            ("Theme", self.config.theme.clone()),
            (
                "Workspace Dir",
                workspace::root(&self.config).display().to_string(),
            ),
            (
                "Template File",
                self.config.template_file.clone().unwrap_or_default(),
            ),
            (
                "CSES Session",
                if self.config.cses_session.is_some() {
                    "connected".to_string()
                } else {
                    String::new()
                },
            ),
        ]
    }

    /// True if the currently-selected config field is a "pick" field that
    /// cycles on Enter rather than being free-text edited.
    pub fn config_field_is_cycle(&self) -> bool {
        // Default Language (1) and Theme (2) cycle through preset options.
        self.config_selected == 1 || self.config_selected == 2
    }

    /// Advance the selected cycle field to its next preset value.
    pub fn cycle_config(&mut self) {
        match self.config_selected {
            1 => {
                let cur = LANGUAGES
                    .iter()
                    .position(|l| *l == self.config.default_language)
                    .unwrap_or(0);
                self.config.default_language = LANGUAGES[(cur + 1) % LANGUAGES.len()].to_string();
                let _ = self.config.save();
            }
            2 => self.cycle_theme(),
            _ => {}
        }
    }

    pub fn start_config_edit(&mut self) {
        let fields = self.config_fields();
        if let Some((_, val)) = fields.get(self.config_selected) {
            self.config_edit_buf = val.clone();
            self.config_editing = true;
        }
    }

    pub fn save_config_edit(&mut self) {
        let old_workspace_root = (self.config_selected == 3).then(|| workspace::root(&self.config));

        match self.config_selected {
            0 => {
                self.config
                    .handles
                    .insert("codeforces".to_string(), self.config_edit_buf.clone());
            }
            1 => {
                self.config.default_language = self.config_edit_buf.clone();
            }
            3 => {
                let v = self.config_edit_buf.trim();
                self.config.workspace_dir = if v.is_empty() {
                    None
                } else {
                    Some(v.to_string())
                };
            }
            4 => {
                let v = self.config_edit_buf.trim();
                self.config.template_file = if v.is_empty() {
                    None
                } else {
                    Some(v.to_string())
                };
            }
            5 => {
                let v = self.config_edit_buf.trim();
                self.config.cses_session = if v.is_empty() {
                    None
                } else {
                    Some(v.to_string())
                };
            }
            _ => {}
        }

        let workspace_changed = old_workspace_root
            .as_ref()
            .is_some_and(|old| old != &workspace::root(&self.config));
        if workspace_changed {
            self.solution_paths.clear();
        }

        self.config_editing = false;
        let saved_cses = self.config_selected == 5;
        let _ = self.config.save();
        self.status_message = if saved_cses && self.config.cses_session.is_some() {
            "CSES cookie saved — press r to sync, or visit cses.fi/problemset/list/ logged in"
                .to_string()
        } else if workspace_changed {
            format!(
                "Configuration saved — workspace is {}",
                workspace::root(&self.config).display()
            )
        } else {
            "Configuration saved".to_string()
        };
    }
}

/// Recompute live/upcoming/finished from timestamps so cached contests stay
/// accurate between syncs.
fn refresh_contest_phases(contests: &mut [Contest]) {
    let now = chrono::Utc::now();
    for c in contests.iter_mut() {
        let end = c.start_time + chrono::Duration::seconds(c.duration_seconds as i64);
        c.phase = if now < c.start_time {
            ContestPhase::Before
        } else if now < end {
            ContestPhase::Running
        } else {
            ContestPhase::Finished
        };
    }
}

/// Fetch fresh data from the online judges and write it into the local cache.
/// Runs on a background task; progress is reported back over `tx`. The UI
/// thread reloads from the cache once `RefreshMsg::Done` arrives.
pub async fn fetch_and_cache(
    handle: Option<String>,
    cses_session: Option<String>,
    tx: Sender<RefreshMsg>,
) {
    let cf = CodeforcesClient::new();
    let cses = CsesClient::new();

    let cache = match Cache::open() {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(RefreshMsg::Status(format!("Cache error: {e}")));
            let _ = tx.send(RefreshMsg::Done);
            return;
        }
    };

    let _ = tx.send(RefreshMsg::Status(
        "Syncing Codeforces problemset…".to_string(),
    ));
    match cf.fetch_problems().await {
        Ok(problems) => {
            let _ = cache.upsert_problems(&problems);
            let _ = tx.send(RefreshMsg::Status(format!(
                "Loaded {} Codeforces problems",
                problems.len()
            )));
        }
        Err(e) => {
            let _ = tx.send(RefreshMsg::Status(format!("Codeforces error: {e}")));
        }
    }

    let _ = tx.send(RefreshMsg::Status("Syncing CSES problemset…".to_string()));
    if let Ok(problems) = cses.fetch_problems().await {
        let _ = cache.upsert_problems(&problems);
    }

    if let Some(session) = cses_session.filter(|s| !s.trim().is_empty()) {
        let _ = tx.send(RefreshMsg::Status(
            "Reading your CSES progress…".to_string(),
        ));
        match cses.fetch_solved(&session).await {
            Ok((solved, attempted)) => {
                let n = solved.len();
                let progress = CsesProgress { solved, attempted };
                let new_activity = save_cses_progress_with_activity(&progress, &cache)
                    .map(|subs| subs.len())
                    .unwrap_or(0);
                let _ = tx.send(RefreshMsg::Status(if n == 0 {
                    "CSES connected (0 solved so far)".to_string()
                } else if new_activity > 0 {
                    format!("CSES: {n} problems solved ({new_activity} new activity)")
                } else {
                    format!("CSES: {n} problems solved")
                }));
            }
            Err(e) => {
                let _ = tx.send(RefreshMsg::Status(format!("CSES connect failed: {e}")));
            }
        }
    }

    let _ = tx.send(RefreshMsg::Status(
        "Fetching upcoming contests…".to_string(),
    ));
    match cf.fetch_contests().await {
        Ok(contests) => {
            let _ = cache.upsert_contests(&contests);
            let _ = tx.send(RefreshMsg::Contests(contests));
        }
        Err(e) => {
            let _ = tx.send(RefreshMsg::Status(format!("Contest fetch error: {e}")));
        }
    }

    if let Some(handle) = handle {
        let _ = tx.send(RefreshMsg::Status(format!(
            "Fetching submissions for {handle}…"
        )));
        match cf.fetch_submissions(&handle).await {
            Ok(subs) => {
                let _ = cache.upsert_submissions(&subs);
                let _ = tx.send(RefreshMsg::Status(format!(
                    "Loaded {} submissions for {handle}",
                    subs.len()
                )));
            }
            Err(e) => {
                let _ = tx.send(RefreshMsg::Status(format!("Codeforces: {e}")));
            }
        }
        if let Ok(history) = cf.fetch_rating_history(&handle).await {
            let _ = cache.upsert_rating_history(Platform::Codeforces, &history);
        }
    } else {
        let _ = tx.send(RefreshMsg::Status(
            "No Codeforces handle set — add it in the Config tab".to_string(),
        ));
    }

    let _ = tx.send(RefreshMsg::Done);
}

/// Parse a Codeforces or CSES problem URL into a (possibly minimal) Problem.
/// Accepts the common Codeforces forms (`/problemset/problem/{c}/{i}`,
/// `/contest/{c}/problem/{i}`, `/gym/{c}/problem/{i}`) and CSES `/task/{id}`.
fn parse_problem_url(url: &str) -> Option<Problem> {
    let trimmed = url.trim();
    let base = trimmed.split(['?', '#']).next().unwrap_or(trimmed);
    let segs: Vec<&str> = base.split('/').filter(|s| !s.is_empty()).collect();

    let make = |platform: Platform, id: String, url: String| Problem {
        platform,
        id: id.clone(),
        name: id,
        url,
        rating: None,
        tags: Vec::new(),
        category: None,
        solved_count: None,
        status: SolveStatus::Unsolved,
    };

    if base.contains("codeforces.com") {
        let pi = segs.iter().position(|s| *s == "problem")?;
        let (contest, index) =
            if let Some(ci) = segs.iter().position(|s| *s == "contest" || *s == "gym") {
                (segs.get(ci + 1)?.to_string(), segs.get(pi + 1)?.to_string())
            } else {
                (segs.get(pi + 1)?.to_string(), segs.get(pi + 2)?.to_string())
            };
        if contest.is_empty() || index.is_empty() {
            return None;
        }
        let index = index.to_uppercase();
        let id = format!("{contest}{index}");
        let url = format!("https://codeforces.com/problemset/problem/{contest}/{index}");
        return Some(make(Platform::Codeforces, id, url));
    }

    if base.contains("cses.fi") {
        let ti = segs.iter().position(|s| *s == "task")?;
        let id = segs.get(ti + 1)?.to_string();
        if id.is_empty() {
            return None;
        }
        let url = format!("https://cses.fi/problemset/task/{id}/");
        return Some(make(Platform::Cses, id, url));
    }

    None
}

/// Build the platform-specific submit page URL for a problem.
fn submit_url_for(problem: &Problem) -> Option<String> {
    match problem.platform {
        Platform::Codeforces => {
            let contest: String = problem
                .id
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if contest.is_empty() {
                return None;
            }
            let index: String = problem
                .id
                .chars()
                .skip_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .to_uppercase();
            if index.is_empty() {
                return Some(format!("https://codeforces.com/contest/{contest}/submit"));
            }
            Some(format!(
                "https://codeforces.com/contest/{contest}/submit?submittedProblemIndex={index}"
            ))
        }
        Platform::Cses => Some(format!("https://cses.fi/problemset/submit/{}/", problem.id)),
        Platform::AtCoder => None,
    }
}

fn parse_cf_parts(id: &str) -> (Option<String>, Option<String>) {
    let contest: String = id.chars().take_while(|c| c.is_ascii_digit()).collect();
    let index: String = id
        .chars()
        .skip_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .to_uppercase();
    if contest.is_empty() {
        return (None, None);
    }
    (
        Some(contest),
        if index.is_empty() { None } else { Some(index) },
    )
}

fn platform_key(platform: Platform) -> &'static str {
    match platform {
        Platform::Codeforces => "codeforces",
        Platform::Cses => "cses",
        Platform::AtCoder => "atcoder",
    }
}

/// Queue a pending submission for the browser companion and return the payload.
pub fn queue_pending_submit(
    capture: &crate::engine::capture::CaptureServer,
    problem: &Problem,
    action: &SubmitAction,
    language_key: &str,
) {
    let (contest, index) = parse_cf_parts(&problem.id);
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64 + 120_000)
        .unwrap_or(0);
    capture.set_pending_submit(crate::data::models::PendingSubmit {
        ok: true,
        platform: platform_key(problem.platform).to_string(),
        id: problem.id.clone(),
        contest,
        index,
        code: action.code.clone(),
        language: language_key.to_string(),
        file_name: action.file_name.clone(),
        submit_url: action.submit_url.clone(),
        expires_at,
    });
}

/// Fetch sample tests for a problem in the background and cache them to disk.
/// Progress/errors are reported back over `tx` as a status line.
pub async fn fetch_samples_task(problem: Problem, config: Config, tx: Sender<String>) {
    let result = match problem.platform {
        Platform::Codeforces => CodeforcesClient::new().fetch_samples(&problem.url).await,
        Platform::Cses => CsesClient::new().fetch_samples(&problem.url).await,
        Platform::AtCoder => Err(anyhow::anyhow!("AtCoder is not supported yet")),
    };

    match result {
        Ok(tests) => {
            let n = tests.len();
            let _ = workspace::save_tests(&config, &problem, &tests);
            let _ = tx.send(format!(
                "Fetched {n} sample test(s) for {} — press T to run them",
                problem.id
            ));
        }
        Err(e) => {
            let _ = tx.send(format!(
                "Couldn't auto-fetch samples for {} ({e})",
                problem.id
            ));
        }
    }
}

/// Compile and run the user's solution against the sample tests on a
/// background task, sending results back over `tx`.
pub async fn run_tests_task(
    source: PathBuf,
    cfg: crate::data::config::CompileConfig,
    tests: Vec<TestCase>,
    tx: Sender<TestMsg>,
) {
    match crate::engine::runner::run_all_tests(&source, &cfg, &tests, 5000).await {
        Ok(results) => {
            let _ = tx.send(TestMsg::Done(results));
        }
        Err(e) => {
            let _ = tx.send(TestMsg::Failed(e.to_string()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Local};

    fn submission_on_local_day(platform: Platform, days_ago: i64, verdict: Verdict) -> Submission {
        let submitted_at = (Local::now() - Duration::days(days_ago)).with_timezone(&chrono::Utc);
        Submission {
            platform,
            id: format!("sub-{days_ago}"),
            problem_id: format!("p-{days_ago}"),
            problem_name: "Problem".to_string(),
            verdict,
            language: "GNU C++23".to_string(),
            time_ms: None,
            memory_kb: None,
            submitted_at,
            tags: Vec::new(),
            rating: None,
        }
    }

    #[test]
    fn parses_codeforces_problemset_url() {
        let p = parse_problem_url("https://codeforces.com/problemset/problem/4/A").unwrap();
        assert_eq!(p.platform, Platform::Codeforces);
        assert_eq!(p.id, "4A");
    }

    #[test]
    fn parses_codeforces_contest_url() {
        let p = parse_problem_url("https://codeforces.com/contest/1095/problem/f").unwrap();
        assert_eq!(p.platform, Platform::Codeforces);
        assert_eq!(p.id, "1095F");
    }

    #[test]
    fn parses_codeforces_url_with_query_and_slash() {
        let p = parse_problem_url("https://codeforces.com/problemset/problem/1700/C/?locale=en")
            .unwrap();
        assert_eq!(p.id, "1700C");
    }

    #[test]
    fn parses_cses_task_url() {
        let p = parse_problem_url("https://cses.fi/problemset/task/1068/").unwrap();
        assert_eq!(p.platform, Platform::Cses);
        assert_eq!(p.id, "1068");
    }

    #[test]
    fn rejects_unrelated_url() {
        assert!(parse_problem_url("https://example.com/foo/bar").is_none());
    }

    #[test]
    fn current_streak_counts_all_platform_activity_days() {
        let mut app = App::new(Config::default());
        app.submissions = (0..10)
            .map(|days_ago| {
                let platform = if days_ago % 2 == 0 {
                    Platform::Codeforces
                } else {
                    Platform::Cses
                };
                let verdict = if days_ago == 3 || days_ago == 6 {
                    Verdict::WrongAnswer
                } else {
                    Verdict::Accepted
                };
                submission_on_local_day(platform, days_ago, verdict)
            })
            .collect();
        app.submissions.push(submission_on_local_day(
            Platform::Cses,
            10,
            Verdict::Skipped,
        ));

        assert_eq!(app.current_streak(), 10);
    }
}
