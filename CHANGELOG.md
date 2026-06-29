# Changelog

All notable changes to CPOS are documented here. Components are versioned independently:

| Component | Current version | Version file |
| --- | --- | --- |
| Terminal app | 0.2.2 | `Cargo.toml` |
| VS Code extension | 0.5.2 | `extensions/vscode/package.json` |
| Browser companion (Chrome) | 0.15.3 | `extensions/chrome/manifest.json` |
| Browser companion (Firefox) | 0.15.3 | `extensions/firefox/manifest.json` |

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## Unreleased

## Browser companions 0.15.3 — 2026-06-29

### Added
- **Challenge alerts you can't miss.** An in-page card now appears when a friend challenges you — accept or decline it in place — and when your own challenge is accepted, complementing the system notification. The on-problem challenge icon shows a live "race in progress" state, including races you have accepted rather than created.
- **In-browser editor run controls.** Run now toggles to Stop for cancellable sample runs, with keyboard shortcuts to run (`Ctrl`/`Cmd`+`Enter`) and submit (`Ctrl`/`Cmd`+`Shift`+`Enter`), a one-click copyable result summary, and jump-to-first-failure.

### Changed
- **Redesigned run results.** The in-browser editor's results console is now a dismissible panel — collapse it, close it, or drag to resize — with an animated pass-ratio meter, per-test cards that fold accepted tests and expand failures, a single banner for compilation errors, and considered loading and empty states.
- **Extension-wide visual refresh.** A unified design system gives every surface consistent corner radii, theme-aware elevation, and a disciplined accent, including a real default accent that is no longer indistinguishable from the muted text colour. Status and rating chips are tinted by meaning and Codeforces tier, pen and marker colours derive from the active theme, controls share one crisp SVG icon family, and upcoming-contest countdowns tick live with proximity-based urgency colours.

### Fixed
- **The editor's run-results panel could not be dismissed.** After running samples the results stayed pinned to the screen with no way to close or minimise them; the panel is now fully dismissible and the layered `Esc` key backs out one step at a time.
- **Challenge events surfaced nothing on the page.** Incoming and accepted challenges previously produced only an easily-missed system notification and never an in-page prompt; both now appear on the page — and on the next page load if no Codeforces tab was open when the event arrived — deduplicated across open tabs. A late acceptance arriving just after the short invite window is no longer dropped.
- **Hardened challenge link handling.** Problem URLs carried inside relay-delivered invites are now validated against Codeforces, so a crafted invite cannot inject a non-Codeforces link.

## CPOS 0.2.2 / VS Code 0.5.2 / Browser companions 0.15.2 — 2026-06-26

### Added
- **AtCoder capture and submit support.** Browser capture, local sample export, and submit autofill now include AtCoder workflows alongside Codeforces and CSES.
- **Problem tag filtering.** The TUI Problems tab now supports custom comma-separated tag filters with AND/OR matching.
- **Pen and marker tools.** Chrome and Firefox companions add a unified floating launcher for freehand drawing and text highlighting on supported problem pages.

### Fixed
- **Valid Java solution names.** New Java captures now use a `Q`-prefixed identifier such as `Q1120C.java` or `QWeirdAlgorithm.java`, and the built-in template creates the matching public class. Sample runs use that generated class name, while submissions transparently rename it to `Main` in the queued copy for judge compatibility without modifying the workspace file.
- **Browser companion resilience.** Optional background module imports are non-fatal, and the problem timer defaults away from the new drawing launcher.

## Terminal app 0.2.1 — 2026-06-21

### Changed
- **Target rating is now explicit.** The Target tab separates the official synced Codeforces rating from its solve-derived Practice estimate. Practice still tunes the problem ramp, but only the official rating determines the goal gap or whether a goal is reached.
- Users without rated Codeforces history now start with a 1200 target instead of silently inheriting a fabricated 1200 current rating and a 1400 target.
- **Complete problem statements in the TUI.** `v` now opens a semantic Codeforces/CSES statement view with title and limits, sections, lists, code blocks, native terminal LaTeX rendering, captured diagrams, and responsive sample input/output panels. Codeforces multi-test block grouping is preserved, and `T` runs samples without leaving the statement.
- Statement diagrams use detected Kitty, Sixel, or iTerm2 graphics and fall back to Unicode half-block rendering on other terminals.
- Statement images are cached locally after their first download, while captured statement HTML remains available offline.

### Fixed
- **TUI redraw corruption after opening problems.** Browser and desktop launchers no longer inherit the alternate screen's input/output streams, and CPOS performs a clean redraw after launches or terminal resizes so stale tab rows and borders cannot remain duplicated.
- **Legacy Codeforces math delimiters.** Polygon statements using `$$$...$$$` inline math or `$$$$$$...$$$$$$` display math now render correctly, including aliases such as `\le` and superscripts such as `10^4`, instead of exposing dollar signs or parser errors.

## VS Code extension 0.5.1 — 2026-06-21

### Added
- **Discord shortcut in the panel header.** The new button opens the CPOS Discord invite directly from VS Code.

