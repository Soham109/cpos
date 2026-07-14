<h1 align="center">CPOS</h1>

<p align="center"><b>Competitive Programming Operating System</b></p>

<p align="center">
Open a problem in your browser. CPOS creates the file, loads the samples, and lets you run and submit — without copy-pasting anything.
</p>

<p align="center">
  <a href="https://cpos.sohamaggarwal.com"><img alt="Website" src="https://img.shields.io/badge/website-cpos-8b5cf6"></a>
  <a href="https://cpos.sohamaggarwal.com/docs"><img alt="Docs" src="https://img.shields.io/badge/docs-read-c4b5fd"></a>
  <a href="https://youtu.be/5HTatBfpK5A"><img alt="Demo" src="https://img.shields.io/badge/demo-YouTube-red?logo=youtube&logoColor=white"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=sohamaggarwal.cpos-vscode"><img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-Extension-007ACC?logo=visualstudiocode&logoColor=white"></a>
  <a href="https://chromewebstore.google.com/detail/gjnbapmjonegeeamdeahcoojgokeogmm"><img alt="Chrome" src="https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white"></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <a href="https://discord.gg/QkdmcRKz"><img alt="Discord" src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white"></a>
</p>

<p align="center">
  <a href="https://youtu.be/5HTatBfpK5A">
    <img src="https://img.youtube.com/vi/5HTatBfpK5A/maxresdefault.jpg" alt="Watch the CPOS demo on YouTube" width="820">
  </a>
</p>

<p align="center"><sub>Capture a problem · auto-create your file · run samples · submit from VS Code</sub></p>

---

## What is CPOS?

Solving a problem on Codeforces, CSES, or AtCoder usually means copying samples into files, running them by hand, and pasting code back into the judge. CPOS removes that entire layer.

It is three local clients that share the same files and talk over `127.0.0.1`:

| Component | What it does |
| --- | --- |
| **Browser companion** | Captures samples and statements from the problem page, and autofills the judge's submit form in your logged-in tab. Optional practice and on-page tools for Codeforces and CSES. |
| **VS Code extension** | A panel with your sample tests, **Run All**, **Submit**, and a native Statement tab. Compiles and runs locally with per-test diffs. |
| **Terminal app** | A Rust TUI: problem catalog, contests, analytics, skill-model recommendations, and a goal-based practice plan. |

Everything runs on your machine — no accounts, no servers, no tracking. CPOS never touches your judge passwords; submitting reuses the login already in your browser.

## Quick start

**1. Terminal app**

```bash
# macOS / Linux
brew tap Soham109/cpos https://github.com/Soham109/cpos
brew install cpos
cpos
```

```powershell
# Windows
scoop bucket add cpos https://github.com/Soham109/cpos
scoop install cpos
cpos
```

Prebuilt binaries — no Rust toolchain needed. No package manager? See the [installer scripts](https://cpos.sohamaggarwal.com/docs#installation).

**2. VS Code extension** — install from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=sohamaggarwal.cpos-vscode).

**3. Browser companion** — install from the [Chrome Web Store](https://chromewebstore.google.com/detail/gjnbapmjonegeeamdeahcoojgokeogmm) (Chrome, Edge, Brave) or [from source for Firefox](extensions/firefox).

Then:

1. Open a folder in VS Code.
2. Visit any Codeforces / CSES / AtCoder problem — a solution file appears with the samples attached.
3. Write your solution, hit **Run All**, then **Submit**. Done.

## Features

- **Auto file creation & sample capture** — open a problem, get a ready-to-edit file with its tests
- **Run & submit** — compile and diff samples locally; submit autofills the judge form in your browser
- **Statements everywhere** — the full captured statement renders in VS Code and inside the terminal (LaTeX and diagrams included)
- **Sample visualizer** — auto-detects what a sample input is (graph, tree, grid, intervals, permutation, …) and draws it, with an execution trace player that animates your own code on the drawing
- **Practice engine** — a per-tag skill model scores unsolved problems across seven query modes (weakness, push, refresh, upsolve, explore, …), each pick with human-readable reasons
- **Goal plans** — set a rating goal, get topic readiness and an ordered problem plan to reach it
- **Analytics** — rating history, topic breakdown, activity heatmap, streaks
- **Contests** — upcoming and running Codeforces contests with countdowns
- **Shared templates** — per-language templates used by VS Code, the terminal, and the browser editor alike

## Documentation

**Full docs live at [cpos.sohamaggarwal.com/docs](https://cpos.sohamaggarwal.com/docs)** — how the pieces fit together, every install path, component guides, the practice engine, the localhost protocol, and configuration.

| In this repo | Purpose |
| --- | --- |
| [INSTALL.md](INSTALL.md) | Terminal app install, update, and release publishing |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common fixes (install, Run All, submit, source builds) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the components connect ([interactive graph](https://cpos.sohamaggarwal.com/architecture)) |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup and PR guidelines |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
| [SECURITY.md](SECURITY.md) | Report vulnerabilities |

## Community

- **[Discord](https://discord.gg/QkdmcRKz)** — help, workflows, and what's coming next
- **[GitHub issues](https://github.com/Soham109/cpos/issues)** — bugs and feature requests

## Roadmap

- AtCoder in the terminal app (sync, analytics, recommendations — capture, submit, and the visualizer already work in the browser and VS Code)
- CodeChef support
- Contest mode with per-problem timers
- Submission verdicts read back into CPOS

## Contributing & sponsoring

CPOS is MIT-licensed and built by one person, in the open. Contributions are welcome — start with [CONTRIBUTING.md](CONTRIBUTING.md). If CPOS saves you time on every problem, [sponsoring](https://github.com/sponsors/Soham109) funds new judges, contest mode, and ongoing maintenance.

## License

[MIT](LICENSE)
