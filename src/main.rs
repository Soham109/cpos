use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::TryRecvError;
use std::time::Duration;

use anyhow::Result;
use crossterm::ExecutableCommand;
use crossterm::event::{
    self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEventKind, KeyModifiers,
};
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use ratatui::prelude::*;

use cpos::app::{self, App, CsesProgress, RefreshMsg, SetupStep, StartedProblem, Tab, TestMsg};
use cpos::data::cache::Cache;
use cpos::data::config::Config;
use cpos::engine::capture::{self, CaptureMsg};
use cpos::engine::workspace;
use cpos::ui;

fn main() -> Result<()> {
    if let Some(cmd) = std::env::args().nth(1) {
        match cmd.trim().to_ascii_lowercase().as_str() {
            "setup-browser" => return setup_browser_command(),
            "update" => return cpos::engine::update::run(),
            "help" | "--help" | "-h" => {
                print_help();
                return Ok(());
            }
            _ => {
                eprintln!("Unknown command: {cmd}");
                eprintln!("Run `cpos help` for usage.");
                std::process::exit(1);
            }
        }
    }

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run_tui())
}

/// On Windows the console defaults to a legacy code page, which renders the
/// UI's box-drawing glyphs and arrows (→ ✓ • … ▸) as Cyrillic mojibake — the
/// "everything is in Russian" bug. Switch input and output to UTF-8.
#[cfg(windows)]
fn enable_utf8_console() {
    unsafe extern "system" {
        fn SetConsoleOutputCP(code_page: u32) -> i32;
        fn SetConsoleCP(code_page: u32) -> i32;
    }
    const CP_UTF8: u32 = 65001;
    unsafe {
        SetConsoleOutputCP(CP_UTF8);
        SetConsoleCP(CP_UTF8);
    }
}

#[cfg(not(windows))]
fn enable_utf8_console() {}

async fn run_tui() -> Result<()> {
    enable_utf8_console();

    if maybe_prompt_for_updates().await? {
        return Ok(());
    }

    let config = Config::load()?;
    let mut app = App::new(config);

    let _ = app.load_from_cache().await;
    app.restore_session();
    app.note_cache_loaded();

    // Start the browser companion capture listener.
    let (cap_tx, cap_rx) = std::sync::mpsc::channel();
    if let Some(server) = capture::start(cap_tx) {
        app.capture_port = Some(server.port);
        app.capture_server = Some(server);
        app.capture_rx = Some(cap_rx);
    }

    // First run (no handle configured yet): open the setup wizard.
    if app.needs_setup() {
        app.begin_setup();
    }

    enable_raw_mode()?;
    io::stdout().execute(EnterAlternateScreen)?;
    io::stdout().execute(EnableBracketedPaste)?;
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend)?;

    // Sync in the background on launch when cache is empty, contests missing,
    // or the last sync is older than a few hours.
    if !app.setup_active && (app.problems.is_empty() || app.contests.is_empty() || sync_is_stale())
    {
        trigger_refresh(&mut app);
    }

    let result = run_app(&mut terminal, &mut app).await;

    io::stdout().execute(DisableBracketedPaste)?;
    disable_raw_mode()?;
    io::stdout().execute(LeaveAlternateScreen)?;

    if let Err(e) = result {
        eprintln!("Error: {e}");
    }

    Ok(())
}

async fn maybe_prompt_for_updates() -> Result<bool> {
    if !cpos::engine::update::startup_check_enabled() {
        return Ok(false);
    }

    let check = match tokio::time::timeout(
        Duration::from_millis(900),
        cpos::engine::update::check_latest(),
    )
    .await
    {
        Ok(Ok(check)) => check,
        _ => return Ok(false),
    };

    if check.is_empty() {
        return Ok(false);
    }

    eprintln!();
    eprintln!("CPOS update available");
    for update in &check.updates {
        eprintln!("  {} -> {}", update.current, update.latest);
    }
    eprintln!();

    if check.terminal_update_available() {
        if io::stdin().is_terminal() && io::stderr().is_terminal() {
            eprint!("Update CPOS now? [y/N] ");
            let _ = io::stderr().flush();
            let mut answer = String::new();
            io::stdin().read_line(&mut answer)?;
            if matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
                cpos::engine::update::run()?;
                return Ok(true);
            }
        } else {
            eprintln!("Run `cpos update` later to update CPOS.");
        }
    }

    eprintln!("Opening CPOS...\n");
    Ok(false)
}

async fn run_app(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut App,
) -> Result<()> {
    loop {
        drain_refresh(app).await;
        drain_aux(app);
        drain_tests(app);
        drain_captures(app);

        if app.loading || app.testing {
            app.spinner_frame = app.spinner_frame.wrapping_add(1);
        }

        terminal.draw(|frame| ui::draw(frame, app))?;

        if !app.running {
            break;
        }

        // Short poll keeps the spinner animating (~12 fps) while idle.
        if event::poll(Duration::from_millis(80))? {
            match event::read()? {
                // Bracketed paste — route the whole blob to whatever text field
                // is active (template box, config edit, URL, or search).
                Event::Paste(text) => handle_paste(app, &text),
                Event::Key(key) => {
                    if key.kind != KeyEventKind::Press {
                        continue;
                    }

                    if key.modifiers.contains(KeyModifiers::CONTROL)
                        && key.code == KeyCode::Char('c')
                    {
                        app.running = false;
                        continue;
                    }

                    // The setup wizard is modal: it owns all input while open.
                    if app.setup_active {
                        handle_setup_input(app, key);
                        continue;
                    }

                    if app.search_active {
                        handle_search_input(app, key.code);
                        continue;
                    }

                    if app.rating_input_active {
                        handle_rating_input(app, key.code);
                        continue;
                    }

                    if app.target_input_active {
                        handle_target_text_input(app, key.code);
                        continue;
                    }

                    if app.url_input_active {
                        handle_url_input(app, key.code);
                        continue;
                    }

                    if app.config_editing {
                        handle_config_edit_input(app, key.code);
                        continue;
                    }

                    // The test-results popup swallows input until dismissed.
                    if app.show_test_popup {
                        if matches!(key.code, KeyCode::Esc | KeyCode::Enter | KeyCode::Char('q')) {
                            app.show_test_popup = false;
                        }
                        continue;
                    }

                    handle_input(app, key.code);
                }
                _ => {}
            }
        }
    }

    Ok(())
}