### Changed
- **Responsive community links.** The header now orders its actions as Sponsor, Theme, Discord, and GitHub. As the sidebar narrows, labels collapse by priority while every icon remains available; GitHub collapses first, followed by Discord, Theme, and Sponsor.

## Browser companions 0.15.1 — 2026-06-20

### Fixed
- The on-page Compete sword icon now keeps its intended size, colors, and SVG stroke when Modernize or a site theme applies global button styles.

## CPOS 0.2.0 / VS Code 0.5.0 / Browser companions 0.15.0 — 2026-06-20

Browser companion **0.15.0**, VS Code **0.5.0**, terminal **0.2.0**.

### Added
- **Compete — Codeforces races refereed from public submissions.** Challenge a friend by handle or publish an open race, choose a specific problem or rating, set a time limit, and let CPOS determine the winner from the first Accepted submission after the race starts.
- **Public matching.** Discover open races inside a chosen problem-rating range and accept them explicitly from the browser popup or VS Code.
- **Shared Compete state.** The browser companion handles delivery and Codeforces polling while VS Code mirrors identity, races, results, matching preferences, and discovered public races over localhost.

### Changed
- **Compete redesigned across the browser and VS Code.** Identity, friend/open race creation, public matching, incoming invites, active races, and history now follow the same workflow in both clients.
- **Browser popup reorganized.** A focused Settings / Compete navigation replaces the long wall of nested cards. Practice, upcoming contests, feature toggles, appearance, advanced tools, and templates share one organized settings surface.
- **Reliable browser ↔ VS Code sync.** Races, manual Codeforces handles, public matching preferences, rating ranges, and discovered open races sync automatically. Timestamped preferences prevent stale overwrites, and removed races no longer reappear after a merge.
- **VS Code settings reorganized.** Challenge controls moved into Compete. Settings now has a dedicated **Shown tabs** section plus a clearer shared-template editor.
- **VS Code navigation is adaptive.** Users choose which optional tabs are shown. Labels collapse to icons only when needed, with Tests retaining its label longest; Sponsor and Theme use the same space-aware behavior.
- **TUI header:** a pixel-`C` tile matching the CPOS icon and the full product name now share one compact line, freeing another row for content.

### Fixed
- Public matching results created in the browser now appear automatically in VS Code and can be accepted there.
- Editing Compete state while the VS Code panel is open now refreshes the Compete view instead of only patching the Tests view.
- Removed races use tombstones during synchronization, preventing deleted entries from reappearing after another client merges state.

