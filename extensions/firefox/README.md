# CPOS Companion for Firefox

Firefox build of the CPOS browser companion for Codeforces, CSES, and AtCoder. It
now has **full feature parity with the Chrome companion** — it was previously
capture/submit only. Alongside capturing public samples (Codeforces, CSES, and
AtCoder), syncing CSES progress,
and autofilling judge submit pages through the local CPOS endpoints, it adds the
same optional practice and on-page tooling: profile analytics and compare, the
in-browser editor, rating predictions, contest reminders, daily problem & streak,
favorites, problem timer, problemset/standings tools, problem
tools, pen & marker (a draggable freehand pen plus a statement-text highlighter with notes), code & LaTeX styling, and site themes + Modernize. Every
feature is individually toggleable from the popup, and everything stays read-only
(public CF API + localhost), except Compete race delivery/public matching, which
uses public ntfy.sh topics containing race metadata and replies—not source code,
cookies, or passwords.

**Current version:** 0.15.3 (see [CHANGELOG.md](../../CHANGELOG.md)).

## Permissions

The companion requests the `notifications` permission for the **contest
reminders** feature (desktop notifications before upcoming Codeforces contests).
If you don't use reminders, that feature can be left off. All other features rely
only on the public Codeforces API and the local CPOS endpoints.

## Install From Source

This Firefox build is not listed on addons.mozilla.org yet. For now, load it
from source for local use:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select `extensions/firefox/manifest.json`.

Firefox 142 or newer is required. Temporary add-ons are removed when Firefox restarts; reload this manifest when needed.

Firefox's install prompt discloses `websiteContent` transmission because captured
problem data and editor run requests leave the browser for the user's localhost
CPOS app, while Compete race metadata can be sent through ntfy.sh.

## Package

```bash
./package-firefox.sh
```

This produces `cpos-companion.xpi` in this directory for local testing or
Mozilla signing. Normal Firefox release builds require add-ons to be signed by
Mozilla before permanent installation, even when the add-on is self-distributed
instead of publicly listed.

Mozilla's `web-ext` tooling is also configured:

```bash
npx --yes web-ext lint
npx --yes web-ext build
```
