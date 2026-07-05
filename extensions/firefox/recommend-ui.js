// Recommend tab — queries the central CPOS practice engine over localhost
// (GET http://127.0.0.1:27121/recommend). The terminal app owns the synced
// history (submissions, ratings, contests) and runs the same engine that
// powers its own Practice tab, so both surfaces always agree.
(function () {
  const mount = document.getElementById("cpos-recommend-section");
  if (!mount) return;

  // Only the terminal app has the SQLite history; the VS Code runner doesn't.
  const ENGINE = "http://127.0.0.1:27121";
  const PARAMS_KEY = "cpos.recommend.params";

  const MODES = [
    ["auto", "Auto", "balanced: learning zone + weak topics + fresh problems"],
    ["weakness", "Weakness", "attack the tags where your skill lags your level"],
    ["push", "Push", "above your ceiling, on your strongest topics"],
    ["refresh", "Refresh", "topics you knew but haven't touched lately"],
    ["upsolve", "Upsolve", "problems you attempted but never got accepted — finish them"],
    ["explore", "Explore", "core topics you've never solved"],
    ["plan", "Plan", "rung-by-rung curriculum toward your goal"]
  ];
  const CF_TAGS = [
    "implementation", "brute force", "math", "greedy", "sortings",
    "constructive algorithms", "binary search", "two pointers", "strings",
    "number theory", "dp", "dfs and similar", "graphs", "dsu", "bitmasks",
    "combinatorics", "trees", "data structures", "shortest paths", "hashing",
    "divide and conquer", "probabilities", "geometry", "games", "flows"
  ];

  const sget = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v || {})));
  const sset = (o) => new Promise((r) => chrome.storage.local.set(o, () => r()));

  // CF tier color — same breakpoints as profile.js/practice-ui.js.
  function tierColor(r) {
    const n = Number(r);
    if (r == null || !Number.isFinite(n)) return "var(--dim)";
    if (n < 1200) return "#9aa0a6";
    if (n < 1400) return "#42c267";
    if (n < 1600) return "#41b5b3";
    if (n < 1900) return "#7aa2f7";
    if (n < 2100) return "#c77dff";
    if (n < 2400) return "#f0a13e";
    return "#ff5b5b";
  }
  function ratingPillStyle(r) {
    const c = tierColor(r);
    return "color:" + c +
      ";border-color:color-mix(in srgb," + c + " 40%,transparent)" +
      ";background:color-mix(in srgb," + c + " 14%,transparent)";
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function problemUrl(p) {
    if (p.url) return p.url;
    const m = String(p.id || "").match(/^(\d+)(.*)$/);
    return m ? `https://codeforces.com/problemset/problem/${m[1]}/${m[2]}` : "https://codeforces.com/problemset";
  }

  let params = {
    mode: "auto",
    tags: "",
    min: "",
    max: "",
    year: "",
    count: 15
  };
  let lastReport = null;
  let lastError = null;
  let loading = false;

  function queryString() {
    const parts = [`mode=${encodeURIComponent(params.mode)}`, `count=${encodeURIComponent(params.count)}`];
    if (params.tags.trim()) parts.push(`tags=${encodeURIComponent(params.tags.trim())}`);
    if (params.min) parts.push(`min=${encodeURIComponent(params.min)}`);
    if (params.max) parts.push(`max=${encodeURIComponent(params.max)}`);
    if (params.year) parts.push(`year=${encodeURIComponent(params.year)}`);
    return parts.join("&");
  }

  async function fetchRecs() {
    loading = true;
    lastError = null;
    render();
    try {
      const res = await fetch(`${ENGINE}/recommend?${queryString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error("engine returned " + res.status);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "engine error");
      lastReport = data;
    } catch (e) {
      lastReport = null;
      lastError = /Failed to fetch|NetworkError|load failed/i.test(String(e && e.message))
        ? "offline"
        : String(e && e.message ? e.message : e);
    } finally {
      loading = false;
      render();
    }
  }

  function controlsHtml() {
    const modeOpts = MODES.map(([id, label]) =>
      `<option value="${id}" ${params.mode === id ? "selected" : ""}>${label}</option>`).join("");
    const ratingOpts = (sel) => ['<option value="">any</option>']
      .concat(Array.from({ length: 28 }, (_, i) => 800 + i * 100)
        .map((r) => `<option value="${r}" ${String(sel) === String(r) ? "selected" : ""}>${r}</option>`))
      .join("");
    const now = new Date().getFullYear();
    const yearOpts = [["", "any age"], [now - 1, `fresh (${now - 1}+)`], [now - 3, `recent (${now - 3}+)`], [now - 6, `${now - 6}+`]]
      .map(([v, l]) => `<option value="${v}" ${String(params.year) === String(v) ? "selected" : ""}>${l}</option>`).join("");
    const activeDesc = (MODES.find((m) => m[0] === params.mode) || MODES[0])[2];
    return `
      <div class="cpos-rec-controls">
        <div class="cpos-rec-row">
          <select id="cpos-rec-mode" title="Recommendation mode">${modeOpts}</select>
          <select id="cpos-rec-year" title="Problem freshness">${yearOpts}</select>
          <select id="cpos-rec-count" title="How many">
            ${[10, 15, 25, 40].map((n) => `<option value="${n}" ${params.count === n ? "selected" : ""}>${n}</option>`).join("")}
          </select>
        </div>
        <div class="cpos-rec-modedesc">${esc(activeDesc)}</div>
        <div class="cpos-rec-row">
          <input id="cpos-rec-tags" type="text" list="cpos-rec-taglist" placeholder="tags: dp, graphs… (empty = all)" value="${esc(params.tags)}" autocomplete="off" spellcheck="false">
          <datalist id="cpos-rec-taglist">${CF_TAGS.map((t) => `<option value="${t}">`).join("")}</datalist>
        </div>
        <div class="cpos-rec-row">
          <label>rating <select id="cpos-rec-min" title="Min rating">${ratingOpts(params.min)}</select></label>
          <span class="cpos-rec-dash">–</span>
          <select id="cpos-rec-max" title="Max rating">${ratingOpts(params.max)}</select>
          <span class="cpos-rec-grow"></span>
          <button id="cpos-rec-go" class="cpos-rec-primary">${loading ? "…" : "Recommend"}</button>
        </div>
      </div>`;
  }

  function summaryHtml(s) {
    if (!s) return "";
    const chips = [];
    chips.push(`<span class="cpos-rec-chip">level ≈<b>${esc(s.level)}</b></span>`);
    if (s.official_rating != null) chips.push(`<span class="cpos-rec-chip">rated <b>${esc(s.official_rating)}</b></span>`);
    chips.push(`<span class="cpos-rec-chip">goal <b>${esc(s.goal)}</b> ${esc(s.goal_rank)}</span>`);
    if (s.readiness_pct != null) chips.push(`<span class="cpos-rec-chip">readiness <b>${esc(s.readiness_pct)}%</b></span>`);
    const weak = (s.weak_tags || []).slice(0, 4)
      .map((t) => `<span class="cpos-rec-weak" title="skill ≈${esc(t.skill)}">${esc(t.tag)}</span>`).join("");
    return `<div class="cpos-rec-summary">${chips.join("")}${weak ? `<div class="cpos-rec-weakrow">weak: ${weak}</div>` : ""}</div>`;
  }

  function listHtml(recs) {
    if (!recs.length) {
      return `<div class="cpos-rec-empty">No matches — loosen the filters or switch mode.</div>`;
    }
    return `<div class="cpos-rec-list">` + recs.map((r) => {
      const p = r.problem || {};
      const reasons = (r.reasons || []).map(esc).join(" · ");
      const tags = (p.tags || []).slice(0, 3).map(esc).join(", ");
      return `
        <div class="cpos-rec-item">
          <div class="cpos-rec-line1">
            <span class="cpos-rec-pill" style="${ratingPillStyle(p.rating)}">${esc(p.rating ?? "—")}</span>
            <a class="cpos-rec-link" href="${esc(problemUrl(p))}" target="_blank" rel="noopener">${esc(p.id)} · ${esc(p.name)}</a>
            ${r.year ? `<span class="cpos-rec-year">${esc(r.year)}</span>` : ""}
          </div>
          <div class="cpos-rec-why">${reasons}</div>
          ${tags ? `<div class="cpos-rec-tags">${tags}</div>` : ""}
        </div>`;
    }).join("") + `</div>`;
  }

  function render() {
    let body = "";
    if (loading && !lastReport) {
      body = `<div class="cpos-rec-empty">Asking the engine…</div>`;
    } else if (lastError === "offline") {
      body = `
        <div class="cpos-rec-offline">
          <b>CPOS terminal app is not running.</b>
          <p>Recommendations come from your synced solve history, which lives in the terminal app. Start <code>cpos</code>, press <code>r</code> to sync, then retry.</p>
          <button id="cpos-rec-retry">Retry</button>
        </div>`;
    } else if (lastError) {
      body = `<div class="cpos-rec-offline"><b>Engine error:</b> ${esc(lastError)} <button id="cpos-rec-retry">Retry</button></div>`;
    } else if (lastReport) {
      body = summaryHtml(lastReport.summary) + listHtml(lastReport.recs || []);
    } else {
      body = `<div class="cpos-rec-empty">Pick a mode and hit <b>Recommend</b>.</div>`;
    }
    mount.innerHTML = controlsHtml() + body;
    wire();
  }

  function readControls() {
    params.mode = document.getElementById("cpos-rec-mode")?.value || "auto";
    params.tags = document.getElementById("cpos-rec-tags")?.value || "";
    params.min = document.getElementById("cpos-rec-min")?.value || "";
    params.max = document.getElementById("cpos-rec-max")?.value || "";
    params.year = document.getElementById("cpos-rec-year")?.value || "";
    params.count = Number(document.getElementById("cpos-rec-count")?.value || 15);
    void sset({ [PARAMS_KEY]: params });
  }

  function wire() {
    const go = document.getElementById("cpos-rec-go");
    if (go) go.onclick = () => { readControls(); void fetchRecs(); };
    const retry = document.getElementById("cpos-rec-retry");
    if (retry) retry.onclick = () => void fetchRecs();
    const tags = document.getElementById("cpos-rec-tags");
    if (tags) tags.onkeydown = (e) => { if (e.key === "Enter") { readControls(); void fetchRecs(); } };
    // Mode change refreshes immediately — it's the primary control.
    const mode = document.getElementById("cpos-rec-mode");
    if (mode) mode.onchange = () => { readControls(); render(); void fetchRecs(); };
  }

  (async () => {
    const stored = await sget([PARAMS_KEY]);
    if (stored[PARAMS_KEY]) params = Object.assign(params, stored[PARAMS_KEY]);
    render();
    void fetchRecs(); // eager: it's local and instant when the TUI is up
  })();
})();