### Privacy
- Compete delivery uses public [ntfy.sh](https://ntfy.sh) topics derived from Codeforces handles. Messages contain race metadata and accept/decline replies—not passwords, cookies, or source code. See the updated [privacy policy](extensions/chrome/PRIVACY.md).

## Browser companions (Chrome + Firefox) — 0.10.7 - 2026-06-19

### Fixed
- **Rating predictions restored.** Codeforces now rejects `contest.standings` API calls that carry extra query parameters for non-admins, which silently broke the predicted-Δ column on contest standings (no column appeared). CPOS now requests standings with no extra parameters and filters official contestants locally, so live predictions show up again. Finished, rated contests continue to display exact official deltas.

### Changed
- **Prediction engine is now a faithful port of Carrot's algorithm** — ranks are reassigned from points/penalty using Codeforces' tie convention, the seed excludes the contestant being evaluated, and the seed curve is precomputed for speed. Verified to reproduce official rating changes exactly on contests without debutants.
- CF API calls are issued anonymously with retries on the call-rate limit, and each contest's field ratings are cached, so a transient API failure no longer skews predictions.

---

## Browser companions (Chrome + Firefox) — 0.10.6 - 2026-06-19

### Added
- **Configurable daily rating.** Choose Auto or an exact Codeforces rating for the daily problem from the popup.
- **Shared templates.** Paste or upload per-language starter templates and sync them with the VS Code extension or terminal app over localhost. Offline edits are queued and synced when CPOS reconnects.

### Changed
- The in-browser editor now uses shared templates for new drafts and Reset, while retaining built-in starters as a fallback.
- Existing VS Code `cpos.templateFile` and terminal `template_file` templates are imported through the local config API.

### Fixed
- **Profile analytics placement.** Analytics no longer fall far down the Codeforces profile page when Modernize is disabled.

---

## VS Code extension — 0.3.32 - 2026-06-19

### Added
- **Shared template configuration.** A settings gear in the CPOS panel opens a Config tab where users can select a language, paste or upload a template, reset it, and save it for VS Code, the terminal app, and browser companion.
- **Local config API.** The VS Code runner now exposes shared template configuration over localhost for the Chrome and Firefox browser editors.

### Changed
- Existing `cpos.templateFile` and terminal `template_file` configurations are loaded into the new template editor automatically. Saving migrates the template to CPOS's shared per-language template directory.

---

## Browser companions (Chrome + Firefox) — 0.10.5 - 2026-06-18

### Changed
- **Firefox feature parity.** Firefox now ships the same current feature implementation and bundled CodeMirror editor as Chrome, while retaining its Gecko-specific background integration.
- **Retired practice ladders removed from Firefox.** The standalone ladder page and popup entry are gone, matching Chrome.
- **Profile comparison chart.** Rating histories now connect actual contest observations directly, use readable axis ticks, and stop at each handle's last rated contest instead of drawing artificial plateaus.

### Fixed
- **Submission activity heatmap.** Narrow profile layouts now open at the newest weeks by default while remaining horizontally scrollable for older activity.
- **Theme details.** Tightened native Codeforces menu, utility-control, sample-copy, and favorite-button styling.

---

## Browser companion (Chrome) — 0.10.2 - 2026-06-17

### Added
- **Problem focus mode.** Codeforces problem pages now have an always-available focus toggle that hides the right rail and expands the statement, tuned for split-screen solving. It is independent from the optional Problem tools feature.

### Changed
- **Quieter Problem tools styling.** The fallback sidebar card and controls now use neutral, low-contrast styling instead of loud accent fills.
- **Problem tools placement.** When Codeforces lacks the native Problem tags widget, CPOS places its fallback card above Contest materials instead of at the top of the sidebar.
- **Chrome privacy and store docs updated.** The privacy policy now accurately describes local-only storage for settings, editor drafts, timers, favorites, reminders, marker notes/highlights, focus preferences, and public-data caches.

### Fixed
- Focus mode now avoids double scrollbars and keeps left/right problem gutters balanced in split-screen browser windows.

---

## Browser companion (Chrome) — 0.10.1 - 2026-06-17

### Fixed
- **Codeforces theming polish.** Fixed dark-theme regressions across navbars, side widgets, cookies/notifications, problem tables, and profile analytics.
- **Profile analytics layout.** Reworked analytics into a denser grid with filled chart bars and better use of vertical space.
- **Problem pages.** Fixed disappearing/down-shifted problem content, MathJax color in dark themes, sample-copy overlap, and tag-widget rendering.
- **Rating compare.** Fixed rating-history overlay time ordering so each handle is plotted against contest dates correctly.
- **In-browser editor.** Switched the editor surface to the bundled CodeMirror build for proper caret alignment, syntax colors, completion basics, and IDE-like editing behavior.
- **Release packaging.** Built and attached the `0.10.1` Chrome upload zip to the GitHub release.

---

## Browser companion (Chrome) — 0.10.0 - 2026-06-16

A polish and unification pass, plus a refreshed brand.

### Changed
- **One theme palette everywhere.** A single palette now drives the popup, the recolored site, and every CPOS tool, so the whole companion stays visually consistent.
- **New app icon** — a pixelated "C" mark, shared across the Chrome and Firefox companions, the VS Code extension, and the website.
- Polish across the popup, profile analytics, profile compare, the in-browser editor, problemset/standings tools, and Modernize.
- Refreshed Chrome Web Store screenshots and the website companion gallery from real product captures.

### Fixed
- **In-browser editor caret alignment.** The line box is now rounded to a whole pixel and the highlight overlay matches the textarea's `tab-size`, so the caret no longer drifts from the rendered text.
- **Run feedback.** When a CPOS runner is reachable but too old to serve `/run`, the editor now says so (and points to updating) instead of "couldn't reach the runner". (Running needs the VS Code extension 0.3.31+ or the terminal app.)
- **Light theme in the popup.** `color-scheme` now follows the chosen palette, so the light theme no longer renders with dark scrollbars/controls; selecting a theme (including Default) recolors the popup live without a reopen.

### Removed
- **Practice ladders.** The standalone rating-bucketed ladders page was retired; daily problem & streak, favorites, and problemset solve-status cover day-to-day practice.

---

## Browser companion (Chrome) — 0.9.0 - 2026-06-14

The companion grows from an in-page CP environment into a full practice toolkit. All features are individually toggleable from the popup; everything stays read-only (public CF API + localhost).

### Added
- **Profile compare (VS).** Add other handles on a CF profile and compare stats side-by-side, with a rating-history overlay chart.
- **Contest reminders.** Desktop notifications before upcoming Codeforces contests, with a configurable lead time (uses the public `contest.list` API; requires the `notifications` permission).
- **Daily problem & streak.** A rating-tuned "problem of the day" (deterministic per day) plus a practice streak.
- **Favorites.** Bookmark problems with a star and view them in the popup.
- **Problem timer.** A draggable per-problem stopwatch that persists and auto-resumes.
- **Practice ladders.** A standalone page with rating-bucketed CF problem sets and solved-progress tracking.
- **Problem tools.** Problem rating badge, tag-hider / training mode (reveal all or one-by-one), one-click copy of sample input, and similar-problem links.
- **Problemset tools.** Solve-status row coloring, a hide-solved toggle, and per-problem submission counts.
- **Standings tools.** Colorize standings rows by programming language (with a legend) and a friends-only filter.
- **Marker & notes.** Highlight statement text in marker colors and attach notes, saved per problem (off by default).

### Changed
- **In-browser editor expanded** to a LeetCode-style workflow: run against the sample tests with a per-test diff and custom stdin, current-line highlight, bracket matching/auto-close, auto-indent, find & replace, font-size and line-wrap controls, a maximize/zen layout, and multiple editor color schemes. Submit still reuses the existing companion flow.

---

## Browser companion (Chrome) — 0.8.0 - 2026-06-14

### Added
- **Profile analytics revamp.** Replaces the earlier in-page analytics with charts CF doesn't show: a submission **activity heatmap**, **current & longest streak**, **solved-by-rating** and **solved-by-index** histograms, **top tags**, **verdict** and **language** donuts, and rating-history-derived insights (no duplicate of CF's own rating graph).
- **In-browser editor.** A slide-in editor on problem pages with sample-test runs, per-problem persistence, language selection, and starter templates; submitting reuses the existing background submit injector.
- **Code & LaTeX styling.** Dependency-free syntax highlighting for code in statements, editorials, and comments, with dark-theme-friendly math.
- **Rating predictions.** Predicted rating deltas on contest standings using the official CF formula.
- **Site themes + Modernize.** Recolor Codeforces/CSES with CPOS palettes and a sleek, flat, gradient-free modern restyle; the two compose.
- **Popup hub.** A flat, themeable control panel with live CPOS connection status and an on/off switch for every feature.

