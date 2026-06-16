# CPOS troubleshooting

Common issues across the **VS Code extension**, **browser companion**, and **terminal app**.  
If something isn’t listed here, open a [GitHub issue](https://github.com/Soham109/cpos/issues) with your OS, CPOS versions, and the exact error text.

| Component | Version file |
| --- | --- |
| VS Code extension | `extensions/vscode/package.json` |
| Browser companion (Chrome) | `extensions/chrome/manifest.json` |
| Browser companion (Firefox) | `extensions/firefox/manifest.json` |
| Terminal app | `Cargo.toml` |

---

## VS Code — Run All fails: `spawn sh ENOENT`

**What it means:** CPOS could not start a shell to compile or run your file. This is **not** a wrong answer (WA) or compilation error (CE) in your solution.

**Fix:** Update to VS Code extension **0.3.21+** (uses `/bin/sh` on macOS/Linux and `cmd.exe` on Windows).

### macOS

1. Install a compiler if needed:
   ```bash
   brew install gcc
   ```
2. If VS Code was opened from the Dock (macOS), launch it from Terminal so PATH includes `/bin` and Homebrew:
   ```bash
   code .
   ```
3. Open **View → Output → CPOS** to see the exact command CPOS ran.

### Windows

1. Install a C++ toolchain — e.g. [MSYS2](https://www.msys2.org/):
   ```bash
   pacman -S mingw-w64-ucrt-x86_64-gcc
   ```
   Add `C:\msys64\ucrt64\bin` to your system **PATH** (or use MinGW-w64 / Scoop `gcc`).
2. **Python:** ensure `python` is on PATH (Windows often has no `python3` command).
3. Check **Output → CPOS** for the compile/run command and errors.

### Windows: `"Hello".exe` or Python `Invalid argument` / quotes in the path

**What it means:** CPOS was wrapping compile/run paths in extra quotes. MinGW then tried to create a file literally named `"Hello".exe`, and Python looked for a mangled path under `.cpos-vscode\build\`.

**Fix:** Update to VS Code extension **0.3.23+**.

### Windows: Run All always shows `(no output)`

**What it means:** VS Code had newer unsaved code in the editor, but CPOS compiled the older saved file on disk. This could make every sample look like it had no output, even when the current editor contents should print output or fail compilation.

**Fix:** Update to VS Code extension **0.3.27+**. On Windows, Run All now saves the matching dirty solution file before compiling. macOS/Linux behavior is unchanged.

### All platforms

- **CE in the panel** = the toolchain ran but the build failed — read stderr in the test row or CPOS output.
- Override commands: **Settings → Extensions → CPOS → Compile Commands** (`{source}`, `{output}`, `{dir}` placeholders).

---

## VS Code — Compilation errors (CE)

### macOS: `#include <bits/stdc++.h>` not found

Apple’s default `g++` is Clang and does not ship `bits/stdc++.h`. Install GNU g++:

```bash
brew install gcc
```

CPOS auto-detects Homebrew’s `g++-14`, `g++-15`, etc. when the GUI app’s PATH is thin.

### Custom compiler or flags

Sync with the terminal app via `~/Library/Application Support/cpos/config.toml` (macOS) or `%APPDATA%\cpos\config.toml` (Windows), or set `cpos.compileCommands` in VS Code settings.

---

## Submit — nothing happens or wrong language

### Submit does nothing

1. Install the [browser companion](https://chromewebstore.google.com/detail/gjnbapmjonegeeamdeahcoojgokeogmm) in **Chrome** (Edge/Brave work too), or load the Firefox companion from `extensions/firefox`.
2. Stay **logged in** to Codeforces or CSES in that browser.
3. CPOS talks to supported browser companions over `127.0.0.1`; Safari is not supported.
4. Keep the VS Code extension running (capture server on port `27122`).
5. In VS Code extension **0.3.30+**, if the companion does not pick up a queued submit quickly, CPOS shows an **Open submit page** fallback action.

### Codeforces submits with wrong compiler (e.g. C++17 instead of C++23)

Update the browser companion to **0.6.13+**. It picks the **newest matching compiler** from the submit dropdown (e.g. G++23 before G++17, or CSES C++21 before C++17) instead of a stale/hardcoded fallback.

Rebuild and upload from `extensions/chrome` if you install Chrome unpacked:

```bash
./package-store.sh
```

For Firefox source installs, pull the latest repo changes and reload `extensions/firefox/manifest.json` from `about:debugging`.

### Submit opens but code is empty or form not filled

- Log in on Codeforces/CSES in the same browser profile as the companion.
- Disable other extensions that might block scripting on judge pages.
- Retry after a full page load on the submit URL.

---

## Capture — samples or file not appearing

1. **VS Code:** open the folder where you want solution files before capturing.
2. **Browser companion** installed and enabled on `codeforces.com` / `cses.fi`.
3. **One CPOS server:** only one VS Code window should own the capture port (`27122`); the panel shows if another window is active.
4. Refresh the problem page after installing the extension.

Terminal app capture uses port `27121` — VS Code and TUI can both receive captures; VS Code is enough for most workflows.

---

## Terminal app — installer fails or `cpos` is not found

The recommended TUI install uses package managers backed by prebuilt GitHub Release binaries:

macOS/Linux with Homebrew:

```bash
brew tap Soham109/cpos https://github.com/Soham109/cpos
brew install cpos
```

Windows with Scoop:

```powershell
scoop bucket add cpos https://github.com/Soham109/cpos
scoop install cpos
```

### Homebrew: tap or install fails

Make sure Homebrew itself is healthy:

```bash
brew update
brew doctor
```

Then retry:

```bash
brew tap Soham109/cpos https://github.com/Soham109/cpos
brew install cpos
```

### Scoop: bucket or install fails

Make sure Scoop itself is healthy:

```powershell
scoop update
```

Then retry:

```powershell
scoop bucket add cpos https://github.com/Soham109/cpos
scoop install cpos
```

### Package file or release asset not found

Homebrew and Scoop depend on the generated `Formula/cpos.rb`, `bucket/cpos.json`, and GitHub Release assets. Cut a tagged release first, or use the installer fallback while developing:

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/Soham109/cpos/main/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/Soham109/cpos/main/install.ps1 | iex
```

See [INSTALL.md](INSTALL.md) for the release and publishing flow.

---

## Terminal app — source install fails: `link.exe` not found

**What it means:** Rust on Windows is using the **MSVC** toolchain but **Visual C++ build tools** are not installed. VS Code does **not** include the linker.

This only applies when building CPOS from source with `cargo install`. The prebuilt installer above avoids this Rust/Windows setup issue.

### Fix A — MSVC (recommended on Windows)

1. Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).
2. Select **Desktop development with C++** (or at least **MSVC** + **Windows SDK**).
3. Restart your terminal.
4. Retry:
   ```bash
   cargo install --git https://github.com/Soham109/cpos
   ```

**Verify:**

```bash
rustup show          # active toolchain, e.g. x86_64-pc-windows-msvc
where link.exe       # should find Visual Studio's linker
```

### Fix B — GNU toolchain (MSYS2)

1. Install [MSYS2](https://www.msys2.org/) and GCC:
   ```bash
   pacman -S mingw-w64-ucrt-x86_64-gcc
   ```
2. Switch Rust to the GNU target:
   ```bash
   rustup toolchain install stable-x86_64-pc-windows-gnu
   rustup default stable-x86_64-pc-windows-gnu
   ```
3. Retry `cargo install --git https://github.com/Soham109/cpos`.

### Don’t need the terminal app?

**VS Code extension + browser companion** is enough for capture, Run All, and submit. The TUI is optional (catalog, contests, analytics, recommendations).

---

## Terminal app — other issues

### Config location

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/cpos/config.toml` |
| Windows | `%APPDATA%\cpos\config.toml` |
| Linux | `~/.config/cpos/config.toml` |

### Windows: the TUI shows garbled / Cyrillic ("Russian") text

Fixed in terminal app **0.1.6+** — CPOS now switches the Windows console to UTF-8 on startup. The cause was a legacy console code page decoding the UI's UTF-8 box-drawing/symbol characters as mojibake. Update with `cpos update` (or reinstall via Scoop). If you build from source, pull `main` and rebuild.

### Setup: pasting a template doesn't work / only the first line appears

Use terminal app **0.1.6+** and, on the Template step, press **`v`** to paste (CPOS reads the whole clipboard directly — reliable even where the terminal doesn't support bracketed paste, e.g. Windows conhost). Or press **`Tab`** to switch to **Upload** mode and load the template from a file path. This applies to all platforms; on macOS `⌘V` also still works.

### Submit from TUI opens wrong browser

The terminal app queues submit for the **browser companion** only (same as VS Code). Install a supported companion and use that browser while logged in.

### Starting a problem makes the TUI flicker or corrupt the editor

Use terminal app **0.1.8+**. CPOS now suspends the full-screen TUI before launching interactive terminal editors such as `vim`, `nvim`, `nano`, `micro`, Helix, Kakoune, or `emacs -nw`, then restores the UI after the editor exits.

### CSES progress not syncing

Set `cses_session` in config (see README) and use the browser companion on the CSES problem list.

---

## Panel UI

### Native theme — Run All button looks wrong on light VS Code themes

Update to VS Code extension **0.3.20+**. Native theme uses VS Code button colors (white label on the theme button background).

### Extension README screenshot broken in Extensions view

Update to **0.3.20+** or reinstall from the latest VSIX/Marketplace build.

---

## Still stuck?

1. Note your versions (VS Code extension, browser companion, terminal app if used).
2. Copy the **full error** from **Output → CPOS** or your terminal.
3. Say which step failed: TUI install, capture, Run All, submit, or source install.
4. [Open an issue](https://github.com/Soham109/cpos/issues) or ask in the [CPOS Discord](https://discord.gg/CZ3UdPDs5k) with that info.