/// Route a pasted blob to the active text field. This is how the setup wizard
/// lets you paste a whole template in one go.
fn handle_paste(app: &mut App, text: &str) {
    use cpos::app::TemplateInput;
    if app.setup_active && app.setup_step == SetupStep::Handle {
        // Handles are single-line: take the first non-empty line only.
        if let Some(line) = text.lines().find(|l| !l.trim().is_empty()) {
            app.setup_handle.push_str(line.trim());
        }
    } else if app.setup_active && app.setup_step == SetupStep::Template {
        match app.setup_template_mode {
            TemplateInput::Paste => {
                app.setup_template = app::normalize_template_text(text);
                app.setup_template_scroll = 0;
            }
            TemplateInput::Upload => {
                app.setup_template_path.push_str(text.trim());
            }
        }
    } else if app.setup_active && app.setup_step == SetupStep::Cses {
        app.setup_cses.push_str(text.trim());
    } else if app.config_editing {
        app.config_edit_buf.push_str(text.trim());
    } else if app.url_input_active {
        app.url_input_buf.push_str(text.trim());
    } else if app.search_active {
        app.search_query.push_str(text.trim());
        app.apply_filters();
    }
}

/// Modal input for the first-run setup wizard.
fn handle_setup_input(app: &mut App, key: crossterm::event::KeyEvent) {
    let code = key.code;
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    match app.setup_step {
        SetupStep::Handle => match code {
            KeyCode::Esc => app.skip_setup(),
            KeyCode::Enter => app.setup_step = SetupStep::Language,
            KeyCode::Backspace => {
                app.setup_handle.pop();
            }
            // Handles are single-line; drop any newlines a keystroke-paste injects.
            KeyCode::Char(c) if !c.is_whitespace() => app.setup_handle.push(c),
            _ => {}
        },
        SetupStep::Language => match code {
            KeyCode::Esc => app.skip_setup(),
            KeyCode::Enter => app.setup_step = SetupStep::Template,
            KeyCode::Left | KeyCode::Char('h') => app.setup_cycle_lang(-1),
            KeyCode::Right | KeyCode::Char('l') | KeyCode::Tab | KeyCode::Char(' ') => {
                app.setup_cycle_lang(1)
            }
            _ => {}
        },
        SetupStep::Template => handle_template_input(app, code, ctrl),
        SetupStep::Cses => match code {
            // Enter and Esc both finish here (CSES is the last, optional step).
            KeyCode::Enter | KeyCode::Esc => finish_setup(app),
            KeyCode::Char('o') | KeyCode::Char('O') => {
                open_url("https://cses.fi/login");
            }
            KeyCode::Backspace => {
                app.setup_cses.clear();
            }
            _ => {}
        },
    }
}

/// Input for the Template step, which toggles between Paste and Upload modes.
fn handle_template_input(app: &mut App, code: KeyCode, ctrl: bool) {
    use cpos::app::TemplateInput;

    // Tab switches between pasting and uploading a file.
    if code == KeyCode::BackTab || (code == KeyCode::Tab) {
        app.setup_template_mode = match app.setup_template_mode {
            TemplateInput::Paste => TemplateInput::Upload,
            TemplateInput::Upload => TemplateInput::Paste,
        };
        return;
    }

    match app.setup_template_mode {
        TemplateInput::Paste => match code {
            KeyCode::Esc => app.skip_setup(),
            KeyCode::Enter => {
                app.setup_step = SetupStep::Cses;
                app.setup_template_scroll = 0;
            }
            // v or Ctrl+V pulls the whole clipboard in — reliable across terminals.
            KeyCode::Char('v') | KeyCode::Char('V') => paste_template_from_clipboard(app),
            KeyCode::Char(_) if ctrl => paste_template_from_clipboard(app),
            KeyCode::Backspace => {
                app.setup_template.clear();
                app.setup_template_scroll = 0;
            }
            KeyCode::Up => {
                app.setup_template_scroll = app.setup_template_scroll.saturating_sub(1);
            }
            KeyCode::Down => {
                let lines = app.setup_template.lines().count();
                let max = lines.saturating_sub(1) as u16;
                app.setup_template_scroll = (app.setup_template_scroll + 1).min(max);
            }
            _ => {}
        },
        TemplateInput::Upload => match code {
            KeyCode::Esc => app.skip_setup(),
            // Enter loads the file; once loaded, Enter again continues.
            KeyCode::Enter => {
                if app.setup_template.trim().is_empty() {
                    match app.load_template_from_path() {
                        Ok(n) => {
                            app.status_message = format!("Loaded template ({n} lines).");
                        }
                        Err(e) => app.status_message = e,
                    }
                } else {
                    app.setup_step = SetupStep::Cses;
                    app.setup_template_scroll = 0;
                }
            }
            KeyCode::Backspace => {
                app.setup_template_path.pop();
                // Editing the path invalidates a previously loaded preview.
                app.setup_template.clear();
                app.setup_template_scroll = 0;
            }
            // Ctrl+V pastes a copied path; plain characters type into the field.
            KeyCode::Char(_) if ctrl => {
                if let Some(text) = read_clipboard() {
                    app.setup_template_path.push_str(text.trim());
                }
            }
            KeyCode::Char(c) => app.setup_template_path.push(c),
            _ => {}
        },
    }
}