---

## Browser companion (Chrome) — 0.7.1 - 2026-06-14

### Added
- **Modernize** — a new toggle that gives Codeforces and CSES a sleek, modern look: a system UI font, roomier spacing, rounded card-style boxes (the old corner-image artifacts are neutralised), cleaner tables/buttons/inputs, and nicer code blocks. Purely typographic/structural and gradient-free, so it composes with the optional colour theme.

### Changed
- **Profile analytics reworked.** Stop duplicating Codeforces' own rating graph; instead show charts CF doesn't: a **submission activity heatmap** (26 weeks), **solved-by-rating** and **solved-by-index** histograms, **verdict** and **language** donut charts, top tags, and an overview with acceptance rate + rank progress.

---

## VS Code extension — 0.3.31 - 2026-06-16

### Added
- **Local `/run` endpoint** on the capture server, for the browser companion's in-page editor "Run". It compiles the supplied code and runs it against caller-supplied sample tests using the same compile/run pipeline as Run Samples, returning per-test verdicts. Self-contained (writes only to the build dir) — capture, submit, and sample-fetch behavior are unchanged.

### Changed
- **New app icon** — the shared pixelated "C" brand mark, matching the browser companions and the website.

---

## Browser companion (Chrome) — 0.7.0 - 2026-06-14

The companion gains a real interface and turns into a full in-browser CP environment. All additive — the existing problem capture and submit flow is unchanged.

### Added
- **Popup hub.** Clicking the toolbar icon now opens a flat, themeable control panel (no gradients; matches the VS Code panel / TUI) with live CPOS connection status and on/off switches for every feature below. Five built-in themes; the extension UI and injected site themes share one palette.
- **Profile analytics (in-page).** On `codeforces.com/profile/<handle>`, CPOS injects an analytics panel directly into the page — rating history chart, solved-by-rating, top tags, verdict breakdown, and languages — computed from the public CF API.
- **Rating predictions ("Carrot"-style).** On contest standings, a predicted-Δ column is added per row using the official Codeforces rating formula (and exact deltas once a contest is rated).
- **Site theming.** Restyle Codeforces and CSES with any CPOS palette, toggled from the popup.
- **Code & LaTeX styling.** Dependency-free syntax highlighting for code blocks in statements and editorials, with dark-theme-friendly math.
- **In-browser editor.** A slide-in editor panel on problem pages — line-numbered, with a live syntax-highlight overlay, per-problem persistence, language selection, and starter templates. Submitting reuses the existing background submit injector (no changes to submit logic): Codeforces auto-fills and submits; CSES copies and opens the submit page. On by default. (A Monaco drop-in is wired behind a one-time `npm`-vendoring step — see `extensions/chrome/README.md`.)

### Shared internals
- `cpos-config.js` (single source of truth for feature flags + theme selection, sensible defaults) and `cpos-highlight.js` (shared self-contained highlighter used by both the page highlighter and the editor overlay). Profile analytics now render with explicit loading / empty / error states and a rank-progress bar; site theming was rewritten to be comprehensive and layout-preserving (Codeforces rating-tier handle colours are kept).

---

## Terminal app — 0.1.8 - 2026-06-14

### Fixed
- **Starting a problem no longer glitches the TUI when opening terminal editors.** CPOS now temporarily leaves the alternate-screen/raw-mode UI before launching interactive editors such as `vim`, `nvim`, `nano`, `micro`, Helix, Kakoune, or terminal Emacs, then restores the app afterward.
- **Custom editor commands handle paths safely.** `{file}` replacements and appended file paths are shell-quoted, and editor detection now handles quoted command names instead of splitting only on whitespace.

---

## VS Code extension — 0.3.30 - 2026-06-14

