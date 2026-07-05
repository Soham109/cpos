# Chrome Web Store listing — copy & paste

Use this when uploading `cpos-companion.zip` at  
[Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).

---

## Build the zip

```bash
cd extensions/chrome
./package-store.sh
```

Upload **`cpos-companion.zip`** (root must contain `manifest.json`).

---

## Store fields

| Field | Value |
|-------|-------|
| **Category** | Developer Tools |
| **Language** | English |
| **Privacy policy URL** | `https://github.com/Soham109/cpos/blob/main/extensions/chrome/PRIVACY.md` |
| **Official URL** (optional) | `https://github.com/Soham109/cpos` |
| **Support URL** (optional) | `https://github.com/Soham109/cpos/issues` |

### Title
```
CPOS Companion
```

### Summary (132 chars max)
```
A Codeforces, CSES & AtCoder companion: capture, edit, practice, analyze profiles, and run submission-refereed races with friends.
```

### Description
```
CPOS Companion is a local-first companion for Codeforces, CSES, and AtCoder. It connects your browser to CPOS (the VS Code extension and terminal app) and layers optional practice and on-page tooling over the judge sites (capture and submit work on all three; the on-page practice tools cover Codeforces and CSES). There are no CPOS accounts or analytics. Most data stays on your machine; Compete uses the public ntfy.sh relay for race delivery and matchmaking.

CAPTURE & SUBMIT
• Open a Codeforces, CSES, or AtCoder problem and it captures the public sample tests for CPOS on your machine
• Submit from CPOS (VS Code or terminal) and it autofills the submit page in your logged-in tab, picking the newest matching compiler
• Optionally syncs CSES solved/attempted status when you choose to sync

ON THE PROBLEM PAGE
• In-browser editor — a CodeMirror-powered editor: run against samples with a per-test diff and custom stdin, use shared per-language templates, then submit in place
• Sample visualizer — draws each sample as the structure it is (graph, tree, grid, matrix, array, permutation cycles, bracket/binary strings, intervals, points; multi-testcase aware), with an execution trace player that runs your code locally and animates it on the drawing
• Recommend tab — query the local CPOS engine for problems picked from your solve history: weak topics, fresh problems, upsolving, goal roadmap (terminal app required)
• Code & LaTeX styling for statements, editorials and comments
• Problem focus — hide the Codeforces right rail and expand the statement for split-screen solving
• Problem tools — rating badge, tag-hider / training mode, one-click sample copy, similar problems, and a per-problem timer
• Pen & marker — a draggable floating launcher to draw freehand on the page or highlight statement text and attach notes; saved per problem page

PRACTICE & ANALYTICS
• Profile analytics — activity heatmap, streaks, solved-by-rating / index, tags, verdict and language charts (public CF API, read-only)
• Profile compare (VS) — stack handles side by side with a rating-history overlay
• Daily problem with Auto or exact-rating selection, streaks, favorites, problemset solve-status, standings tools, and rating predictions
• Paste or upload templates in the popup and sync them with CPOS on localhost
• Contest reminders before upcoming Codeforces rounds

COMPETE
• Challenge a friend by Codeforces handle or publish an open race
• Choose the current problem, enter a problem ID/link, or pick randomly by rating
• Discover public races in a selected rating range
• Codeforces public submissions decide the winner: first Accepted after the race starts
• Race state and matching preferences sync locally with the VS Code extension

APPEARANCE
• Modernize — a sleek font, calmer spacing and cards for Codeforces & CSES
• One theme palette shared across the popup, the site, and every CPOS tool

REQUIRES
• The CPOS VS Code extension and/or terminal app running locally for capture, run, and submit
• You must be logged in to Codeforces, CSES, or AtCoder in this browser for submissions

PRIVACY
• No analytics or CPOS accounts
• Capture, code execution, templates, and submissions use 127.0.0.1 only
• Compete uses public ntfy.sh topics for handles, problem/race metadata, and accept/decline replies—never source code, passwords, or cookies
• Full privacy policy: https://github.com/Soham109/cpos/blob/main/extensions/chrome/PRIVACY.md

Open source: https://github.com/Soham109/cpos
VS Code extension: https://marketplace.visualstudio.com/items?itemName=sohamaggarwal.cpos-vscode
```