/// Pull the clipboard contents into the template buffer (Paste mode).
fn paste_template_from_clipboard(app: &mut App) {
    match read_clipboard() {
        Some(text) => {
            app.setup_template = app::normalize_template_text(&text);
            app.setup_template_scroll = 0;
            let n = app.setup_template.lines().count();
            app.status_message = format!("Pasted template ({n} lines).");
        }
        None => {
            app.status_message =
                "Clipboard is empty or unavailable — copy your template first.".to_string();
        }
    }
}

/// Persist setup, open the workspace folder in the editor, and start a sync.
fn finish_setup(app: &mut App) {
    let folder = app.finish_setup();
    open_in_editor(app.config.editor.as_deref(), &folder);
    app.status_message = format!(
        "All set! Your solutions live in {} — opened it in your editor. Syncing…",
        folder.display()
    );
    trigger_refresh(app);
}

/// How old (seconds) a sync can be before we auto-refresh on launch.
const SYNC_STALE_SECS: u64 = 3 * 60 * 60;

fn sync_stamp_path() -> std::path::PathBuf {
    Config::data_dir().join("last_sync")
}

/// True if we've never synced or the last sync is older than the staleness window.
fn sync_is_stale() -> bool {
    let Ok(contents) = std::fs::read_to_string(sync_stamp_path()) else {
        return true;
    };
    let Ok(then) = contents.trim().parse::<u64>() else {
        return true;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    now.saturating_sub(then) > SYNC_STALE_SECS
}

fn mark_synced() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = std::fs::create_dir_all(Config::data_dir());
    let _ = std::fs::write(sync_stamp_path(), now.to_string());
}

/// Drain background status messages (e.g. sample fetching).
fn drain_aux(app: &mut App) {
    if let Some(rx) = app.aux_rx.take() {
        let mut keep = true;
        loop {
            match rx.try_recv() {
                Ok(msg) => app.status_message = msg,
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    keep = false;
                    break;
                }
            }
        }
        if keep {
            app.aux_rx = Some(rx);
        }
    }
}

/// Drain results from the background local test runner.
fn drain_tests(app: &mut App) {
    if let Some(rx) = app.test_rx.take() {
        match rx.try_recv() {
            Ok(TestMsg::Done(results)) => {
                let passed = results.iter().filter(|r| r.passed).count();
                let total = results.len();
                app.status_message = format!("Tests finished — {passed}/{total} passed");
                app.test_results = Some(results);
                app.test_error = None;
                app.testing = false;
            }
            Ok(TestMsg::Failed(err)) => {
                app.status_message = format!("Test run failed: {err}");
                app.test_error = Some(err);
                app.test_results = None;
                app.testing = false;
            }
            Err(TryRecvError::Empty) => app.test_rx = Some(rx),
            Err(TryRecvError::Disconnected) => app.testing = false,
        }
    }
}

/// Process captured problems/progress sent by the browser companion.
fn drain_captures(app: &mut App) {
    let Some(rx) = app.capture_rx.take() else {
        return;
    };

    let mut msgs = Vec::new();
    while let Ok(msg) = rx.try_recv() {
        msgs.push(msg);
    }
    app.capture_rx = Some(rx);

    for msg in msgs {
        match msg {
            CaptureMsg::Problem(cap) => {
                let tests = cap.tests.clone();
                let external = cap.solution_path.clone();
                let problem = cap.into_problem();

                if !tests.is_empty() {
                    let _ = workspace::save_tests(&app.config, &problem, &tests);
                }
                if let Some(ref path) = external {
                    app.set_solution_path(&problem, PathBuf::from(path));
                }

                let _ = app.start_problem_from_capture(problem.clone());
                app.persist_session(&problem, external.as_deref().map(Path::new));
            }
            CaptureMsg::CsesProgress(progress) => {
                let progress = CsesProgress {
                    solved: progress.solved,
                    attempted: progress.attempted,
                };
                let n = progress.solved.len();
                let a = progress.attempted.len();
                let new_activity = match Cache::open() {
                    Ok(cache) => {
                        app::save_cses_progress_with_activity(&progress, &cache).unwrap_or_default()
                    }
                    Err(_) => {
                        app::save_cses_progress(&progress);
                        Vec::new()
                    }
                };
                let new_count = new_activity.len();
                if !new_activity.is_empty() {
                    app.submissions.extend(new_activity);
                    app.submissions
                        .sort_by(|a, b| b.submitted_at.cmp(&a.submitted_at));
                    app.compute_analytics();
                    app.compute_recommendations();
                    app.compute_target_plan();
                }
                app.cses_solved = progress.solved.into_iter().collect();
                app.cses_attempted = progress.attempted.into_iter().collect();
                app.mark_solved_problems();
                app.apply_filters();
                app.status_message = if new_count > 0 {
                    format!("CSES synced — {n} solved, {a} attempted ({new_count} today)")
                } else if n > 0 {
                    format!("CSES synced — {n} solved, {a} attempted")
                } else if a > 0 {
                    format!("CSES synced — {a} attempted")
                } else {
                    "CSES synced (no scored tasks yet)".to_string()
                };
            }
        }
    }
}

