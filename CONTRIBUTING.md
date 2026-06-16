# Contributing to CPOS

Thanks for taking the time to contribute. CPOS is open source (MIT) — bug reports, ideas, docs fixes, and code are all welcome.

Want to chat first? Join the [CPOS Discord](https://discord.gg/cNtBCGh5) to ask questions, float an idea, or get help with dev setup.

For security issues, see [SECURITY.md](SECURITY.md) — do not open public issues for vulnerabilities.

For how the pieces fit together, see [ARCHITECTURE.md](ARCHITECTURE.md). Release history and current versions are in [CHANGELOG.md](CHANGELOG.md). Common user issues: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

| Component | Current version |
| --- | --- |
| Terminal app | 0.1.6 (`Cargo.toml`) |
| VS Code extension | 0.3.27 (`extensions/vscode/package.json`) |
| Browser companion (Chrome) | 0.6.14 (`extensions/chrome/manifest.json`) |
| Browser companion (Firefox) | 0.0.2 (`extensions/firefox/manifest.json`) |

## Ways to help

- **Report bugs** — [open an issue](https://github.com/Soham109/cpos/issues) with steps to reproduce, your OS, and which part you use (terminal / VS Code / browser).
- **Suggest features** — issues are fine; explain the problem you're trying to solve, not just the feature name.
- **Fix bugs or improve docs** — pull requests are the fastest path.
- **Share feedback** — if something in the README or website is wrong, fix it or tell us.

You don't need permission to open an issue or start a small PR.

## Project layout

| Path | What it is |
| --- | --- |
| `src/` | Terminal app (Rust + ratatui) |
| `extensions/vscode/` | VS Code extension |
| `extensions/chrome/` | Chrome/Edge/Brave browser companion |
| `extensions/firefox/` | Firefox browser companion |
| `docs/` | Landing site (`cpos.sohamaggarwal.com`) |
| `tools/` | Screenshot render/optimize scripts |

The three user-facing pieces talk over localhost (`27121` TUI, `27122` VS Code). Keep that contract in mind when changing capture or submit behavior.

## Development setup

### Terminal app

```bash
cargo build
cargo run
cargo test
```

On macOS you may need a real GNU toolchain for C++ (`brew install gcc`) if you're testing C++ captures.

### VS Code extension

```bash
cd extensions/vscode
npm install
npm run compile
```

Open the `extensions/vscode` folder in VS Code/Cursor and press **F5** to launch an Extension Development Host. See [`extensions/vscode/README.md`](extensions/vscode/README.md).

### Browser companion

Install **[CPOS Companion](https://chromewebstore.google.com/detail/gjnbapmjonegeeamdeahcoojgokeogmm)** from the Chrome Web Store (Chrome, Edge, Brave), or load the Firefox companion from `extensions/firefox` while it is not yet listed on AMO.

To work on the Chrome extension locally, load unpacked from `extensions/chrome` — see [`extensions/chrome/README.md`](extensions/chrome/README.md) and the publish script there.

To work on the Firefox extension locally, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on...**, and select `extensions/firefox/manifest.json`. See [`extensions/firefox/README.md`](extensions/firefox/README.md) and `extensions/firefox/package-firefox.sh`.

### Landing page

Static files in `docs/`. Preview locally:

```bash
cd docs && python3 -m http.server 8080
```

Regenerate TUI screenshots: `cargo run --example gen_screenshots`, then `python3 tools/render_screens.py` (needs Pillow).

## Pull requests

1. **Fork** and branch from `main` (`fix/…`, `feat/…`, or `docs/…`).
2. **Keep PRs focused** — one logical change is easier to review than a bundle.
3. **Describe what and why** in the PR body, not just what files changed.
4. **Test what you touch** — CI runs `cargo test` and compiles the VS Code extension; run them locally before opening a PR.
5. **Match existing style** — naming, formatting, and patterns already in the file you're editing.

Don't worry about perfect commit history; clear PR descriptions matter more.

## Code guidelines

- Prefer small, readable changes over large refactors unless discussed first.
- Don't break the local-only model — no sending user code or problem data to external servers.
- Extension and TUI config should stay in sync where they share settings (language, compile commands, templates).
- Comments only when the logic isn't obvious from the code.

## License

By contributing, you agree that your contributions will be licensed under the same [MIT License](LICENSE) as the project.