### Single purpose
```
A companion for the competitive-programming judges Codeforces, CSES, and AtCoder: it captures problem samples to the local CPOS editor and (on Codeforces and CSES) enhances the sites in place with practice, analytics and editing tools. Every feature operates only on Codeforces, CSES, AtCoder, and the local CPOS endpoint.
```

---

## Permission justifications (Privacy practices tab)

### Host permission: `http://127.0.0.1:27121/*` and `http://127.0.0.1:27122/*`
```
CPOS runs locally on the user's machine (terminal app and VS Code extension). Captured samples, the user's code for the in-editor "Run", templates, and pending submissions are sent only to these localhost endpoints.
```

### Host permission: `https://codeforces.com/*`
```
Reads public problem and sample data from Codeforces pages the user opens, and autofills the submit form when the user submits from CPOS while logged into Codeforces in this browser. The optional on-page tools (profile analytics, profile compare, rating predictions, problem focus, problemset/standings helpers) read only public Codeforces pages and the public Codeforces API; they add charts and styling in place and send nothing to CPOS-operated or developer servers.
```

### Host permission: `https://cses.fi/*`
```
Reads public problem and sample data from CSES pages the user opens, syncs task progress from the problem list when requested, and autofills the submit form when the user submits from CPOS.
```

### Host permission: `https://atcoder.jp/*`
```
Reads public problem and sample data from AtCoder task pages the user opens, and autofills the submit form when the user submits from CPOS while logged into AtCoder in this browser. Used only for sample capture and submit autofill; nothing is sent to CPOS-operated or developer servers.
```

### Permission: `scripting`
```
Injects autofill logic only on Codeforces, CSES, and AtCoder submit pages when CPOS queues a submission from the local editor. Required because submit pages use dynamic editors that cannot be filled from an ordinary content script alone.
```

### Permission: `tabs`
```
Finds an existing Codeforces/CSES/AtCoder tab or opens one when the user submits from CPOS, so the submit form can be autofilled in the correct logged-in session.
```

### Permission: `alarms`
```
Chrome may suspend the extension's background worker when idle. CPOS uses alarms to check localhost for queued submissions, refresh contest reminders, and keep Compete invitations/results current through the public Codeforces API and ntfy.sh relay. It does not read unrelated browsing history.
```

### Permission: `storage`
```
Stores the user's own settings locally in chrome.storage.local: feature toggles, theme/palette, in-browser editor drafts and templates, daily-problem rating/streak, favorites, problem-timer state, problem focus preference, marker notes/highlights, profile-compare handles, friends list, contest-reminder preferences, and short-lived public-data caches. Templates sync only to the user's own localhost CPOS app; other data never leaves the device except when the user explicitly runs or submits code.
```

### Permission: `notifications`
```
Used for optional contest reminders and Compete race invitations/results. Notifications are generated locally from the public Codeforces schedule or locally stored race state.
```

### Host permission: `https://ntfy.sh/*`
```
Compete uses ntfy.sh as a public, no-account relay to deliver race invitations and accept/decline replies by Codeforces handle, and to discover open public races. Messages contain handles, problem/race metadata, and replies—never source code, passwords, or cookies. ntfy.sh topics are public and are intended for friendly competition.
```

---

## Data usage certification

When asked whether you collect or use user data:

- **No**, the extension does not sell or transfer user data to third parties for unrelated purposes.
- **No** analytics or developer-operated remote collection.
- Disclose: *problem metadata and source code transmitted locally to CPOS on 127.0.0.1 when the user uses capture/run/submit; settings and drafts stored locally; Compete handles and race metadata transmitted through public ntfy.sh topics when race delivery or public matching is used*.

---

## Screenshots

Chrome requires at least one screenshot (1280×800 or 640×400). Five ready-to-upload
slides live in [`store/`](store/) (1280×800, not included in the zip):

1. **`screenshot-1.png`** — One hub: the popup with every feature toggle
2. **`screenshot-2.png`** — In-browser editor: code and submit on the problem page
3. **`screenshot-3.png`** — Profile analytics: heatmap, streaks, tags, verdicts
4. **`screenshot-4.png`** — Profile compare (VS): handles side by side with a rating overlay
5. **`screenshot-5.png`** — Modernize: a cleaner Codeforces with solve-status coloring

Regenerate them from the raw product screenshots with
`python tools/make_companion_slides.py` (also writes the website gallery in
`docs/shots/`). The same five files are mirrored in `extensions/firefox/store/`.

---

## One-time fee

Chrome Web Store developer registration: **$5 one-time** at [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