/// Pull any pending messages from the background refresh task.
async fn drain_refresh(app: &mut App) {
    if let Some(rx) = app.refresh_rx.take() {
        let mut still_open = true;
        loop {
            match rx.try_recv() {
                Ok(RefreshMsg::Status(s)) => app.status_message = s,
                Ok(RefreshMsg::Contests(c)) => app.set_contests(c),
                Ok(RefreshMsg::Done) => {
                    still_open = false;
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    still_open = false;
                    break;
                }
            }
        }

        if still_open {
            app.refresh_rx = Some(rx);
        } else {
            app.loading = false;
            mark_synced();
            let _ = app.load_from_cache().await;
            let n_problems = app.problems.len();
            let n_subs = app.submissions.len();
            let cses_note = match app.cses_solved.len() {
                n if n > 0 => format!(" · CSES ✓ ({n} solved)"),
                _ if app.config.cses_session.is_some() => {
                    " · CSES: cookie may be expired (use browser companion instead)".to_string()
                }
                _ => String::new(),
            };
            app.status_message = if n_subs > 0 {
                format!("Synced — {n_problems} problems, {n_subs} submissions{cses_note}")
            } else if let Some(h) = app.config.cf_handle() {
                format!(
                    "Synced {n_problems} problems, but found 0 submissions — is '{h}' your exact Codeforces handle? (Config to change)"
                )
            } else {
                format!(
                    "Synced {n_problems} problems. Set your Codeforces handle in Config to track solves, rating, and recommendations."
                )
            };
        }
    }
}

/// Kick off a background data refresh if one isn't already running.
fn trigger_refresh(app: &mut App) {
    if app.loading {
        return;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    app.refresh_rx = Some(rx);
    app.loading = true;
    app.spinner_frame = 0;
    app.status_message = "Starting sync…".to_string();
    let handle = app.config.cf_handle().map(|s| s.to_string());
    let cses_session = app.config.cses_session.clone();
    tokio::spawn(app::fetch_and_cache(handle, cses_session, tx));
}

/// Start working on the selected problem: scaffold the solution file, open the
/// statement in the browser, open the file in the editor, and fetch samples.
fn start_selected_problem(app: &mut App) {
    if let Some(sp) = app.start_problem() {
        launch_started(app, sp);
    }
}

/// Same, but for a problem resolved from a pasted URL.
fn start_problem_from_url(app: &mut App, url: &str) {
    if let Some(sp) = app.start_problem_from_url(url) {
        launch_started(app, sp);
    }
}

/// Open the statement in the browser, open the solution file in the editor, and
/// kick off background sample fetching.
fn launch_started(app: &mut App, started: StartedProblem) {
    let StartedProblem {
        problem,
        solution_path,
        url,
        ..
    } = started;

    open_url(&url);
    open_in_editor(app.config.editor.as_deref(), &solution_path);

    let (tx, rx) = std::sync::mpsc::channel();
    app.aux_rx = Some(rx);
    let config = app.config.clone();
    tokio::spawn(app::fetch_samples_task(problem, config, tx));
}

/// Run the selected problem's solution against its cached sample tests.
fn run_selected_tests(app: &mut App) {
    if app.testing {
        return;
    }
    let Some((source, cfg, tests)) = app.prepare_test() else {
        return;
    };
    let (tx, rx) = std::sync::mpsc::channel();
    app.test_rx = Some(rx);
    app.testing = true;
    app.show_test_popup = true;
    app.test_results = None;
    app.test_error = None;
    app.spinner_frame = 0;
    app.status_message = "Compiling and running sample tests…".to_string();
    tokio::spawn(app::run_tests_task(source, cfg, tests, tx));
}

/// Prepare a submission: queue it for the browser companion, copy to clipboard,
/// and open the platform submit page in the user's logged-in browser session.
fn submit_selected(app: &mut App) {
    let Some(problem) = app.selected_problem().cloned() else {
        return;
    };
    let Some(action) = app.prepare_submit() else {
        return;
    };

    if let Some(server) = &app.capture_server {
        app::queue_pending_submit(server, &problem, &action, &app.config.default_language);
    }

    // The submit page is opened and filled by the CPOS Chrome companion, which
    // polls this app on localhost. We deliberately do NOT open the system default
    // browser here so the submission always lands in the logged-in Chrome session.
    let copied = copy_to_clipboard(&action.code);
    app.status_message = if copied {
        format!("Submitting {} — opening submit page in Chrome…", problem.id)
    } else {
        format!(
            "Submitting {} in Chrome (clipboard unavailable — code is queued)",
            problem.id
        )
    };
}

fn open_url(url: &str) {
    workspace::os_open(url);
}

/// Run a shell command line, discarding output. Uses `cmd /C` on Windows and
/// `sh -c` elsewhere so custom editor commands work on every platform.
fn run_shell(cmd: &str) -> bool {
    use std::process::Stdio;
    let mut command = if cfg!(target_os = "windows") {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", cmd]);
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.arg("-c").arg(cmd);
        c
    };
    command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
}

/// Launch an editor binary (e.g. `code`, `cursor`) on a file. On Windows these
/// are `.cmd` shims that `Command` can't spawn directly, so we go through `cmd`.
fn run_editor(editor_cmd: &str, path: &Path) -> bool {
    use std::process::Stdio;
    let mut command = std::process::Command::new(if cfg!(target_os = "windows") {
        "cmd"
    } else {
        editor_cmd
    });
    if cfg!(target_os = "windows") {
        command.arg("/C").arg(editor_cmd);
    }
    command
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
}

/// Open a file in the user's editor. Auto-detects Cursor/VS Code when no
/// working custom command is configured, then falls back to the OS default.
fn open_in_editor(editor: Option<&str>, path: &Path) {
    if let Some(tmpl) = editor.filter(|s| !s.trim().is_empty()) {
        let cmd = if tmpl.contains("{file}") {
            tmpl.replace("{file}", &path.to_string_lossy())
        } else {
            format!("{tmpl} {}", path.to_string_lossy())
        };
        if let Some(program) = cmd.split_whitespace().next() {
            if command_exists(program) && run_shell(&cmd) {
                return;
            }
        }
    }

    for editor_cmd in ["cursor", "code"] {
        if command_exists(editor_cmd) && run_editor(editor_cmd, path) {
            return;
        }
    }
    workspace::os_open(&path.to_string_lossy());
}

fn command_exists(name: &str) -> bool {
    use std::process::Stdio;
    if cfg!(target_os = "windows") {
        std::process::Command::new("where")
            .arg(name)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    } else {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("command -v {name} >/dev/null 2>&1"))
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

/// Copy text to the system clipboard (`clip` on Windows, `pbcopy` on macOS,
/// `xclip` on Linux).
fn copy_to_clipboard(text: &str) -> bool {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut command = if cfg!(target_os = "windows") {
        Command::new("clip")
    } else if cfg!(target_os = "macos") {
        Command::new("pbcopy")
    } else {
        let mut c = Command::new("xclip");
        c.args(["-selection", "clipboard"]);
        c
    };

    let child = command.stdin(Stdio::piped()).spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(_) => return false,
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(text.as_bytes());
    }
    child.wait().map(|s| s.success()).unwrap_or(false)
}

/// Read the system clipboard as text (`Get-Clipboard` on Windows, `pbpaste` on
/// macOS, `xclip`/`xsel` on Linux). This is how the setup wizard pastes a whole
/// multi-line template reliably even where the terminal doesn't emit bracketed
/// paste events (notably Windows conhost).
fn read_clipboard() -> Option<String> {
    use std::process::Command;

    let output = if cfg!(target_os = "windows") {
        // Force UTF-8 so non-ASCII template characters survive the pipe, and
        // -Raw so newlines are preserved instead of being split into an array.
        Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard -Raw",
            ])
            .output()
    } else if cfg!(target_os = "macos") {
        Command::new("pbpaste").output()
    } else {
        Command::new("xclip")
            .args(["-selection", "clipboard", "-o"])
            .output()
            .or_else(|_| Command::new("xsel").args(["--clipboard", "--output"]).output())
    };

    let output = output.ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn handle_input(app: &mut App, key: KeyCode) {
    // Keys common to every tab.
    match key {
        KeyCode::Char('q') => {
            app.running = false;
            return;
        }
        KeyCode::Tab => {
            app.active_tab = app.active_tab.next();
            return;
        }
        KeyCode::BackTab => {
            app.active_tab = app.active_tab.prev();
            return;
        }
        KeyCode::Char('r') => {
            trigger_refresh(app);
            return;
        }
        _ => {}
    }

    match app.active_tab {
        Tab::Problems => handle_problems_input(app, key),
        Tab::Config => handle_config_input(app, key),
        Tab::Recommend => handle_recommend_input(app, key),
        Tab::Target => handle_target_input(app, key),
        Tab::Contests => handle_contests_input(app, key),
        Tab::Dashboard | Tab::Analytics => {}
    }
}

