# CPOS

**Competitive programming for Codeforces and CSES — in VS Code.**

Open a problem in your browser. CPOS creates your solution file in the folder you have open, loads the sample tests, and provides a side panel to run samples and submit.

Part of the **CPOS** project — works with the [terminal app](https://github.com/Soham109/cpos), the [Chrome browser companion](https://chromewebstore.google.com/detail/gjnbapmjonegeeamdeahcoojgokeogmm), and the Firefox companion in the CPOS repo. All components sync over localhost.

## Demo

<p align="center">
  <a href="https://youtu.be/5HTatBfpK5A">
    <img src="https://img.shields.io/badge/▶_Full_walkthrough-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="Watch the CPOS full demo on YouTube">
  </a>
</p>

<p align="center">
  <a href="https://youtu.be/5HTatBfpK5A">
    <img src="https://img.youtube.com/vi/5HTatBfpK5A/maxresdefault.jpg" alt="Click to play the CPOS demo on YouTube" width="720">
  </a>
</p>

![CPOS VS Code panel with test cases and a Codeforces solution](https://raw.githubusercontent.com/Soham109/cpos/main/extensions/vscode/media/vscode-panel-ui.png)

## How it works

1. Install from the **[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sohamaggarwal.cpos-vscode)** and a browser companion: **[Chrome Web Store](https://chromewebstore.google.com/detail/gjnbapmjonegeeamdeahcoojgokeogmm)** or Firefox from source in the CPOS repo
2. Open the folder where you want solution files
3. Open a Codeforces or CSES problem in your browser
4. CPOS creates the solution file (for example `1982C.cpp`) with samples attached
5. Write code and use the **CPOS panel** to **Run All** or **Submit**

## The CPOS panel

Open the **CPOS** view in the activity bar:

- **Tests / Statement / Submissions / Solution tabs** — switch between the sample tests, the captured problem statement (rendered natively with MathJax), your recent submissions, and editorial/solution resources without leaving the editor
- **Run All** — compile and run every sample; verdicts shown inline (`AC`, `WA`, `TLE`, `RE`, `CE`)
- **Submit** — queue submission for the browser companion; if it is not picked up quickly, CPOS offers an **Open submit page** fallback
- **Submissions tab** — every submission you have made to the problem (scrollable, newest first), each showing a submission number, the time it was made, and the judge verdict (`Accepted`, `Wrong Answer`, `Time Limit`, `Memory Limit`, …). Set `cpos.codeforcesHandle` to pull your full history with real verdicts from the Codeforces API; without it, submissions made from CPOS are tracked locally as `Pending`. Use the **refresh** button to re-pull verdicts
- **Problem ID link** — open the problem statement from the Tests header
- **GitHub** — open the CPOS repository
- **Test cases** — edit, add, or remove samples; Codeforces multi-case inputs can show linked input/output blocks
- **Themes** — CPOS, Midnight, Amber, Paper, or Native (matches your VS Code theme; Run All uses VS Code button styling)

Keep the **terminal app** running for browsing, recommendations, and analytics. Captures and submissions work with either app.

## Settings

`Settings → Extensions → CPOS` — save folder, language, template, compile commands, timeouts, Codeforces handle.

By default, files are created in the **currently open workspace folder**.

Submit requires a browser companion and an active login on the judge site.

## Troubleshooting

See **[TROUBLESHOOTING.md](../../TROUBLESHOOTING.md)** — Run All (`spawn sh ENOENT`), submit, capture, Windows `cargo install` / `link.exe`, and more.

## Links

- [Full demo on YouTube](https://youtu.be/5HTatBfpK5A)
- [CPOS on GitHub](https://github.com/Soham109/cpos)
- [TROUBLESHOOTING.md](../../TROUBLESHOOTING.md)
- [Changelog](../../CHANGELOG.md)
- [Architecture](../../ARCHITECTURE.md)
- [Report an issue](https://github.com/Soham109/cpos/issues)
