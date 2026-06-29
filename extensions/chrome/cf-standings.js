// CPOS standings tools — augments Codeforces contest standings
// (/contest/<id>/standings*) with competitor-parity views. All additive,
// theme-aware, and careful to COEXIST with carrot.js (which inserts a predicted
// delta column right after the rank cell — we never touch or remove its cells).
//
//   · LANGUAGE COLORING — tints each contestant row by the programming language
//     they used in the contest (derived from submissions via contest.status),
//     with a compact legend. Degrades gracefully when the language can't be
//     determined (mixed languages → "mixed"; no data → untinted).
//   · FRIENDS-ONLY FILTER — a toggle that hides every row whose handle isn't in
//     the user's friends list. CF's user.friends API needs an authenticated
//     session that content scripts can't replay reliably, so we use a robust
//     two-source approach: (1) if CF's own "Friends standings" view is reachable
//     (?showUnofficial / "Show: Friends" link present, i.e. you're logged in),
//     we scrape the handles it lists; (2) otherwise we let the user maintain a
//     small friends list in chrome.storage.local via a tiny inline editor. Both
//     are merged. This keeps the feature working whether or not CF exposes the
//     friends view to a content script.
//
// Read-only w.r.t. CF: fetches the public CF API + scrapes the rendered table.
// Never touches capture/submit. Toggle from the CPOS popup (feature
// "standingsTools"). UI lives under cpos- ids/classes so site-theme.js protects
// it; re-themes on C.onChange.
(function () {
  const ROOT_ID = "cpos-standings-tools";
  const T = self.CPOS_THEMES;
  const C = self.CPOS;
  if (!C) return;

  const FEATURE = "standingsTools";
  const ROW_ATTR = "data-cpos-st-row";
  const LANG_KEY = "cpos.standings.langs";    // { contestId, ts, byHandle:{handle:lang} }
  const LANG_TTL = 30 * 60 * 1000;            // 30 min
  const FRIENDS_KEY = "cpos.standings.friends"; // { handles:[..] } — user-maintained
  const LANG_ATTR = "data-cpos-lang";

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  // Inline SVG control glyph (a quiet checkmark) — replaces the "✓" text glyph
  // so the active state matches the rest of the CPOS icon set.
  const SVG_CHECK = '<svg class="cpos-st-ico" viewBox="0 0 24 24" width="14" height="14" ' +
    'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

  function contestId() {
    const m = location.pathname.match(/\/contest\/(\d+)\/standings/);
    return m ? m[1] : null;
  }

  async function cfApi(method, qs) {
    const res = await fetch(`https://codeforces.com/api/${method}?${qs}`, { cache: "no-store" });
    if (!res.ok) throw new Error(method + " HTTP " + res.status);
    const json = await res.json();
    if (json.status !== "OK") throw new Error(json.comment || method + " failed");
    return json.result;
  }

  function loggedInHandle() {
    const link = document.querySelector('#header a[href^="/profile/"], .lang-chooser a[href^="/profile/"]');
    if (link) { const m = link.getAttribute("href").match(/\/profile\/([^/?#]+)/); if (m) return decodeURIComponent(m[1]); }
    return null;
  }

  // ── language families: normalize CF's programmingLanguage strings ────────────
  // Keys map to legend buckets; each has a label + a token-derived hue offset so
  // colors come from the theme accent, kept flat (no gradients).
  const LANG_FAMILIES = [
    { id: "cpp",    label: "C++",     test: /\bc\+\+|gnu g\+\+|clang\+\+|ms c\+\+/i },
    { id: "python", label: "Python",  test: /python|pypy/i },
    { id: "java",   label: "Java",    test: /\bjava\b/i },
    { id: "kotlin", label: "Kotlin",  test: /kotlin/i },
    { id: "rust",   label: "Rust",    test: /\brust\b/i },
    { id: "go",     label: "Go",      test: /\bgo\b|golang/i },
    { id: "csharp", label: "C#",      test: /\bc#|\.net|mono c#/i },
    { id: "c",      label: "C",       test: /gnu gcc|\bc11\b|\bc99\b|ms c\b/i },
    { id: "js",     label: "JS/TS",   test: /javascript|typescript|node/i },
    { id: "other",  label: "Other",   test: /.*/ }
  ];
  function familyOf(langStr) {
    if (!langStr) return null;
    for (const f of LANG_FAMILIES) if (f.test.test(langStr)) return f.id;
    return "other";
  }

  // ── per-handle language from the contest's submissions ──────────────────────
  // contest.status gives submissions w/ programmingLanguage + author members.
  // We take each handle's most-frequent language family in this contest.
  let langByHandle = null; // Map handle -> familyId
  let presentFamilies = null; // Set of familyIds actually present (for legend)
  async function loadLangs(id) {
    if (langByHandle) return langByHandle;
    const stored = await C.get([LANG_KEY]);
    const rec = stored[LANG_KEY];
    if (rec && rec.contestId === id && (Date.now() - (rec.ts || 0) < LANG_TTL)) {
      langByHandle = new Map(Object.entries(rec.byHandle));
      return langByHandle;
    }
    try {
      // count[handle][family] -> n ; pick argmax per handle.
      const subs = await cfApi("contest.status", "contestId=" + id + "&from=1&count=100000");
      const counts = new Map();
      for (const s of subs) {
        const fam = familyOf(s.programmingLanguage);
        if (!fam) continue;
        for (const m of (s.author && s.author.members) || []) {
          if (!m.handle) continue;
          let c = counts.get(m.handle);
          if (!c) { c = {}; counts.set(m.handle, c); }
          c[fam] = (c[fam] || 0) + 1;
        }
      }
      const byHandle = new Map();
      const obj = {};
      counts.forEach((c, handle) => {
        let best = null, bestN = -1, total = 0, distinct = 0;
        for (const f in c) { total += c[f]; distinct++; if (c[f] > bestN) { bestN = c[f]; best = f; } }
        // If clearly mixed (top family < half), label as mixed for honesty.
        const fam = (distinct > 1 && bestN < total / 2) ? "mixed" : best;
        byHandle.set(handle, fam);
        obj[handle] = fam;
      });
      await C.set({ [LANG_KEY]: { contestId: id, ts: Date.now(), byHandle: obj } });
      langByHandle = byHandle;
    } catch (e) {
      langByHandle = rec && rec.byHandle ? new Map(Object.entries(rec.byHandle)) : new Map();
    }
    return langByHandle;
  }

  // ── friends: merge CF's "Friends standings" scrape + user-maintained list ────
  async function loadStoredFriends() {
    const stored = await C.get([FRIENDS_KEY]);
    const rec = stored[FRIENDS_KEY];
    return new Set((rec && rec.handles) || []);
  }
  async function saveStoredFriends(set) {
    await C.set({ [FRIENDS_KEY]: { handles: [...set] } });
  }
  // Scrape handles CF shows when its own "Friends" standings view is active.
  // CF marks the friends view via the URL/link; when active the table only lists
  // friends, so every rated-user handle in the body is a friend.
  function scrapeFriendsView() {
    const out = new Set();
    // CF's "Show: Friends" toggle puts ?...&showUnofficial.. — but the reliable
    // signal is the standings being in friends mode: the "Friends standings"
    // link has class participated/highlight, or the URL contains 'friends'.
    const inFriendsMode = /friends/i.test(location.search) ||
      !!document.querySelector('a.view-source, a[href*="friends"][class~="current"], .second-level-menu-list a[href*="friends"].current');
    if (!inFriendsMode) return out;
    document.querySelectorAll("table.standings tbody tr a.rated-user, table.standings tr a[href*='/profile/']").forEach((a) => {
      const h = a.textContent.trim();
      if (h) out.add(h);
    });
    return out;
  }
  async function effectiveFriends() {
    const stored = await loadStoredFriends();
    const scraped = scrapeFriendsView();
    scraped.forEach((h) => stored.add(h));
    return stored;
  }

  // ── standings row helpers ───────────────────────────────────────────────────
  function bodyRows() {
    const table = document.querySelector("table.standings");
    if (!table) return [];
    return [...table.querySelectorAll("tr")].filter((tr) => !tr.querySelector("th") && rowHandle(tr));
  }
  function rowHandle(tr) {
    const a = tr.querySelector("a.rated-user, a[href*='/profile/']");
    return a ? a.textContent.trim() : null;
  }

  // ── language coloring ───────────────────────────────────────────────────────
  function colorRows(map) {
    presentFamilies = new Set();
    for (const tr of bodyRows()) {
      const h = rowHandle(tr);
      const fam = h && map.get(h);
      tr.setAttribute(ROW_ATTR, "1");
      if (fam) {
        tr.setAttribute(LANG_ATTR, fam);
        presentFamilies.add(fam);
      } else {
        tr.removeAttribute(LANG_ATTR);
      }
    }
  }
  function clearRows() {
    document.querySelectorAll("[" + ROW_ATTR + "]").forEach((tr) => {
      tr.removeAttribute(ROW_ATTR);
      tr.removeAttribute(LANG_ATTR);
      tr.classList.remove("cpos-st-hidden");
    });
  }

  // ── friends-only filter ─────────────────────────────────────────────────────
  let friendsOnly = false;
  let friendsSet = new Set();
  function applyFriendsFilter() {
    for (const tr of bodyRows()) {
      const h = rowHandle(tr);
      const hide = friendsOnly && !(h && friendsSet.has(h));
      tr.classList.toggle("cpos-st-hidden", hide);
    }
    const btn = document.querySelector("#" + ROOT_ID + " .cpos-st-friends-toggle");
    if (btn) {
      btn.classList.toggle("on", friendsOnly);
      btn.setAttribute("aria-pressed", String(friendsOnly));
      const lbl = btn.querySelector(".cpos-st-friends-lbl");
      if (lbl) lbl.innerHTML = "Friends only" + (friendsOnly ? " " + SVG_CHECK : "");
    }
  }
  function clearFilter() {
    document.querySelectorAll("tr.cpos-st-hidden").forEach((tr) => tr.classList.remove("cpos-st-hidden"));
  }

  // ── control panel (legend + friends toggle + friends editor) ────────────────
  function buildPanel() {
    let root = document.getElementById(ROOT_ID);
    if (root) root.remove();
    root = el("div", "cpos-standings-tools strip");
    root.id = ROOT_ID;

    root.appendChild(el("span", "cpos-st-head", '<span class="badge">CPOS</span>'));

    // Language legend (only families actually present).
    const legend = el("span", "cpos-st-legend");
    const fams = LANG_FAMILIES.filter((f) => presentFamilies && presentFamilies.has(f.id));
    if (presentFamilies && presentFamilies.has("mixed")) fams.push({ id: "mixed", label: "Mixed" });
    if (fams.length) {
      legend.appendChild(el("span", "cpos-st-lbl", "Language:"));
      for (const f of fams) {
        const chip = el("span", "cpos-st-legend-item");
        chip.setAttribute(LANG_ATTR, f.id);
        chip.innerHTML = '<span class="cpos-st-swatch"></span>' + esc(f.label);
        legend.appendChild(chip);
      }
    } else {
      legend.appendChild(el("span", "cpos-st-lbl",
        "Language data unavailable — open the contest standings while logged in to populate."));
    }
    root.appendChild(legend);

    // Friends-only toggle.
    const fbtn = el("button", "cpos-st-btn ghost cpos-st-friends-toggle",
      '<span class="cpos-st-friends-lbl">Friends only</span>');
    fbtn.type = "button";
    fbtn.setAttribute("aria-pressed", "false");
    fbtn.addEventListener("click", () => { friendsOnly = !friendsOnly; applyFriendsFilter(); });
    root.appendChild(fbtn);

    // Friends count + edit affordance.
    const count = el("span", "cpos-st-friends-count",
      friendsSet.size ? friendsSet.size + " friend" + (friendsSet.size === 1 ? "" : "s") : "no friends set");
    root.appendChild(count);

    const edit = el("button", "cpos-st-btn ghost", "Edit list");
    edit.type = "button";
    edit.addEventListener("click", () => toggleEditor(root));
    root.appendChild(edit);

    // Insert above the standings table.
    const table = document.querySelector("table.standings");
    const anchor = table ? (table.closest(".datatable") || table) : null;
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(root, anchor);
    else (document.querySelector("#pageContent") || document.body).prepend(root);
    applyTheme(root);
  }

  function toggleEditor(root) {
    let ed = root.querySelector(".cpos-st-editor");
    if (ed) { ed.remove(); return; }
    ed = el("div", "cpos-st-editor");
    ed.innerHTML =
      '<label class="cpos-st-ed-lbl">Friends (comma/space separated handles). Auto-merged with CF\'s Friends view when available.</label>';
    const ta = el("textarea", "cpos-st-ta");
    ta.value = [...friendsSet].join(", ");
    ta.spellcheck = false;
    ed.appendChild(ta);
    const save = el("button", "cpos-st-btn", "Save");
    save.type = "button";
    save.addEventListener("click", async () => {
      const handles = ta.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      const set = new Set(handles);
      await saveStoredFriends(set);
      // Re-merge with any scraped friends and refresh.
      friendsSet = await effectiveFriends();
      buildPanel();
      applyFriendsFilter();
    });
    ed.appendChild(save);
    root.appendChild(ed);
    applyTheme(root);
  }

  // ── theming ─────────────────────────────────────────────────────────────────
  // Language tints aren't descendants of the panel, so we publish per-family
  // colors as :root custom props derived from the active theme tokens, keeping
  // everything flat (solid color-mix tints in CSS, no gradients).
  async function applyTheme(node) {
    if (!T || !C) return;
    const id = await (C.activePageThemeId ? C.activePageThemeId() : C.activeThemeId());
    if (node) T.applyTheme(node, id);
    const tk = T.get(id);
    const root = document.documentElement.style;
    // Map families onto theme tokens (reuse the palette, no new hardcoded hues).
    const m = {
      "--cpos-lang-cpp": tk["--cf"],
      "--cpos-lang-python": tk["--warn"],
      "--cpos-lang-java": tk["--bad"],
      "--cpos-lang-kotlin": tk["--accent"],
      "--cpos-lang-rust": tk["--accent-dim"],
      "--cpos-lang-go": tk["--ok"],
      "--cpos-lang-csharp": tk["--accent"],
      "--cpos-lang-c": tk["--dim"],
      "--cpos-lang-js": tk["--warn"],
      "--cpos-lang-other": tk["--dim"],
      "--cpos-lang-mixed": tk["--accent-dim"]
    };
    for (const k in m) root.setProperty(k, m[k]);
  }
  function clearTokens() {
    const root = document.documentElement.style;
    ["cpp", "python", "java", "kotlin", "rust", "go", "csharp", "c", "js", "other", "mixed"]
      .forEach((f) => root.removeProperty("--cpos-lang-" + f));
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────
  let observer = null;
  let lastMap = null;

  async function buildAll() {
    const id = contestId();
    if (!id) return;
    friendsSet = await effectiveFriends();
    const map = await loadLangs(id);
    lastMap = map;
    colorRows(map);
    buildPanel();
    applyFriendsFilter();

    if (!observer) {
      observer = new MutationObserver(() => {
        if (!document.getElementById(ROOT_ID)) return;
        if (lastMap) colorRows(lastMap);
        applyFriendsFilter();
      });
      const tbl = document.querySelector("table.standings");
      if (tbl) observer.observe(tbl, { childList: true, subtree: true });
    }
  }

  function remove() {
    observer?.disconnect();
    observer = null;
    document.getElementById(ROOT_ID)?.remove();
    clearRows();
    clearFilter();
    clearTokens();
  }

  async function sync() {
    const on = await C.feature(FEATURE);
    if (on) buildAll().catch((e) => console.debug("CPOS standingsTools:", e));
    else remove();
  }

  C.onChange((changes) => {
    if (changes[C.KEYS.FEATURES]) sync();
    else { const root = document.getElementById(ROOT_ID); if (root) applyTheme(root); }
  });
  if (document.body) sync();
  else document.addEventListener("DOMContentLoaded", () => sync());
})();