fn handle_contests_input(app: &mut App, key: KeyCode) {
    match key {
        KeyCode::Char('j') | KeyCode::Down => app.contest_scroll_down(),
        KeyCode::Char('k') | KeyCode::Up => app.contest_scroll_up(),
        // Enter/o: jump into this contest's problems (solve them right here). If
        // none are cached yet (contest not started), open the page instead.
        KeyCode::Enter | KeyCode::Char('o') => {
            if app.open_contest_problems() == 0 {
                if let Some(url) = app.selected_contest_url() {
                    open_url(&url);
                    app.status_message =
                        "No problems yet (not started?) — opened the contest page".to_string();
                }
            }
        }
        KeyCode::Char('b') => {
            if let Some(url) = app.selected_contest_url() {
                open_url(&url);
                app.status_message = "Opened contest in your browser".to_string();
            }
        }
        _ => {}
    }
}

fn handle_recommend_input(app: &mut App, key: KeyCode) {
    match key {
        KeyCode::Char('j') | KeyCode::Down => app.recommend_scroll_down(),
        KeyCode::Char('k') | KeyCode::Up => app.recommend_scroll_up(),
        KeyCode::Enter | KeyCode::Char('o') => {
            if let Some(sp) = app.start_recommended() {
                launch_started(app, sp);
            }
        }
        _ => {}
    }
}

fn handle_target_input(app: &mut App, key: KeyCode) {
    match key {
        KeyCode::Char('j') | KeyCode::Down => app.target_scroll_down(),
        KeyCode::Char('k') | KeyCode::Up => app.target_scroll_up(),
        // Step the goal through CF rank milestones.
        KeyCode::Char('[') | KeyCode::Char('h') | KeyCode::Left => app.target_cycle(-1),
        KeyCode::Char(']') | KeyCode::Char('l') | KeyCode::Right => app.target_cycle(1),
        // Type an exact custom goal.
        KeyCode::Char('t') => {
            app.target_input_active = true;
            app.target_input_buf.clear();
        }
        KeyCode::Enter | KeyCode::Char('o') => {
            if let Some(sp) = app.start_target_step() {
                launch_started(app, sp);
            }
        }
        _ => {}
    }
}

/// Custom-goal entry field on the Target tab.
fn handle_target_text_input(app: &mut App, key: KeyCode) {
    match key {
        KeyCode::Esc => {
            app.target_input_active = false;
            app.target_input_buf.clear();
        }
        KeyCode::Enter => {
            app.target_input_active = false;
            app.apply_target_input();
        }
        KeyCode::Backspace => {
            app.target_input_buf.pop();
        }
        KeyCode::Char(c) if c.is_ascii_digit() => app.target_input_buf.push(c),
        _ => {}
    }
}

fn handle_search_input(app: &mut App, key: KeyCode) {
    match key {
        KeyCode::Esc => app.search_active = false,
        KeyCode::Enter => {
            app.search_active = false;
            app.apply_filters();
        }
        KeyCode::Backspace => {
            app.search_query.pop();
            app.apply_filters();
        }
        KeyCode::Char(c) => {
            app.search_query.push(c);
            app.apply_filters();
        }
        _ => {}
    }
}

