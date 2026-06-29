// CPOS problem tools — augments individual Codeforces problem pages
// (/problemset/problem/*, /contest/*/problem/*, /gym/*/problem/*) with helpers
// that CF itself does not provide, all additive and theme-aware:
//   · a tidy RATING badge near the title (from problemset.problems, cached in
//     chrome.storage.local with a timestamp so we don't refetch every page)
//   · a TAG HIDER / training mode — tags hidden by default behind a "Reveal"
//     control (reveal-all and reveal-one-by-one); rating can also be hidden
//     until clicked so practice isn't biased. The hidden/shown preference
//     persists in storage.
//   · a clearly-CPOS "Copy" button on every sample-test input block (classic
//     <pre> and the modern per-line .test-example-line format), never breaking
//     CF's own copier.
//   · a lightweight "similar problems" mini-list (same primary tag, ±100 rating).
//   · a focus-mode toggle that expands the statement and hides the right rail.
// Read-only: fetches the public CF API, augments the native Problem tags widget
// when it exists, and adds small per-block copy buttons. Never touches
// capture/submit. Toggle from the CPOS popup (feature "problemTools").
(function () {
  const ROOT_ID = "cpos-cf-tools";
  const T = self.CPOS_THEMES;
  const C = self.CPOS;
  if (!C) return;

  const FEATURE = "problemTools";
  const PREF_KEY = "cpos.cf.problemPrefs";        // { tagsHidden, ratingHidden, focusMode }
  const CACHE_KEY = "cpos.cf.problemset";         // { ts, problems: { "id-index": {rating,tags,name} } }
  const CACHE_TTL = 12 * 60 * 60 * 1000;          // 12h — problemset rarely changes

  // [minRating, title, color]. Mirrors Codeforces' tier palette (as in profile.js).
  const RANKS = [
    [0, "—", "#9aa0a6"], [800, "Newbie", "#9aa0a6"], [1200, "Pupil", "#42c267"],
    [1400, "Specialist", "#41b5b3"], [1600, "Expert", "#7aa2f7"], [1900, "Cand. Master", "#c77dff"],
    [2100, "Master", "#f0a13e"], [2300, "Int. Master", "#f0a13e"], [2400, "Grandmaster", "#ff5b5b"],
    [2600, "Int. GM", "#ff3333"], [3000, "Legendary GM", "#ff0000"]
  ];
  function ratingColor(r) {
    if (r == null) return "var(--dim)";
    let c = RANKS[0][2];
    for (const [thr, , col] of RANKS) if (r >= thr) c = col;
    return c;
  }
  // Rank/tier name for a rating (e.g. 1600 → "Expert"); "" when below the first named tier.
  function ratingRank(r) {
    if (r == null) return "";
    let name = "";
    for (const [thr, title] of RANKS) if (r >= thr && title !== "—") name = title;
    return name;
  }

  // Focus-toggle glyphs: outward arrows (expand) when off, inward (contract) when on.
  const FOCUS_OFF_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V3h4 M21 7V3h-4 M3 17v4h4 M21 17v4h-4"/></svg>';
  const FOCUS_ON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3v4H3 M17 3v4h4 M7 21v-4H3 M17 21v-4h4"/></svg>';

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  // ── identify the problem on this page ───────────────────────────────────────
  // Returns { contestId, index, key } or null. Handles problemset, contest, gym.
  function problemId() {
    const p = location.pathname;
    let m = p.match(/^\/problemset\/problem\/(\d+)\/([^/]+)/);
    if (m) return { contestId: Number(m[1]), index: decodeURIComponent(m[2]).toUpperCase(), key: m[1] + "-" + decodeURIComponent(m[2]).toUpperCase() };
    m = p.match(/^\/(?:contest|gym)\/(\d+)\/problem\/([^/]+)/);
    if (m) return { contestId: Number(m[1]), index: decodeURIComponent(m[2]).toUpperCase(), key: m[1] + "-" + decodeURIComponent(m[2]).toUpperCase() };
    return null;
  }

  async function cfApi(method, qs) {
    const res = await fetch(`https://codeforces.com/api/${method}?${qs}`, { cache: "no-store" });
    if (!res.ok) throw new Error(method + " HTTP " + res.status);
    const json = await res.json();
    if (json.status !== "OK") throw new Error(json.comment || method + " failed");
    return json.result;
  }

  // ── problemset cache: one big fetch, reused across all problem pages ─────────
  let psCache = null; // { byKey: Map, list: [{key,contestId,index,rating,tags,name}] }
  async function loadProblemset() {
    if (psCache) return psCache;
    const stored = await C.get([CACHE_KEY]);
    const rec = stored[CACHE_KEY];
    if (rec && rec.problems && (Date.now() - (rec.ts || 0) < CACHE_TTL)) {
      psCache = indexProblemset(rec.problems);
      return psCache;
    }
    try {
      const result = await cfApi("problemset.problems", "");
      const problems = {};
      for (const p of result.problems || []) {
        if (p.contestId == null || !p.index) continue;
        const key = p.contestId + "-" + String(p.index).toUpperCase();
        problems[key] = { rating: p.rating ?? null, tags: p.tags || [], name: p.name || "", contestId: p.contestId, index: String(p.index).toUpperCase() };
      }
      await C.set({ [CACHE_KEY]: { ts: Date.now(), problems } });
      psCache = indexProblemset(problems);
    } catch (e) {
      // Fall back to stale cache if we have one; otherwise no data.
      if (rec && rec.problems) psCache = indexProblemset(rec.problems);
      else psCache = { byKey: new Map(), list: [] };
    }
    return psCache;
  }
  function indexProblemset(problems) {
    const byKey = new Map();
    const list = [];
    for (const [key, p] of Object.entries(problems)) {
      const entry = Object.assign({ key }, p);
      byKey.set(key, entry);
      list.push(entry);
    }
    return { byKey, list };
  }

  // ── preferences (persisted) ─────────────────────────────────────────────────
  async function getPrefs() {
    const stored = await C.get([PREF_KEY]);
    const p = stored[PREF_KEY] || {};
    return {
      tagsHidden: p.tagsHidden !== false,
      ratingHidden: p.ratingHidden === true,
      focusMode: p.focusMode === true
    };
  }
  async function setPrefs(patch) {
    const cur = await getPrefs();
    await C.set({ [PREF_KEY]: Object.assign(cur, patch) });
  }

  // ── theme ───────────────────────────────────────────────────────────────────
  async function applyTheme(node) {
    if (!T || !C || !node) return;
    T.applyTheme(node, await (C.activePageThemeId ? C.activePageThemeId() : C.activeThemeId()));
  }

  // ── copy-sample-input buttons ───────────────────────────────────────────────
  // Modern CF renders inputs as a stack of <div class="test-example-line"> rows;
  // classic CF uses a single <pre>. We read whichever is present so the copied
  // text is exactly what would be submitted to a judge.
  function sampleInputText(inputDiv) {
    const pre = inputDiv.querySelector("pre");
    if (!pre) return "";
    const lines = pre.querySelectorAll(".test-example-line");
    if (lines.length) {
      // The very first .test-example-line is sometimes a header copy of the whole
      // block; CF marks per-row lines too. Use only rows that are themselves leaf
      // lines to avoid double-counting.
      const rows = [...lines].filter((l) => !l.querySelector(".test-example-line"));
      return rows.map((l) => l.textContent).join("\n").replace(/\n+$/, "");
    }
    return (pre.innerText || pre.textContent || "").replace(/\n+$/, "");
  }

  function addCopyButtons() {
    const inputs = document.querySelectorAll(".sample-test .input");
    inputs.forEach((inputDiv) => {
      const existing = inputDiv.querySelector(".cpos-cf-copy");
      if (inputDiv.querySelector(".input-output-copier")) {
        existing?.remove();
        return;
      }
      if (existing) return;
      const btn = el("button", "cpos-cf-copy", "Copy");
      btn.type = "button";
      btn.title = "Copy sample input (CPOS)";
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const text = sampleInputText(inputDiv);
        try {
          await navigator.clipboard.writeText(text);
          flash(btn, "Copied");
        } catch {
          // Fallback for clipboard-permission edge cases.
          const ta = el("textarea");
          ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
          document.body.appendChild(ta); ta.select();
          try { document.execCommand("copy"); flash(btn, "Copied"); } catch { flash(btn, "Failed"); }
          ta.remove();
        }
      });
      inputDiv.appendChild(btn);
      applyTheme(btn);
    });
  }
  function flash(btn, txt) {
    const prev = btn.textContent;
    btn.textContent = txt;
    btn.classList.add("ok");
    setTimeout(() => { btn.textContent = prev; btn.classList.remove("ok"); }, 1200);
  }
  function removeCopyButtons() {
    document.querySelectorAll(".cpos-cf-copy").forEach((b) => b.remove());
  }

  // ── the tools strip (rating + tags + reveal controls + similar) ─────────────
  function problemTagsBox() {
    return sideboxByCaption(/problem\s*tags/i);
  }

  function sideboxByCaption(pattern) {
    const boxes = [...document.querySelectorAll(".roundbox.sidebox, .roundbox")];
    return boxes.find((box) => pattern.test(box.querySelector(".caption")?.textContent || "")) || null;
  }

  function nativeTagBoxes() {
    const box = problemTagsBox();
    return [...(box || document).querySelectorAll(".tag-box")];
  }

  function similarHtml(ps, entry) {
    if (!entry || !ps || !ps.list.length || entry.rating == null || !entry.tags.length) return "";
    const primary = entry.tags[0];
    const pool = ps.list.filter((p) =>
      p.key !== entry.key && p.rating != null &&
      Math.abs(p.rating - entry.rating) <= 100 && p.tags.includes(primary));
    // closest rating first, cap to 6
    pool.sort((a, b) => Math.abs(a.rating - entry.rating) - Math.abs(b.rating - entry.rating));
    const picks = pool.slice(0, 6);
    if (!picks.length) return "";
    const items = picks.map((p) => {
      const url = "https://codeforces.com/problemset/problem/" + p.contestId + "/" + p.index;
      return '<a class="cpos-cf-sim-item" href="' + esc(url) + '">' +
        '<span class="r" style="color:' + ratingColor(p.rating) + '">' + p.rating + "</span>" +
        '<span class="n">' + esc(p.name || (p.contestId + p.index)) + "</span></a>";
    }).join("");
    return '<div class="cpos-cf-sim"><div class="cpos-cf-lbl">Similar · ' + esc(primary) + " ±100</div>" +
      '<div class="cpos-cf-sim-list">' + items + "</div></div>";
  }

  function button(cls, text, fn) {
    const b = el("button", cls, text);
    b.type = "button";
    b.addEventListener("click", fn);
    return b;
  }

  function renderTagControls(target, tags, prefs, fallback, ps, entry, showRevealedChips = true) {
    target.textContent = "";
    const chips = el("span", "cpos-cf-chips");
    const renderChips = (shown) => {
      chips.innerHTML = tags.slice(0, shown).map((t) => '<span class="cpos-cf-chip">' + esc(t) + "</span>").join("");
    };

    if (!tags.length) {
      target.appendChild(el("span", "cpos-cf-lbl", "No tags available"));
      return;
    }

    if (prefs.tagsHidden) {
      let shown = 0;
      const status = el("span", "cpos-cf-lbl", fallback ? "Tags hidden" : "Hidden for practice");
      const reveal = button("cpos-cf-btn", "Show all tags (" + tags.length + ")", async () => {
        await setPrefs({ tagsHidden: false });
        rerender();
      });
      const one = button("cpos-cf-btn ghost", "Show one tag", () => {
        if (shown >= tags.length) return;
        shown++;
        renderChips(shown);
        if (shown >= tags.length) one.disabled = true;
      });
      target.appendChild(status);
      target.appendChild(reveal);
      target.appendChild(one);
      target.appendChild(chips);
      return;
    }

    if (showRevealedChips) renderChips(tags.length);
    const hide = button("cpos-cf-btn ghost", "Hide tags for practice", async () => {
      await setPrefs({ tagsHidden: true });
      rerender();
    });
    if (showRevealedChips) target.appendChild(chips);
    else target.appendChild(el("span", "cpos-cf-lbl", "Tags shown"));
    target.appendChild(hide);

    const sim = similarHtml(ps, entry);
    if (sim) target.appendChild(el("div", "cpos-cf-sim-wrap", sim));
  }

  function renderRatingControls(target, rating, prefs) {
    target.textContent = "";
    target.appendChild(el("span", "cpos-cf-group-label", "Rating"));
    if (rating == null) {
      target.appendChild(el("span", "cpos-cf-badge dim", "n/a"));
      return;
    }
    if (prefs.ratingHidden) {
      const b = button("cpos-cf-badge hidden", "Show rating", async () => {
        await setPrefs({ ratingHidden: false });
        rerender();
      });
      target.appendChild(b);
      return;
    }
    const rankName = ratingRank(rating);
    const badge = el("span", "cpos-cf-badge", (rankName ? esc(rankName) + " " : "") + rating);
    badge.style.color = ratingColor(rating);
    badge.style.borderColor = ratingColor(rating);
    badge.setAttribute("aria-label", "Rating " + rating + (rankName ? " (" + rankName + ")" : ""));
    target.appendChild(badge);
  }

  function renderProblemTagsWidget(entry, prefs, ps) {
    const box = problemTagsBox();
    if (!box) return false;
    let panel = box.querySelector("#cpos-cf-tags-widget");
    if (!panel) {
      panel = el("div", "cpos-cf-tags-widget");
      panel.id = "cpos-cf-tags-widget";
      const caption = box.querySelector(".caption");
      if (caption && caption.parentNode === box) caption.insertAdjacentElement("afterend", panel);
      else box.prepend(panel);
    }
    panel.textContent = "";
    const ratingRow = el("div", "cpos-cf-minirow cpos-cf-rating-row");
    renderRatingControls(ratingRow, entry ? entry.rating : null, prefs);
    panel.appendChild(ratingRow);
    const tagRow = el("div", "cpos-cf-minirow cpos-cf-tag-row");
    renderTagControls(tagRow, entry ? entry.tags : [], prefs, false, ps, entry, nativeTagBoxes().length === 0);
    panel.appendChild(tagRow);
    applyTheme(panel);
    return true;
  }

  function fallbackAnchor() {
    return sideboxByCaption(/contest\s*materials/i) ||
      document.querySelector("#sidebar") ||
      document.querySelector(".sidebar") ||
      document.querySelector("#pageContent");
  }

  function buildTools(entry, prefs, ps) {
    let root = document.getElementById(ROOT_ID);
    if (root) root.remove();

    const rating = entry ? entry.rating : null;
    const tags = entry ? entry.tags : [];

    const tagsInSidebar = renderProblemTagsWidget(entry, prefs, ps);
    if (!tagsInSidebar) {
      root = el("div", "cpos-cf-tools cpos-cf-tools-side");
      root.id = ROOT_ID;

      const head = el("div", "cpos-cf-head", '<span class="badge">CPOS</span><span class="cpos-cf-lbl">Problem tools</span>');
      const ratingRow = el("div", "cpos-cf-minirow cpos-cf-rating-row");
      renderRatingControls(ratingRow, rating, prefs);
      const tagsWrap = el("div", "cpos-cf-minirow cpos-cf-tags");
      renderTagControls(tagsWrap, tags, prefs, true, ps, entry);
      root.appendChild(head);
      root.appendChild(ratingRow);
      root.appendChild(tagsWrap);

      const anchor = fallbackAnchor();
      if (anchor?.matches?.(".roundbox")) anchor.parentNode.insertBefore(root, anchor);
      else if (anchor && anchor.firstChild) anchor.insertBefore(root, anchor.firstChild);
      else (document.querySelector("#pageContent") || document.body).prepend(root);
      applyTheme(root);
    }

    // Hide CF's own native tags while training mode keeps ours hidden.
    setNativeTagsHidden(prefs.tagsHidden);
  }

  function statementHeader() {
    return document.querySelector(".problem-statement .header") ||
      document.querySelector(".problem-statement") ||
      document.querySelector("#pageContent");
  }

  function renderFocusToggle(on) {
    const anchor = statementHeader();
    if (!anchor) return;
    document.querySelectorAll(".cpos-cf-focus-anchor").forEach((node) => {
      if (node !== anchor) node.classList.remove("cpos-cf-focus-anchor");
    });
    anchor.classList.add("cpos-cf-focus-anchor");
    let btn = document.getElementById("cpos-cf-focus-toggle");
    if (!btn) {
      btn = el("button", "cpos-cf-focus-toggle");
      btn.id = "cpos-cf-focus-toggle";
      btn.type = "button";
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const cur = await getPrefs();
        await setPrefs({ focusMode: !cur.focusMode });
        sync();
      });
      anchor.appendChild(btn);
    } else if (btn.parentElement !== anchor) {
      anchor.appendChild(btn);
    }
    btn.innerHTML = on ? FOCUS_ON_SVG : FOCUS_OFF_SVG;
    btn.title = on ? "Exit focus mode" : "Focus problem";
    btn.setAttribute("aria-label", btn.title);
    btn.classList.toggle("on", !!on);
    applyTheme(btn);
  }

  function applyFocusMode(on) {
    document.documentElement.classList.toggle("cpos-cf-focus", !!on);
  }

  function setNativeTagsHidden(hidden) {
    nativeTagBoxes().forEach((tb) => { tb.style.display = hidden ? "none" : ""; });
  }

  // re-render the strip from current prefs without refetching the problemset.
  let lastEntry = null, lastPs = null;
  async function rerender() {
    const prefs = await getPrefs();
    if (!document.body) return;
    if (await C.feature(FEATURE)) buildTools(lastEntry, prefs, lastPs);
    renderFocusToggle(prefs.focusMode);
    applyFocusMode(prefs.focusMode);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────
  let observer = null;
  async function buildAll() {
    const id = problemId();
    if (!id) return;
    const prefs = await getPrefs();
    const ps = await loadProblemset();
    lastPs = ps;
    lastEntry = ps.byKey.get(id.key) || null;
    buildTools(lastEntry, prefs, ps);
    addCopyButtons();
    // Watch for late-rendered sample blocks (CF sometimes hydrates them).
    if (!observer) {
      observer = new MutationObserver(() => {
        if (!document.getElementById(ROOT_ID) && !document.getElementById("cpos-cf-tags-widget")) return;
        addCopyButtons();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function removeTools() {
    observer?.disconnect();
    observer = null;
    document.getElementById(ROOT_ID)?.remove();
    document.getElementById("cpos-cf-tags-widget")?.remove();
    removeCopyButtons();
    setNativeTagsHidden(false);
  }

  async function sync() {
    const id = problemId();
    if (!id) return;
    const prefs = await getPrefs();
    renderFocusToggle(prefs.focusMode);
    applyFocusMode(prefs.focusMode);
    const on = await C.feature(FEATURE);
    if (on) buildAll().catch((e) => console.debug("CPOS problemTools:", e));
    else removeTools();
  }

  C.onChange((changes) => {
    if (changes[C.KEYS.FEATURES]) sync();
    else {
      const root = document.getElementById(ROOT_ID);
      if (root) applyTheme(root);
      const widget = document.getElementById("cpos-cf-tags-widget");
      if (widget) applyTheme(widget);
      const focus = document.getElementById("cpos-cf-focus-toggle");
      if (focus) applyTheme(focus);
      document.querySelectorAll(".cpos-cf-copy").forEach((b) => applyTheme(b));
    }
  });
  if (document.body) sync();
  else document.addEventListener("DOMContentLoaded", () => sync());
})();
