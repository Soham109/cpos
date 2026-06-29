// CPOS problemset tools — augments the Codeforces problemset list (/problemset*)
// and contest problem lists with solve-status awareness CF itself only shows in
// a limited way. All additive and theme-aware:
//   · SOLVE-STATUS row coloring — solved / attempted-unsolved / untouched, from
//     the logged-in handle (scraped from the page header) + user.status (cached).
//     Uses --ok / --warn tokens as a subtle row tint; CF's own styling is kept.
//   · per-problem solved-count column.
// Read-only: fetches the public CF API. Never touches capture/submit. Degrades
// gracefully when not logged in or the API is unreachable. Toggle from the CPOS
// popup (feature "problemsetTools").
(function () {
  const T = self.CPOS_THEMES;
  const C = self.CPOS;
  if (!C) return;

  const FEATURE = "problemsetTools";
  const STATUS_KEY = "cpos.cf.status";   // { handle, ts, solved:[keys], attempted:[keys] }
  const STATUS_TTL = 10 * 60 * 1000;     // 10 min — submissions change often
  const STATS_KEY = "cpos.problemset.stats"; // { ts, counts:{ "id-IDX": solvedCount } }
  const STATS_TTL = 6 * 60 * 60 * 1000;  // 6 h — solvedCount drifts slowly
  const ROW_ATTR = "data-cpos-cf-row";
  const COUNT_CELL = "cpos-cf-count-cell"; // injected solvedCount column cells/header

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function onProblemset() { return /^\/problemset(\/|$)/.test(location.pathname); }
  function onContestList() { return /^\/(?:contest|gym)\/\d+(\/|$)?$/.test(location.pathname); }

  async function cfApi(method, qs) {
    const res = await fetch(`https://codeforces.com/api/${method}?${qs}`, { cache: "no-store" });
    if (!res.ok) throw new Error(method + " HTTP " + res.status);
    const json = await res.json();
    if (json.status !== "OK") throw new Error(json.comment || method + " failed");
    return json.result;
  }

  // Logged-in handle from the header (top-right link to /profile/<handle>).
  function loggedInHandle() {
    const link = document.querySelector('#header a[href^="/profile/"], .lang-chooser a[href^="/profile/"], a.personal-sidebar[href^="/profile/"]');
    if (link) { const m = link.getAttribute("href").match(/\/profile\/([^/?#]+)/); if (m) return decodeURIComponent(m[1]); }
    // Fallback: any header profile link.
    const any = [...document.querySelectorAll('a[href^="/profile/"]')].find((a) => a.closest("#header, .lang-chooser"));
    if (any) { const m = any.getAttribute("href").match(/\/profile\/([^/?#]+)/); if (m) return decodeURIComponent(m[1]); }
    return null;
  }

  // ── status sets: distinct "contestId-INDEX" keys for solved + attempted ─────
  let statusSets = null; // { solved:Set, attempted:Set, handle }
  async function loadStatus(handle) {
    if (statusSets && statusSets.handle === handle) return statusSets;
    const stored = await C.get([STATUS_KEY]);
    const rec = stored[STATUS_KEY];
    if (rec && rec.handle === handle && (Date.now() - (rec.ts || 0) < STATUS_TTL)) {
      statusSets = { handle, solved: new Set(rec.solved), attempted: new Set(rec.attempted) };
      return statusSets;
    }
    try {
      const subs = await cfApi("user.status", "handle=" + encodeURIComponent(handle) + "&from=1&count=100000");
      const solved = new Set(), attempted = new Set();
      for (const s of subs) {
        const p = s.problem || {};
        if (p.contestId == null || !p.index) continue;
        const key = p.contestId + "-" + String(p.index).toUpperCase();
        attempted.add(key);
        if (s.verdict === "OK") solved.add(key);
      }
      await C.set({ [STATUS_KEY]: { handle, ts: Date.now(), solved: [...solved], attempted: [...attempted] } });
      statusSets = { handle, solved, attempted };
    } catch (e) {
      if (rec && rec.handle === handle) statusSets = { handle, solved: new Set(rec.solved), attempted: new Set(rec.attempted) };
      else statusSets = { handle, solved: new Set(), attempted: new Set() };
    }
    return statusSets;
  }

  // ── per-problem submission count (solvedCount) from problemset.problems ──────
  // problemset.problems returns { problems[], problemStatistics[] }; the latter
  // gives solvedCount per (contestId, index). Cached long since it drifts slowly.
  let statsMap = null; // Map "id-IDX" -> solvedCount
  async function loadStats() {
    if (statsMap) return statsMap;
    const stored = await C.get([STATS_KEY]);
    const rec = stored[STATS_KEY];
    if (rec && rec.counts && (Date.now() - (rec.ts || 0) < STATS_TTL)) {
      statsMap = new Map(Object.entries(rec.counts));
      return statsMap;
    }
    try {
      const result = await cfApi("problemset.problems", "");
      const m = new Map();
      for (const ps of (result.problemStatistics || [])) {
        if (ps.contestId == null || !ps.index) continue;
        m.set(ps.contestId + "-" + String(ps.index).toUpperCase(), ps.solvedCount || 0);
      }
      const counts = {}; m.forEach((v, k) => { counts[k] = v; });
      await C.set({ [STATS_KEY]: { ts: Date.now(), counts } });
      statsMap = m;
    } catch (e) {
      statsMap = rec && rec.counts ? new Map(Object.entries(rec.counts)) : new Map();
    }
    return statsMap;
  }

  function fmtCount(n) {
    if (n == null) return "";
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return String(n);
  }

  // ── parse a problem key + rating out of a table row ─────────────────────────
  // Works for the problemset table and contest problem tables (both .problems).
  function rowKey(tr) {
    // Any cell link to /problemset/problem/<id>/<idx> or /contest|gym/<id>/problem/<idx>.
    const a = tr.querySelector('a[href*="/problem/"]');
    if (!a) return null;
    const href = a.getAttribute("href") || "";
    let m = href.match(/\/problemset\/problem\/(\d+)\/([^/?#]+)/) ||
            href.match(/\/(?:contest|gym)\/(\d+)\/problem\/([^/?#]+)/);
    if (!m) return null;
    return m[1] + "-" + decodeURIComponent(m[2]).toUpperCase();
  }
  function problemRows() {
    // CF problemset + contest problem lists both use table.problems.
    const tables = document.querySelectorAll("table.problems");
    const rows = [];
    tables.forEach((t) => t.querySelectorAll("tr").forEach((tr) => {
      if (tr.querySelector("th")) return;
      if (rowKey(tr)) rows.push(tr);
    }));
    return rows;
  }

  // ── apply / clear row tints ─────────────────────────────────────────────────
  function colorRows(sets) {
    let solved = 0, attempted = 0, total = 0;
    for (const tr of problemRows()) {
      const key = rowKey(tr);
      if (!key) continue;
      total++;
      tr.setAttribute(ROW_ATTR, "1");
      tr.classList.remove("cpos-cf-solved", "cpos-cf-attempted");
      if (sets.solved.has(key)) { tr.classList.add("cpos-cf-solved"); solved++; }
      else if (sets.attempted.has(key)) { tr.classList.add("cpos-cf-attempted"); attempted++; }
    }
    return { solved, attempted, total };
  }
  function clearRows() {
    document.querySelectorAll("[" + ROW_ATTR + "]").forEach((tr) => {
      tr.classList.remove("cpos-cf-solved", "cpos-cf-attempted");
      tr.removeAttribute(ROW_ATTR);
    });
  }

  // ── per-problem submission-count column ─────────────────────────────────────
  // Adds a tidy "Solved" count cell to each problems table (header + rows),
  // robust to old (m1/m2/m3) and modern CF DOM by appending a new last cell.
  function injectCounts(stats) {
    if (!stats) return;
    document.querySelectorAll("table.problems").forEach((table) => {
      const headRow = [...table.querySelectorAll("tr")].find((tr) => tr.querySelector("th"));
      if (headRow && !headRow.querySelector("." + COUNT_CELL)) {
        const th = document.createElement("th");
        th.className = COUNT_CELL;
        th.title = "Number of users who solved the problem (CPOS)";
        th.textContent = "Solved";
        headRow.appendChild(th);
      }
      table.querySelectorAll("tr").forEach((tr) => {
        if (tr.querySelector("th")) return;
        const key = rowKey(tr);
        if (!key) return;
        let cell = tr.querySelector("." + COUNT_CELL);
        const n = stats.get(key);
        const html = n == null ? '<span class="cpos-cf-count dim" title="No solve-count data">—</span>'
          : '<span class="cpos-cf-count" title="' + n + ' solved">' + esc(fmtCount(n)) + "</span>";
        if (!cell) { cell = document.createElement("td"); cell.className = COUNT_CELL; tr.appendChild(cell); }
        if (cell.innerHTML !== html) cell.innerHTML = html;
      });
    });
  }
  function clearCounts() {
    document.querySelectorAll("." + COUNT_CELL).forEach((e) => e.remove());
  }

  async function applyTheme(node) {
    if (!T || !C) return;
    const id = await (C.activePageThemeId ? C.activePageThemeId() : C.activeThemeId());
    if (node) T.applyTheme(node, id);
    // Mirror --ok/--warn onto :root so the row tints (not descendants of the
    // strip) track the active palette. CSS reads --cpos-row-ok / --cpos-row-warn.
    const tokens = T.get(id);
    document.documentElement.style.setProperty("--cpos-row-ok", tokens["--ok"]);
    document.documentElement.style.setProperty("--cpos-row-warn", tokens["--warn"]);
    document.documentElement.style.setProperty("--cpos-row-bg", tokens["--panel"]);
  }
  function clearRowTokens() {
    document.documentElement.style.removeProperty("--cpos-row-ok");
    document.documentElement.style.removeProperty("--cpos-row-warn");
    document.documentElement.style.removeProperty("--cpos-row-bg");
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────
  let observer = null;
  let lastSets = null;

  let lastStats = null;

  async function buildAll() {
    if (!(onProblemset() || onContestList())) return;
    const handle = loggedInHandle();
    let sets = null;
    if (handle) {
      sets = await loadStatus(handle);
      lastSets = sets;
      colorRows(sets);
    }
    await applyTheme();

    // Submission counts are independent of login.
    loadStats().then((m) => { lastStats = m; injectCounts(m); }).catch(() => {});

    if (!observer) {
      observer = new MutationObserver(() => {
        if (lastSets) colorRows(lastSets);
        if (lastStats) injectCounts(lastStats);
      });
      const tbl = document.querySelector("table.problems");
      if (tbl) observer.observe(tbl, { childList: true, subtree: true });
    }
  }

  function remove() {
    observer?.disconnect();
    observer = null;
    clearRows();
    clearCounts();
    clearRowTokens();
  }

  async function sync() {
    const on = await C.feature(FEATURE);
    if (on) buildAll().catch((e) => console.debug("CPOS problemsetTools:", e));
    else remove();
  }

  C.onChange((changes) => {
    if (changes[C.KEYS.FEATURES]) sync();
    else applyTheme();
  });
  if (document.body) sync();
  else document.addEventListener("DOMContentLoaded", () => sync());
})();