fn handle_config_edit_input(app: &mut App, key: KeyCode) {
    match key {
        KeyCode::Esc => app.config_editing = false,
        KeyCode::Enter => app.save_config_edit(),
        KeyCode::Backspace => {
            app.config_edit_buf.pop();
        }
        KeyCode::Char(c) => app.config_edit_buf.push(c),
        _ => {}
    }
}

fn handle_problems_input(app: &mut App, key: KeyCode) {
    match key {
        KeyCode::Char('j') | KeyCode::Down => app.scroll_down(),
        KeyCode::Char('k') | KeyCode::Up => app.scroll_up(),
        KeyCode::Char('G') => app.page_down(),
        KeyCode::Char('g') => app.page_up(),
        KeyCode::Char('d') => app.page_down(),
        KeyCode::Char('u') => app.page_up(),
        KeyCode::Char('o') => start_selected_problem(app),
        KeyCode::Char('U') => {
            app.url_input_active = true;
            app.url_input_buf.clear();
        }
        KeyCode::Char('b') => app.open_selected_problem(),
        KeyCode::Char('T') => run_selected_tests(app),
        KeyCode::Char('s') => submit_selected(app),
        KeyCode::Char('/') => {
            app.search_active = true;
            app.search_query.clear();
            app.apply_filters();
        }
        KeyCode::Char('f') => {
            app.rating_input_active = true;
            app.rating_input_buf.clear();
        }
        KeyCode::Char('p') => app.cycle_platform(),
        KeyCode::Char('c') => app.clear_filters(),
        KeyCode::Char('t') => {
            if let Some(tag) = app.selected_problem().and_then(|p| p.tags.first()).cloned() {
                app.tag_filter = Some(tag);
                app.apply_filters();
            }
        }
        _ => {}
    }
}

fn handle_rating_input(app: &mut App, key: KeyCode) {
    match key {
        KeyCode::Esc => app.rating_input_active = false,
        KeyCode::Enter => {
            app.rating_input_active = false;
            app.apply_rating_input();
        }
        KeyCode::Backspace => {
            app.rating_input_buf.pop();
        }
        KeyCode::Char(c) if c.is_ascii_digit() || c == '-' || c == '+' => {
            app.rating_input_buf.push(c)
        }
        _ => {}
    }
}

fn handle_url_input(app: &mut App, key: KeyCode) {
    match key {
        KeyCode::Esc => app.url_input_active = false,
        KeyCode::Enter => {
            app.url_input_active = false;
            let url = app.url_input_buf.clone();
            if !url.trim().is_empty() {
                start_problem_from_url(app, &url);
            }
        }
        KeyCode::Backspace => {
            app.url_input_buf.pop();
        }
        KeyCode::Char(c) => app.url_input_buf.push(c),
        _ => {}
    }
}

fn print_help() {
    eprintln!(
        "CPOS v{version}

Usage:
  cpos                 Open the terminal app
  cpos update          Update the terminal app
  cpos setup-browser   Generate a local browser helper extension
  cpos help            Show this help

On startup, CPOS does a quick best-effort check for terminal app updates.
Set CPOS_NO_UPDATE_CHECK=1 to skip this check.
VS Code and Chrome update their extensions through their own stores.",
        version = env!("CARGO_PKG_VERSION")
    );
}