### Changed
- **Submit now waits for the browser companion before opening a fallback page.** The extension queues the submission and watches for the companion to consume it; if that does not happen quickly, CPOS shows an **Open submit page** action instead of immediately opening an extra browser tab.

---

## Terminal app — 0.1.7 - 2026-06-09

### Added
- **Goal-based Target tab.** Set a rating goal — cycle Codeforces rank milestones with `[` / `]` or type an exact rating with `t` — and CPOS shows where you stand (effective level, gap to goal, overall readiness %, and problems solved in the goal band). The **Topics to Cover** table labels each prerequisite topic **Ready / Developing / Gap / Untouched**, weakest-first, and a **step-by-step plan** ramps unsolved problems from your level up to the goal (labelled **Base → Build → Push → Target**, weak/uncovered topics front-loaded). Press `enter`/`o` on a step to start it in the normal Problems solve flow. (Thanks @ThatDeparted2061, #11.)

### Changed
- **Recommend is now coverage-aware.** Core prerequisite topics you've never solved are surfaced as coverage gaps ("New topic to cover") instead of being scored as mastered, and topics only ever cleared well below your target band get a small nudge. History-gated, so cold-start output is unchanged.

### Fixed
- Capture-server tests now bind an OS-assigned ephemeral port instead of a hardcoded one, so they no longer collide with a running CPOS instance or with each other.

---

## VS Code extension - 0.3.27 - 2026-06-07

### Fixed
- **Windows Run All stale-buffer fix** - before compiling samples on Windows, CPOS now saves the matching dirty solution document. This prevents Run All from compiling an older saved starter file while the editor contains newer code, which surfaced as every sample showing "no output" even when the current buffer had output or compilation errors. macOS/Linux behavior is unchanged.

---

## Terminal app — 0.1.6 - 2026-06-07

### Fixed
- **Windows: the whole TUI rendered as garbled / Cyrillic ("Russian") text.** The console started in a legacy code page, so the UI's box-drawing characters and symbols (`→ ✓ • … ▸`) — which are UTF-8 — were decoded as mojibake. CPOS now switches the Windows console to UTF-8 (`SetConsoleOutputCP`/`SetConsoleCP` to code page 65001) on startup. macOS/Linux are unaffected (already UTF-8).
- **Windows: pasting a template in setup only captured the first line and could skip the CSES step.** Windows terminals (notably conhost) often don't deliver bracketed-paste events, so a multi-line paste arrived as raw keystrokes — the embedded newline acted as Enter (jumping past the CSES step) and a stray `o` triggered "open CSES login." The setup wizard no longer relies on bracketed paste.

### Added
- **Setup: paste a template with `v` (or Ctrl+V).** The Template step now reads the full clipboard on a keypress via the platform clipboard tool (`Get-Clipboard` on Windows, `pbpaste` on macOS, `xclip`/`xsel` on Linux), so multi-line templates come in intact on every platform.
- **Setup: load a template from a file.** The Template step has a **Paste ⇄ Upload** toggle (`Tab`); in Upload mode you type or paste a file path and press Enter to load it, with a live preview.

> macOS behavior is preserved — the existing `⌘V` bracketed-paste path still works, and the UTF-8 console fix is Windows-only.

---

## Terminal app — 0.1.5 - 2026-06-07

### Fixed
- **Windows: `cpos update` failed for Scoop installs** with `failed to run scoop: program not found`. On Windows `scoop` is a `.cmd`/`.ps1` shim, which `CreateProcess` can't launch directly (it only resolves `.exe`). The updater now runs Scoop through `cmd /C` so the shim resolves via `PATHEXT`, and refreshes buckets (`scoop update`) before upgrading `cpos`.

---

## Terminal app — 0.1.4 - 2026-06-07

### Fixed
- **Windows: opening a problem now works.** Pressing **`o`** (or Enter) in the TUI was a no-op on Windows — the statement never opened in the browser, so the CPOS browser companion never captured the samples (surfacing as "couldn't fetch cases"). The OS-integration layer was hardcoded to the macOS `open` command, which doesn't exist on Windows. Opening a URL/file now uses `cmd /C start` on Windows (`open` on macOS, `xdg-open` on Linux).
- **Windows: the solution file now opens in your editor with your template.** Editor auto-detection ran `command -v` through `sh`, which fails to find VS Code's `code.cmd` shim on Windows, so the templated file was created but never opened. Detection now uses `where` on Windows, and `code`/`cursor` are launched via `cmd /C` (custom editor commands run through `cmd /C` instead of `sh -c`).
- **Windows: "open in browser" (`b`) and the CSES login shortcut (`o`) in setup** now open correctly for the same reason.
- **Clipboard on submit** now uses the platform-native tool (`clip` on Windows, `pbcopy` on macOS, `xclip` on Linux) instead of always shelling out to the macOS-only `pbcopy`.

> macOS behavior is unchanged — every integration point branches by OS and keeps the exact commands it used before.

---

## VS Code extension — 0.3.29 - 2026-06-14

### Fixed
- **Submit no longer opens the browser (regression)** — `Submit` had stopped opening the judge's submit page: a prior refactor dropped the `openExternal` call, so the extension only copied the code to the clipboard and showed "opening submit page in Chrome…" while nothing actually opened. CPOS now opens the submit URL in your default browser again (and still copies the solution to the clipboard for the companion to paste), restoring the original one-click submit flow.

### Changed
- **Tests sidebar UI polish.** Thin themed scrollbars across the panel; collapsible test cards (with the collapsed/expanded state persisted per test); the problem ID is now a clickable link that opens the problem in your browser; the **Submit** button is restyled as a distinct primary action (the redundant standalone "Problem" and "Search" buttons were removed); and the sample **Input/Expected** panes use fixed, viewport-aware heights with internal scrolling so long samples no longer stretch the whole sidebar.

> Also ships the **0.3.28** Tests-tab scroll fix (the default Tests view is wrapped in a `.tests-wrapper` scroll container so the sidebar stays scrollable once the test list exceeds the viewport), which was tagged in the repo but never published. (Thanks @ThatDeparted2061.)

---

## VS Code extension — 0.3.28 - 2026-06-13

### Fixed
- **Unscrollable sidebar (Tests tab)** — the Statement/Solution tabs introduced a fixed-height, `overflow: hidden` `#app` flex layout with internal scroll wrappers, but the default **Tests** tab had no scroll region of its own, so its content was clipped and the sidebar could not be scrolled once the test list exceeded the viewport. The Tests body is now wrapped in a `.tests-wrapper` scroll container that mirrors the Statement/Solution wrappers, keeping the header and tab bar pinned while the test list scrolls. (Thanks @ThatDeparted2061.)

---

## VS Code extension — 0.3.26 - 2026-06-06

### Added
- **Solution tab** — a new third tab in the panel surfaces video solutions and editorial links for the open problem. Videos are shown as clickable thumbnails (YouTube watch page opens in the system browser). The accordion also provides one-click links to YouTube search, Google, and the Codeforces problem/editorial pages.
- **Anti-cheat gate** — the Solution tab is automatically hidden while a Codeforces contest is still running. The extension fetches CF's `contest.list` API on activation (and refreshes at most once per minute) and suppresses the tab for any problem whose contest phase is not `FINISHED`. Applies only to Codeforces contest problems; CSES and finished contests are unaffected.
- **Sample tests in Statement view** — for Codeforces problems (where the browser companion strips `.sample-tests` during capture) the sample I/O is re-injected into the statement view so it reads like the original problem page. Alternating row striping makes multi-block test cases easy to scan.
- **Windows C++ compilation fix** — the compile command now appends `.exe` to the `-o` output flag and the run path uses the full absolute path, so compiled binaries are found correctly on Windows regardless of PATH lookup behaviour.

### Fixed
- **Blank panel regression** — single-backslash `\n` literals inside the webview template literal were being cooked into raw newlines by the outer template literal at runtime, causing an unterminated-string syntax error that silently killed the entire webview script and left all tabs blank.
- **CF regex in webview** — the Codeforces contest-number regex inside the webview script was also mangled by the outer template literal (`\d` → `d`), breaking the "CF Problem page / Editorial" links. Both are now correctly double-escaped.

### Changed
- YouTube embeds removed from the Solution tab. YouTube's IFrame player rejects the `vscode-webview://` origin (Error 153 on every video regardless of per-video embedding settings); replaced with thumbnail cards that open the real watch page in the system browser.
- Statement tab sample blocks no longer have hover highlight animation; the static odd/even row striping is kept. Tests tab IO hover is unchanged.

---

## VS Code extension — 0.3.25 - 2026-06-06

### Added
- **Sponsor button** in the panel header — links to GitHub Sponsors to help keep CPOS free and local-first.

### Changed
- The header **GitHub** button is now icon-only to make room for the Sponsor button without crowding the toolbar.

## VS Code extension — 0.3.24 - 2026-06-06

### Added
- **Statement view** — the panel now has Tests / Statement tabs. The Statement tab renders the captured problem statement natively with MathJax, styled to read like a Codeforces page using the existing CPOS theme variables (contributed by [@Tanishq216](https://github.com/Tanishq216), #8).

### Fixed
- **Statement HTML is sanitized** before rendering and the webview CSP is tightened (script/style/font limited to the MathJax CDN) (#8).
- **Windows file paths** — sample/problem metadata filenames are normalized (lowercased on Windows) before hashing so they resolve consistently across drives (#8).
- **Single scrollbar** — `html`/`body` no longer scroll; only the statement content area scrolls, removing the clashing double scrollbar.
- Removed the redundant "standard input / standard output" rows from the rendered statement, keeping the time and memory limits.

## Browser companion (Chrome) — 0.6.14 - 2026-06-06

### Added
- **Statement capture** — captures the problem statement HTML from Codeforces (extracting original TeX from MathJax 2 `math/tex` scripts) and CSES (reverting KaTeX spans to raw TeX) and sends it to the VS Code panel (contributed by [@Tanishq216](https://github.com/Tanishq216), #8).

### Fixed
- **Submit tab explosion** — submit polling now reuses the same browser tab via tracked tab IDs and gives up after a bounded number of attempts (acking the queue) instead of spawning duplicate tabs forever (#8).

## Browser companion (Firefox) — 0.2.0 - 2026-06-14

### Added
- **Full feature parity with the Chrome companion.** The expanded practice and on-page tooling lands on Firefox: profile analytics, profile compare (VS), the in-browser editor, rating predictions, contest reminders, daily problem & streak, favorites, problem timer, practice ladders, problemset/standings tools, problem tools, marker & notes, code & LaTeX styling, and site themes + Modernize. As on Chrome, every feature is individually toggleable from the popup.
- Requests the `notifications` permission for contest reminders. Temporary source installs are removed on Firefox restart; reload the manifest to restore them.

---

## Browser companion (Firefox) — 0.1.0 - 2026-06-14

### Added
- **Initial full-feature port.** Firefox graduates from capture/submit-only to the same popup hub and feature set as the Chrome 0.8.0 companion, sharing the read-only CF API + localhost design.

---

## Browser companion (Firefox) — 0.0.2 - 2026-06-06

### Added
- **Statement capture** — ports the Codeforces/CSES statement capture to the Firefox companion so the VS Code Statement tab works on Firefox too, stripping the CSES sample I/O and KaTeX loader tags.

### Fixed
- **Submit tab explosion** — submit polling reuses the same tab via tracked tab IDs and stops after a bounded number of attempts, matching the Chrome companion.

---

## VS Code extension — 0.3.23 - 2026-06-06

### Fixed
- **Windows Run All** — stop quoting `{output}` and `{source}` paths unnecessarily; fixes `"Hello".exe` linker errors and Python `can't open file … Invalid argument` (#6).

---

## Terminal app — 0.1.3 - 2026-06-04

### Added
- Startup update check for the terminal app. If a newer TUI release is available, CPOS asks before running `cpos update`; slow/offline checks fall through and open normally.
- CSES progress sync now records newly observed solved/attempted tasks as dated CPOS activity after the first baseline sync.
- Community documentation: `CONTRIBUTING.md`, `SECURITY.md`, `ARCHITECTURE.md`
- GitHub Actions CI (`cargo test`, VS Code extension compile)
- GitHub Release workflow for prebuilt terminal app binaries on macOS, Linux, and Windows
- `install.sh`, `install.ps1`, and [INSTALL.md](INSTALL.md) for binary TUI installs and release publishing
- Generated Homebrew formula and Scoop manifest publishing from release assets
- Issue and pull request templates
- Terminal app: `plain` theme (neutral grayscale palette)
- Terminal app: `light` theme (bright canvas for light terminal / VS Code light-theme users)

### Changed
- Recommendations now use solved/attempted history to prefer stretch problems above the user's level, keep a larger scrollable pool, and avoid recommending CSES tasks already marked solved by progress sync.
- Streaks and the Analytics activity heatmap now count known CPOS activity days on the local calendar, across Codeforces plus newly observed CSES progress, instead of accepted-only UTC days.
- Opening a problem with **`o`** or Enter now prefers your **active project directory** when VS Code has synced a solution path, a recent session points outside the default `~/cpos` tree, or the shell working directory looks like a project.
- **Submit** now relies entirely on the browser companion in Chrome instead of opening the system default browser, so submissions always land in the logged-in Chrome session (matching the VS Code flow).
- `cpos update` now delegates to Homebrew/Scoop when CPOS was installed through a package manager.
- Landing page redesign with higher-resolution WebP screenshots and package-manager-first TUI install commands.
- Full demo video embedded on the [website](https://cpos.sohamaggarwal.com) and linked from README files.
- Added [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for TUI install, Run All, submit, capture, and source-build issues.

---

## VS Code extension — 0.3.22 - 2026-06-04

### Changed
- Compatibility package for the CPOS 0.1.3 / browser companion 0.6.13 release. No VS Code runtime behavior changed.

---

## Browser companion — 0.6.13 - 2026-06-04

### Fixed
- CSES submit no longer double-submits by racing the content-script fallback against the background submitter.
- CSES C++ version selection now chooses the highest visible version from the submit page instead of hardcoding C++17.

---

## Terminal app — 0.1.2

### Fixed
- `cpos update` now detects Homebrew/Scoop installs through package-manager symlinks and shims before falling back to standalone binary updates.

---

## VS Code extension — 0.3.21

### Fixed
- **Run All on macOS and Windows** — cross-platform shell for compile/run (`/bin/sh` or `cmd.exe`), enriched PATH for GUI-launched editors, Windows `.exe` run templates, and `python`/`g++` discovery on Windows

## VS Code extension — 0.3.20

### Fixed
- **Native theme Run All button** — uses VS Code button colors with white label text on light and dark editor themes
- **Extension README screenshot** — panel preview image now loads in the Extensions detail view (GitHub-hosted URL)
- **Build pipeline** — `npm run package` compiles TypeScript before packaging so panel CSS changes ship in the VSIX

## VS Code extension — 0.3.17 – 0.3.19

### Added
- **Search** header button — Google search for editorials/solutions for the linked problem
- **GitHub** header button — quick link to the CPOS repo
- Branded CPOS logo in the panel header (`icon128.png`)

### Changed
- Replaced the capture-server status line in the header with Search / GitHub / theme controls
- Styled header buttons (GitHub black, Search blue tint, theme accent)

---

## Browser companion — 0.6.12

### Fixed
- Codeforces submit language now picks the **newest matching compiler** (e.g. C++23 before C++17) by reading dropdown labels instead of relying on a stale `programTypeId` fallback

## Browser companion — 0.6.11

### Changed
- **Much faster submit:** the service worker is kept warm (keepalive + alarm revive) so a queued submission is picked up almost immediately instead of waiting for the worker to wake
- The open problem page now nudges the worker the moment a submission is queued, so submit stays responsive even after an idle period
- Submit tab opens as soon as the URL commits (no longer waits for the full page load); poll interval tightened to 150 ms

## Browser companion — 0.6.7 – 0.6.10

### Fixed
- Codeforces submit reliability: source textarea set first with Ace kept in sync, correct problem field (`submittedProblemIndex` vs `submittedProblemCode`), and robust submit-button selection
- Brings the Chrome submit tab to the foreground after filling, without blocking the submit flow

### Added
- Codeforces **output block metadata** (`output_block_sizes`) alongside input blocks for accurate input/output highlighting, with a fallback parser for `YES`/`NO`-style outputs

## Browser companion — 0.6.6

### Fixed
- **Codeforces submit:** reliable autofill by setting the source textarea first, then language and problem fields, then activating the submit control—without resetting the Ace editor
- **Language selection:** numeric program type id when available, with ranked fallback on compiler display names when Codeforces updates ids
- **Retries:** up to eight injection attempts while the submit page loads
- **Concurrency:** background worker is the sole submit handler; avoids conflicting fills from the isolated content-script world

## Browser companion — 0.6.3 – 0.6.5

### Added
- Capture of Codeforces **sub-test-case block metadata** (`test-example-line-*`) for aligned input/output highlighting in the VS Code panel

### Fixed
- Codeforces submit uses main-world injection and extended page-load timing
- CSES submit behavior unchanged

## Browser companion — 0.6.2

### Fixed
- Codeforces submit on contest pages (`submittedProblemIndex`) and problemset pages (`submittedProblemCode`)

## Browser companion — 0.6.1

### Added
- Sample capture from Codeforces and CSES problem pages
- Submit form autofill when submitting from CPOS
- CSES solved and attempted progress scraping
- Localhost-only communication (`127.0.0.1:27121` / `27122`)
- Initial Chrome Web Store release

---

## VS Code extension — 0.3.16

### Added
- Panel theme is now saved in extension storage, so your choice persists across reloads, restarts, and reinstalls

### Fixed
- Input/output block highlighting now links whole blocks (including multi-line `YES`/`NO` outputs) using captured output block sizes, with a fallback parser when metadata is absent

## VS Code extension — 0.3.14 – 0.3.15

### Changed
- Submit no longer opens the system default browser; the browser companion opens and fills the submit page in Chrome

## VS Code extension — 0.3.13

### Added
- **Test-case panel:** per-block striping, gutter labels, and linked highlight between input blocks and expected output lines when block metadata is present
- **Resizable columns** between input and expected output; ratio persisted in panel state
- Wider default width for multi-line sample input

### Fixed
- Duplicate text rendering on striped input rows (decoration layer shows stripes only; editable text remains in the textarea)

## VS Code extension — 0.3.10 – 0.3.12

### Added
- Resizable input and output layout in the test panel (0.3.10)

### Fixed
- Visual artifact on striped input rows (0.3.12)

## VS Code extension — 0.3.9

### Fixed
- Submit coordination with the browser companion (localhost queue and submit URL)

## VS Code extension — 0.3.8

### Added
- Panel themes: **CPOS**, **Midnight**, **Amber**, **Paper**, and **Native** (follows the active VS Code theme); selection persisted via the theme control in the panel header

### Changed
- Refreshed panel visual design: improved contrast, card layout, branded header

## VS Code extension — 0.3.7

### Added
- CPOS side panel: run samples, submit, open problem
- Browser capture server on port `27122`
- Automatic file creation in the open workspace folder
- Per-file sample storage and inline pass/fail results
- Configurable language, compile commands, and save location
- Localhost sync with the terminal app

---

## Terminal app — 0.1.0

### Added
- TUI with Dashboard, Problems, Contests, Analytics, and Recommend tabs
- Local problem browser with search, rating filter, and platform filter
- Codeforces sync (problems, submissions, rating, contests)
- CSES progress sync via the browser companion
- Recommendation engine (30 unsolved problems targeting weak topics)
- Localhost capture server on port `27121`
- Local sample test runner; submit via the browser companion

---

When cutting a release, add a dated section, bump the version in the component manifest or `Cargo.toml`, and publish a GitHub release.
