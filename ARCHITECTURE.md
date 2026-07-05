# CPOS architecture

CPOS is three local clients plus a static website. Capture, execution, templates,
and submission communicate over `127.0.0.1`. The browser companion's Compete
feature additionally uses public ntfy.sh topics for race delivery and matching;
Codeforces public submissions act as the referee.

**Current releases:** terminal app 0.3.0 · VS Code extension 0.6.1 · browser companion 0.17.0 (Chrome + Firefox) (see [CHANGELOG.md](CHANGELOG.md)).

```
┌─────────────────┐     capture / submit      ┌──────────────────┐
│ Browser         │ ───────────────────────▶│ VS Code (:27122) │
│ companion       │                         │  extension       │
└────────┬────────┘                         └────────┬─────────┘
         │                                           │
         │ capture / submit                          │ forward capture
         ▼                                           ▼
┌─────────────────┐                         ┌──────────────────┐
│ Terminal TUI    │◀────── localhost ──────▶│ Shared data dirs │
│ (:27121)        │                         │ (config, cache)  │
└─────────────────┘                         └──────────────────┘
```

## Components

| Path | Role |
| --- | --- |
| `src/` | Terminal application (ratatui UI, sync, recommendations, local test runner) |
| `extensions/vscode/` | VS Code extension: side panel, webview UI, capture HTTP server |
| `extensions/chrome/` | Chrome/Edge/Brave browser companion: DOM capture, submit autofill, popup-toggleable practice/site tools, and Compete delivery/refereeing. Most features use public judge data + localhost; Compete also uses ntfy.sh |
| `extensions/firefox/` | Firefox browser companion: full feature parity with Chrome over the same localhost capture/submit protocol, source/self-installed until AMO publishing |
| `docs/` | Static landing site |

## Localhost protocol

Both CPOS applications expose a small HTTP API bound to the loopback interface.

| Port | Owner | Implementation |
| --- | --- | --- |
| `27121` | Terminal TUI | `src/engine/capture.rs` |
| `27122` | VS Code extension | `extensions/vscode/src/extension.ts` |

The browser companion polls **both** ports so captures and submissions work whether one or both apps are running.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/capture/problem` | Problem metadata, sample tests, optional `solution_path` from VS Code |
| `POST` | `/capture/cses-progress` | CSES solved and attempted task identifiers |
| `GET` | `/pending-submit` | Browser polls for a queued submission |
| `POST` | `/pending-submit/consumed` | Clear the queue after autofill completes |
| `GET` | `/config` | Read the default language and shared per-language templates |
| `POST` | `/config` | Save a shared template or default language |
| `GET/POST` | `/challenges` | VS Code-only mirror for Compete races, public matches, identity, and matching preferences |
| `GET` | `/recommend` | Central practice engine (terminal app only): mode/tags/rating/year query → scored, reasoned recommendations |
| `GET` | `/health` | Liveness check |

Cross-origin headers are permissive because traffic never leaves the machine.

## Capture flow

1. The user opens a Codeforces, CSES, or AtCoder problem in the browser (logged in when they plan to submit later).
2. A content script reads public sample input and output from the page DOM.
3. On Codeforces, when the statement uses grouped sample lines, the companion also records per-block line counts (`input_block_sizes`) for the VS Code panel.
4. The companion `POST`s JSON to `127.0.0.1:27122` and/or `27121`.
5. The receiving app stores samples, creates or updates a solution file, and optionally opens the editor.
6. VS Code forwards captures to the TUI when both are running, including the on-disk `solution_path` when files are saved in the open workspace folder.

## Submit flow

CPOS does **not** post solutions to Codeforces, CSES, or AtCoder from the editor over HTTP. That approach conflicts with anti-bot protection and session handling. Instead, the editor queues submission data locally and the browser companion autofills the judge form in the user’s existing logged-in tab.

1. The user runs **Submit** in VS Code or presses `s` in the terminal.
2. The active app writes `{ code, language, submitUrl, contest, index, … }` and serves it at `GET /pending-submit`.
3. The browser companion opens or focuses the submit URL, waits for the form, and runs an injected script in the page **main world** (required for the source textarea and submit controls).
4. The script sets the hidden source field, program language, and problem identifier, then activates the submit control. It avoids `change` events on language or problem fields that would reset the Ace editor and clear the source.
5. On success, the app receives `POST /pending-submit/consumed`.

Passwords and session cookies remain in the browser; CPOS does not read or store judge credentials.

## Solution files and sync

| Location | Contents |
| --- | --- |
| User’s open folder (VS Code) | Solution sources (e.g. `1982C.cpp`) when `cpos.saveLocation` is `workspaceFolder` |
| `~/cpos/` or configured `workspace_dir` | Default terminal workspace (`codeforces/`, `cses/`, templates) |
| `~/.config/cpos/` or `~/Library/Application Support/cpos/` | Shared config and per-language templates |
| Platform data directory (`~/.local/share/cpos/`, `~/Library/Application Support/cpos/`, etc.) | SQLite cache and CSES progress |
| `~/.cpos-vscode/` | VS Code sample cache, problem metadata, compile artifacts |

When VS Code has forwarded a `solution_path`, or the terminal detects a recent session or project-like working directory, pressing **`o`** in the TUI creates new problems in that folder instead of only under `~/cpos/`.

Shared templates are stored per language in the CPOS config directory. The TUI
and VS Code runner expose them over `/config`; browser edits are cached locally
when offline and pushed when either runner reconnects. Legacy VS Code
`cpos.templateFile` and terminal `template_file` paths remain readable and are
surfaced for migration.

## VS Code panel (summary)

The webview panel stores samples per solution file, runs compile-and-test locally, and can highlight multi-case sample input when block metadata is available. Panel chrome (themes, column layout) is client-side only and does not affect the localhost protocol.

## Terminal sync

A background task fetches Codeforces API data (problems, submissions, rating, contests) into a local SQLite cache. Recommendations and analytics read from that cache during normal TUI use.

Press `r` to refresh. CSES progress can be updated from the browser companion when a server-side session cookie is not configured.

## Build and CI

See [CONTRIBUTING.md](CONTRIBUTING.md) for development commands. Continuous integration runs `cargo test` and compiles the VS Code extension on pushes to `main`.