/// Generate browser setup helpers and point users at the checked-in/publishable
/// companion extension. Runs as `cpos setup-browser` before the TUI starts.
fn setup_browser_command() -> Result<()> {
    let dir = Config::data_dir().join("browser-helper");
    std::fs::create_dir_all(&dir)?;

    let port = capture::DEFAULT_PORT;

    // --- Chrome/Edge/Brave unpacked extension ---
    let ext_dir = dir.join("chrome-extension");
    std::fs::create_dir_all(&ext_dir)?;

    let manifest = serde_json::json!({
        "manifest_version": 3,
        "name": "CPOS Companion",
        "version": "0.1.0",
        "description": "Send Codeforces/CSES problems and samples to CPOS",
        "permissions": [],
        "host_permissions": [
            format!("http://127.0.0.1:{port}/*"),
            "http://127.0.0.1:27122/*"
        ],
        "content_scripts": [{
            "matches": [
                "https://codeforces.com/problemset/problem/*",
                "https://codeforces.com/contest/*/problem/*",
                "https://codeforces.com/gym/*/problem/*",
                "https://cses.fi/problemset/task/*",
                "https://cses.fi/problemset/list*",
                "https://cses.fi/problemset/list/*"
            ],
            "js": ["content.js"],
            "run_at": "document_idle"
        }],
        "icons": {}
    });
    std::fs::write(
        ext_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;

    let content_js = generate_content_js(port);
    std::fs::write(ext_dir.join("content.js"), content_js)?;

    // --- Bookmarklet fallback ---
    let bookmarklet = generate_bookmarklet(port);
    std::fs::write(dir.join("bookmarklet.txt"), &bookmarklet)?;

    // --- Setup instructions page ---
    let setup_html = generate_setup_html(port, &ext_dir, &bookmarklet);
    let setup_path = dir.join("setup.html");
    std::fs::write(&setup_path, setup_html)?;

    // Open the setup page
    workspace::os_open(&setup_path.to_string_lossy());

    eprintln!("Browser companion files written to:");
    eprintln!("  {}", dir.display());
    eprintln!();
    eprintln!("Setup page opened in your browser.");
    eprintln!("Follow the instructions there to enable the extension.");

    Ok(())
}

fn generate_content_js(port: u16) -> String {
    format!(
        r#"
// CPOS Browser Companion — auto-captures problems and samples.
(function() {{
    const ENDPOINTS = [
        {{ name: 'CPOS VS Code', baseUrl: 'http://127.0.0.1:27122' }},
        {{ name: 'CPOS TUI', baseUrl: 'http://127.0.0.1:{port}' }}
    ];

    async function post(path, body) {{
        let lastError;
        for (const endpoint of ENDPOINTS) {{
            try {{
                const res = await fetch(`${{endpoint.baseUrl}}${{path}}`, {{
                    method: 'POST',
                    headers: {{ 'Content-Type': 'application/json' }},
                    body: JSON.stringify(body)
                }});
                const data = await res.json().catch(() => ({{}}));
                if (res.ok && data.ok !== false) return {{ endpoint, data }};
                lastError = data.error || `${{endpoint.name}} returned ${{res.status}}`;
            }} catch (e) {{
                lastError = e;
            }}
        }}
        throw lastError;
    }}

    // --- CSES problemset list: capture solved/attempted progress ---
    if (location.hostname === 'cses.fi' && location.pathname.includes('/problemset/list')) {{
        const solved = [];
        const attempted = [];
        document.querySelectorAll('.task').forEach(task => {{
            const a = task.querySelector('a');
            if (!a) return;
            const href = a.getAttribute('href') || '';
            const id = href.split('/').pop();
            if (!id) return;
            const score = task.querySelector('.task-score');
            if (!score) return;
            const cls = score.className || '';
            if (cls.includes('full')) solved.push(id);
            else if (cls.includes('zero')) attempted.push(id);
        }});
        if (solved.length > 0 || attempted.length > 0) {{
            post('/capture/cses-progress', {{ solved, attempted }}).catch(() => {{}});
        }}
        return;
    }}

    // --- Problem page: capture problem + samples ---
    const url = location.href;
    let platform, id, name;

    if (location.hostname === 'codeforces.com') {{
        platform = 'codeforces';
        const m = url.match(/problem(?:set\/problem)?\/(\d+)\/([A-Za-z0-9]+)/);
        if (!m) return;
        id = m[1] + m[2];
        const title = document.querySelector('.title');
        name = title ? title.textContent.replace(/^[A-Z]\d*\.\s*/, '').trim() : id;
    }} else if (location.hostname === 'cses.fi') {{
        platform = 'cses';
        const m = url.match(/task\/(\d+)/);
        if (!m) return;
        id = m[1];
        const h1 = document.querySelector('.title-block h1, h1');
        name = h1 ? h1.textContent.trim() : id;
    }} else {{
        return;
    }}

    // Extract samples from the live DOM.
    const tests = [];

    if (platform === 'codeforces') {{
        const inputs = document.querySelectorAll('.sample-test .input pre');
        const outputs = document.querySelectorAll('.sample-test .output pre');
        for (let i = 0; i < Math.min(inputs.length, outputs.length); i++) {{
            tests.push({{
                input: preText(inputs[i]),
                expected_output: preText(outputs[i])
            }});
        }}
    }} else if (platform === 'cses') {{
        const pres = Array.from(document.querySelectorAll('.content pre, .md pre'))
            .map(el => preText(el))
            .filter(s => s.trim().length > 0);
        for (let i = 0; i + 1 < pres.length; i += 2) {{
            tests.push({{
                input: pres[i],
                expected_output: pres[i + 1]
            }});
        }}
    }}

    // Robust <pre> text extraction that preserves line breaks.
    function preText(el) {{
        let out = '';
        for (const node of el.childNodes) {{
            if (node.nodeType === Node.TEXT_NODE) {{
                out += node.textContent;
            }} else if (node.nodeName === 'BR') {{
                out += '\n';
            }} else {{
                out += node.textContent;
                if (['DIV','P','LI'].includes(node.nodeName)) out += '\n';
            }}
        }}
        return out.replace(/^\n+|\n+$/g, '');
    }}

    const payload = {{ platform, id, name, url, tests }};
    post('/capture/problem', payload).then(({{ endpoint }}) => {{
        showToast(`CPOS: captured ${{tests.length}} sample(s) in ${{endpoint.name}}`);
    }}).catch(() => {{
        showToast('CPOS not running — start cpos or open VS Code with the CPOS extension');
    }});

    function showToast(msg) {{
        const d = document.createElement('div');
        d.textContent = msg;
        Object.assign(d.style, {{
            position: 'fixed', bottom: '20px', right: '20px', padding: '10px 18px',
            background: '#1a1a2e', color: '#e0e0e0', borderRadius: '8px', zIndex: 99999,
            fontSize: '14px', fontFamily: 'system-ui', boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            border: '1px solid #7c3aed'
        }});
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 3000);
    }}
}})();
"#
    )
}

fn generate_bookmarklet(port: u16) -> String {
    // Minimal bookmarklet that extracts samples from CF/CSES and POSTs to CPOS.
    format!(
        r#"javascript:void(function(){{var h=location.hostname,u=location.href,p,id,n,ts=[];function pt(e){{var o='';e.childNodes.forEach(function(n){{n.nodeType===3?o+=n.textContent:n.nodeName==='BR'?o+='\n':o+=n.textContent}});return o.replace(/^\n+|\n+$/g,'')}}if(h==='codeforces.com'){{p='codeforces';var m=u.match(/problem(?:set\/problem)?\/(\d+)\/([A-Za-z0-9]+)/);if(!m)return alert('Not a CF problem page');id=m[1]+m[2];n=(document.querySelector('.title')||{{}}).textContent||id;document.querySelectorAll('.sample-test .input pre').forEach(function(e,i){{var o=document.querySelectorAll('.sample-test .output pre')[i];if(o)ts.push({{input:pt(e),expected_output:pt(o)}})}})}}else if(h==='cses.fi'){{p='cses';var m=u.match(/task\/(\d+)/);if(!m)return alert('Not a CSES task page');id=m[1];n=(document.querySelector('h1')||{{}}).textContent||id;var pp=document.querySelectorAll('pre');for(var i=0;i+1<pp.length;i+=2)ts.push({{input:pt(pp[i]),expected_output:pt(pp[i+1])}})}}else return alert('Open a Codeforces or CSES problem first');fetch('http://127.0.0.1:{port}/capture/problem',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{platform:p,id:id,name:n,url:u,tests:ts}})}}).then(function(r){{return r.json()}}).then(function(d){{alert(d.ok?'CPOS: captured '+ts.length+' sample(s)':'CPOS: error')}}).catch(function(){{alert('CPOS not running — start cpos first')}})}}())"#
    )
}

fn generate_setup_html(port: u16, ext_dir: &std::path::Path, bookmarklet: &str) -> String {
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>CPOS Browser Companion Setup</title>
  <style>
    body {{ font-family: system-ui, sans-serif; max-width: 720px; margin: 60px auto;
           color: #e0e0e0; background: #0d0d14; padding: 0 24px; line-height: 1.6; }}
    h1 {{ color: #7c3aed; }}
    h2 {{ color: #a78bfa; margin-top: 2em; }}
    code {{ background: #1e1e2e; padding: 2px 6px; border-radius: 4px; font-size: 0.95em; }}
    .path {{ background: #1e1e2e; padding: 8px 14px; border-radius: 6px;
             border: 1px solid #333; word-break: break-all; display: block; margin: 8px 0; }}
    ol li {{ margin-bottom: 8px; }}
    .bookmarklet {{ display: inline-block; padding: 8px 16px; background: #7c3aed; color: #fff;
                    border-radius: 6px; text-decoration: none; font-weight: bold; margin: 8px 0; }}
    .section {{ background: #12121a; border: 1px solid #222; border-radius: 8px;
                padding: 16px 20px; margin: 16px 0; }}
    .status {{ padding: 8px 14px; border-radius: 6px; margin: 12px 0; font-weight: bold; }}
    .ok {{ background: #064e3b; color: #6ee7b7; }}
    .err {{ background: #7f1d1d; color: #fca5a5; }}
  </style>
</head>
<body>
  <h1>CPOS Browser Companion</h1>
  <p>This page helps you connect your browser to CPOS so that opening a problem page
     automatically sends the samples to your terminal or the CPOS VS Code extension.</p>

  <div id="statusBox" class="status err">Checking CPOS connection...</div>
  <script>
    fetch('http://127.0.0.1:{port}/health')
      .then(r => r.json())
      .then(() => {{
        const b = document.getElementById('statusBox');
        b.className = 'status ok';
        b.textContent = 'CPOS is running on port {port} ✓';
      }})
      .catch(() => {{
        const b = document.getElementById('statusBox');
        b.className = 'status err';
        b.textContent = 'CPOS is not running — start it with: cpos';
      }});
  </script>

  <h2>Install the browser companion</h2>
  <div class="section">
    <p>Install <strong>CPOS Companion</strong> from the
       <a href="https://chromewebstore.google.com/detail/gjnbapmjonegeeamdeahcoojgokeogmm" target="_blank" rel="noopener">Chrome Web Store</a>
       (works in Chrome, Edge, and Brave).</p>
    <p>Pair it with the
       <a href="https://marketplace.visualstudio.com/items?itemName=sohamaggarwal.cpos-vscode" target="_blank" rel="noopener">CPOS VS Code extension</a>
       from the Marketplace, or run the CPOS terminal app (<code>cpos</code>).</p>
    <p>Done! The extension auto-captures every Codeforces/CSES problem you open.
       It also syncs your CSES solved status when you visit the problemset list page.</p>
  </div>

  <h2>Contributors: local extension build</h2>
  <div class="section">
    <p>Only needed if you are developing the extension from source:</p>
    <ol>
      <li>Open <code>chrome://extensions</code> (or <code>edge://extensions</code> / <code>brave://extensions</code>)</li>
      <li>Enable <strong>Developer mode</strong> (toggle in the top-right)</li>
      <li>Click <strong>Load unpacked</strong></li>
      <li>Select this folder:</li>
    </ol>
    <code class="path">{ext_path}</code>
  </div>

  <h2>Bookmarklet (Safari / Firefox / any browser)</h2>
  <div class="section">
    <p>Drag this link to your bookmarks bar, then click it on any CF/CSES problem page:</p>
    <a class="bookmarklet" href="{bookmarklet_escaped}">CPOS Capture</a>
    <p style="color:#888;font-size:0.9em;">Or copy this and paste as the URL of a new bookmark:</p>
    <code class="path" style="font-size:0.85em;">{bookmarklet_escaped}</code>
  </div>

  <h2>How it works</h2>
  <p>When you visit a Codeforces or CSES problem page, the companion reads the sample
     test cases from the page DOM and sends them to the CPOS VS Code extension
     (<code>localhost:27122</code>) if it is running, otherwise CPOS TUI
     (<code>localhost:{port}</code>). CPOS creates your solution file, caches the samples, and opens it in your editor.
     Just press <code>T</code> to test.</p>
</body>
</html>"#,
        ext_path = ext_dir.display(),
        bookmarklet_escaped = bookmarklet.replace('"', "&quot;"),
    )
}

fn handle_config_input(app: &mut App, key: KeyCode) {
    match key {
        KeyCode::Char('j') | KeyCode::Down => {
            let max = app.config_fields().len().saturating_sub(1);
            app.config_selected = (app.config_selected + 1).min(max);
        }
        KeyCode::Char('k') | KeyCode::Up => {
            app.config_selected = app.config_selected.saturating_sub(1);
        }
        KeyCode::Enter | KeyCode::Right => {
            if app.config_field_is_cycle() {
                app.cycle_config();
            } else {
                app.start_config_edit();
            }
        }
        KeyCode::Char('S') => app.begin_setup(),
        // Open CSES login so you can grab your session cookie to connect.
        KeyCode::Char('L') => {
            open_url("https://cses.fi/login");
            app.status_message =
                "Log in, then paste your PHPSESSID cookie into 'CSES Session'".to_string();
        }
        _ => {}
    }
}
