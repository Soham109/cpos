// CPOS profile compare ("VS" mode) — augments codeforces.com/profile/<handle>
// with a local-first, read-only side-by-side comparison of the current profile
// against one or more other handles. Injects ONE panel (#cpos-compare), placed
// just below CPOS analytics (or the userbox) so it never overlaps
// #cpos-analytics-root. We build:
//   · an input to add handles (the profile handle is always included)
//   · a side-by-side stat table (rating/max tier-colored, rank, distinct solved,
//     contests, max up-delta) with the per-row leader highlighted
//   · a dependency-free overlaid SVG rating-history line chart (one line/handle,
//     distinct colors, legend, axis hints), graceful for unrated handles
//   · robust per-handle error reporting (unknown handle / API error) that never
//     crashes the panel
// Caches CF API results in chrome.storage.local ("cpos.compare.*"). Never touches
// capture/submit. Theme-aware (applyTheme on activeThemeId; re-theme on onChange).
// Toggle from the CPOS popup (feature "profileCompare").
(function () {
  const ROOT_ID = "cpos-compare";
  const T = self.CPOS_THEMES;
  const C = self.CPOS;
  if (!C) return;

  const FEATURE = "profileCompare";
  const HANDLES_KEY = "cpos.compare.handles";   // [handle,...] last-compared extras
  const CACHE_KEY = "cpos.compare.cache";        // { [handle]: { ts, info, rating } }
  const CACHE_TTL = 10 * 60 * 1000;              // 10 min
  const MAX_HANDLES = 6;

  // Active theme id (kept current by applyTheme) so the series palette can be
  // resolved from theme tokens at render time.
  let activeThemeId = (T && T.DEFAULT_THEME) || "light";

  // [minRating, title, color] — mirrors Codeforces' tier palette (and profile.js).
  const RANKS = [
    [0, "Newbie", "#9aa0a6"], [1200, "Pupil", "#42c267"], [1400, "Specialist", "#41b5b3"],
    [1600, "Expert", "#7aa2f7"], [1900, "Candidate Master", "#c77dff"], [2100, "Master", "#f0a13e"],
    [2300, "Int. Master", "#f0a13e"], [2400, "Grandmaster", "#ff5b5b"], [2600, "Int. Grandmaster", "#ff3333"],
    [3000, "Legendary GM", "#ff0000"]
  ];
  // Series palette for the overlay/legend/dots — derived from the ACTIVE theme
  // (one distinct color per handle) so it stays in harmony on every theme rather
  // than the old hardcoded Tokyo-Night blues. The per-RANK tier colors above are
  // CF-canonical and intentionally left untouched.
  const SERIES_TOKENS = ["--accent", "--cf", "--ok", "--warn", "--bad", "--accent-dim"];
  const SERIES_FALLBACK = ["#6b7280", "#44546a", "#1a7f37", "#9a6700", "#cf222e", "#4b5563"];
  function seriesPalette() {
    const tk = (T && T.get) ? T.get(activeThemeId) : null;
    return SERIES_TOKENS.map((tok, i) => (tk && tk[tok]) || SERIES_FALLBACK[i]);
  }

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  const nf = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));

  function handleFromUrl() {
    const m = location.pathname.match(/^\/profile\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function ratingColor(r) {
    if (r == null) return "var(--dim)";
    let c = RANKS[0][2];
    for (const [thr, , col] of RANKS) if (r >= thr) c = col;
    return c;
  }
  function rankName(r) {
    if (r == null) return "Unrated";
    let name = RANKS[0][1];
    for (const [thr, n] of RANKS) if (r >= thr) name = n;
    return name;
  }
  const titleCase = (s) => String(s || "").replace(/\b\w/g, (c) => c.toUpperCase());

  async function cfApi(method, qs) {
    const res = await fetch(`https://codeforces.com/api/${method}?${qs}`, { cache: "no-store" });
    const json = await res.json().catch(() => null);
    if (!json) throw new Error(method + " HTTP " + res.status);
    if (json.status !== "OK") throw new Error(json.comment || method + " failed");
    return json.result;
  }

  // ── per-handle data fetch (cached) ──────────────────────────────────────────
  // Returns { handle, info|null, rating[]|null, err? } — never throws.
  let cacheMem = null;
  async function loadCache() {
    if (cacheMem) return cacheMem;
    const stored = await C.get([CACHE_KEY]);
    cacheMem = stored[CACHE_KEY] || {};
    return cacheMem;
  }
  async function saveCache() { if (cacheMem) await C.set({ [CACHE_KEY]: cacheMem }); }

  async function fetchHandle(handle) {
    const cache = await loadCache();
    const rec = cache[handle.toLowerCase()];
    if (rec && Date.now() - (rec.ts || 0) < CACHE_TTL) {
      return { handle: rec.handle || handle, info: rec.info, rating: rec.rating, err: rec.err };
    }
    // user.info validates the handle; user.rating is optional (unrated → []).
    let info = null, rating = null, err = null, canonical = handle;
    try {
      const r = await cfApi("user.info", "handles=" + encodeURIComponent(handle));
      info = (r && r[0]) || null;
      if (info && info.handle) canonical = info.handle;
    } catch (e) {
      err = /not found|invalid|incorrect/i.test(e.message) ? "Unknown handle" : e.message;
    }
    if (info) {
      try { rating = await cfApi("user.rating", "handle=" + encodeURIComponent(canonical)); }
      catch (e) { rating = null; } // unrated or transient — overlay handles null/[]
    }
    cache[handle.toLowerCase()] = { handle: canonical, ts: Date.now(), info, rating, err };
    await saveCache();
    return { handle: canonical, info, rating, err };
  }

  // distinct solved count via user.status (cached inside same record? kept separate,
  // because status is large — small dedicated cache below).
  const SOLVED_KEY = "cpos.compare.solved"; // { [handle]: { ts, solved } }
  const SOLVED_TTL = 10 * 60 * 1000;
  let solvedMem = null;
  async function fetchSolved(handle) {
    if (!solvedMem) { const s = await C.get([SOLVED_KEY]); solvedMem = s[SOLVED_KEY] || {}; }
    const key = handle.toLowerCase();
    const rec = solvedMem[key];
    if (rec && Date.now() - (rec.ts || 0) < SOLVED_TTL) return rec.solved;
    try {
      const subs = await cfApi("user.status", "handle=" + encodeURIComponent(handle) + "&from=1&count=100000");
      const solved = new Set();
      for (const s of subs) {
        if (s.verdict !== "OK") continue;
        const p = s.problem || {};
        if (!p.index) continue;
        solved.add((p.contestId != null ? p.contestId : "x") + "-" + String(p.index).toUpperCase());
      }
      const n = solved.size;
      solvedMem[key] = { ts: Date.now(), solved: n };
      await C.set({ [SOLVED_KEY]: solvedMem });
      return n;
    } catch (e) {
      return rec ? rec.solved : null;
    }
  }

  // ── derived per-handle row data ─────────────────────────────────────────────
  function maxUpDelta(rating) {
    if (!Array.isArray(rating) || !rating.length) return null;
    let best = -Infinity;
    for (const r of rating) { const d = (r.newRating || 0) - (r.oldRating || 0); if (d > best) best = d; }
    return best === -Infinity ? null : best;
  }

  // ── stat table (highlight leader per row) ──────────────────────────────────
  // Each metric: { label, get(d)->number|null, fmt(v,d)->html, higherBetter, color? }
  function statTable(data, colorOf) {
    const handles = data.map((d) => d.handle);
    const rows = [
      { label: "Current rating", get: (d) => (d.info ? d.info.rating ?? null : null),
        fmt: (v) => '<span style="color:' + ratingColor(v) + '">' + nf(v) + "</span>" },
      { label: "Max rating", get: (d) => (d.info ? d.info.maxRating ?? null : null),
        fmt: (v) => '<span style="color:' + ratingColor(v) + '">' + nf(v) + "</span>" },
      { label: "Rank", get: (d) => (d.info ? d.info.rating ?? null : null), // sort by rating
        fmt: (v, d) => { const r = d.info && d.info.rank ? titleCase(d.info.rank) : rankName(v);
          return '<span style="color:' + ratingColor(v) + '">' + esc(r) + "</span>"; } },
      { label: "Solved (distinct)", get: (d) => d.solved ?? null, fmt: (v) => nf(v) },
      { label: "Contests", get: (d) => (Array.isArray(d.rating) ? d.rating.length : (d.info ? 0 : null)), fmt: (v) => nf(v) },
      { label: "Max +delta", get: (d) => maxUpDelta(d.rating),
        fmt: (v) => (v == null ? "—" : '<span style="color:' + (v >= 0 ? "var(--ok)" : "var(--bad)") + '">' + (v >= 0 ? "+" : "") + v + "</span>") }
    ];

    const head = "<tr><th></th>" + data.map((d, i) =>
      '<th><span class="cpos-cmp-dot" style="background:' + colorOf(i) + '"></span>' +
      '<a href="/profile/' + esc(d.handle) + '" class="cpos-cmp-h">' + esc(d.handle) + "</a>" +
      (d.err ? '<i class="cpos-cmp-err">' + esc(d.err) + "</i>" : "") + "</th>").join("") + "</tr>";

    const body = rows.map((row) => {
      const vals = data.map((d) => row.get(d));
      const present = vals.filter((v) => v != null);
      const leader = present.length > 1 ? Math.max(...present) : null; // all rows higher-better
      const tds = data.map((d, i) => {
        const v = vals[i];
        const isLeader = leader != null && v != null && v === leader;
        return '<td class="' + (isLeader ? "cpos-cmp-lead" : "") + '"' +
          (isLeader ? ' aria-label="leader"' : "") + ">" + row.fmt(v, d) + "</td>";
      }).join("");
      return '<tr><th class="cpos-cmp-rl">' + esc(row.label) + "</th>" + tds + "</tr>";
    }).join("");

    return '<div class="cpos-cmp-tablewrap"><table class="cpos-cmp-table"><thead>' + head +
      "</thead><tbody>" + body + "</tbody></table></div>";
  }

  // ── overlaid rating-history line chart (dependency-free SVG) ────────────────
  function ratingChart(data, colorOf) {
    const ratingTime = (r) => {
      const t = Number(r.ratingUpdateTimeSeconds ?? r.contestTimeSeconds ?? 0);
      return Number.isFinite(t) && t > 0 ? t : null;
    };

    // Collect actual contest/update events only. Codeforces ratings are a step
    // series: the value changes at the rating update time, then remains current
    // until the next rated contest.
    const series = data.map((d, i) => ({
      handle: d.handle, color: colorOf(i),
      events: (Array.isArray(d.rating) ? d.rating : [])
        .map((r) => ({
          t: ratingTime(r),
          y: Number(r.newRating),
          contestId: Number(r.contestId) || 0
        }))
        .filter((p) => p.t != null && Number.isFinite(p.y))
        .sort((a, b) => (a.t - b.t) || (a.contestId - b.contestId))
    })).filter((s) => s.events.length);

    if (!series.length) {
      return '<div class="cpos-cmp-empty">No rated contests among these handles — nothing to overlay.</div>';
    }

    // Shared scales across actual rated-contest observations only.
    let minT = Infinity, maxT = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const s of series) for (const p of s.events) {
      if (p.t < minT) minT = p.t; if (p.t > maxT) maxT = p.t;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    if (maxT === minT) {
      minT -= 24 * 60 * 60;
      maxT += 24 * 60 * 60;
    }

    // Use human-friendly rating ticks instead of arbitrary interpolated values.
    const niceStep = (raw) => {
      const power = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
      const scaled = raw / power;
      const factor = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
      return factor * power;
    };
    const spread = Math.max(1, maxY - minY);
    const yStep = niceStep((spread * 1.12) / 5);
    minY = Math.max(0, Math.floor((minY - spread * 0.06) / yStep) * yStep);
    maxY = Math.ceil((maxY + spread * 0.06) / yStep) * yStep;
    if (maxY === minY) maxY = minY + yStep;

    const W = 720, H = 280, mL = 44, mR = 12, mT = 12, mB = 26;
    const iw = W - mL - mR, ih = H - mT - mB;
    const sx = (t) => mL + ((t - minT) / (maxT - minT)) * iw;
    const sy = (y) => mT + (1 - (y - minY) / (maxY - minY)) * ih;

    // Tier bands (subtle) behind the lines, clipped to visible Y range.
    let bands = "";
    for (let i = 0; i < RANKS.length; i++) {
      const lo = RANKS[i][0];
      const hi = i + 1 < RANKS.length ? RANKS[i + 1][0] : maxY;
      const top = Math.min(maxY, hi), bot = Math.max(minY, lo);
      if (top <= bot) continue;
      const y1 = sy(top), y2 = sy(bot);
      bands += '<rect x="' + mL + '" y="' + y1.toFixed(1) + '" width="' + iw + '" height="' + (y2 - y1).toFixed(1) +
        '" fill="' + RANKS[i][2] + '" opacity="0.08"></rect>';
    }

    // Y axis ticks.
    let yticks = "";
    for (let val = minY; val <= maxY + yStep / 2; val += yStep) {
      const y = sy(val);
      yticks += '<line x1="' + mL + '" y1="' + y.toFixed(1) + '" x2="' + (W - mR) + '" y2="' + y.toFixed(1) +
        '" stroke="var(--border)" stroke-width="1" opacity="0.5"></line>' +
        '<text x="' + (mL - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-size="9" fill="var(--dim)">' + nf(val) + "</text>";
    }

    // Evenly spaced time labels make the shared chronology readable.
    const fmtDate = (t) => { const d = new Date(t * 1000); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); };
    let xhints = "";
    const xTickN = 4;
    for (let k = 0; k <= xTickN; k++) {
      const t = minT + (k / xTickN) * (maxT - minT);
      const x = sx(t);
      const anchor = k === 0 ? "start" : k === xTickN ? "end" : "middle";
      xhints += '<text x="' + x.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="' + anchor +
        '" font-size="9" fill="var(--dim)">' + fmtDate(t) + "</text>";
    }

    const lines = series.map((s) => {
      const pts = s.events;
      const d = pts.map((p, i) => (i ? "L" : "M") + sx(p.t).toFixed(1) + " " + sy(p.y).toFixed(1)).join(" ");
      const dots = pts.map((p) =>
        '<circle cx="' + sx(p.t).toFixed(1) + '" cy="' + sy(p.y).toFixed(1) + '" r="2" fill="' + s.color +
        '"><title>' + esc(s.handle) + " · " + fmtDate(p.t) + " · " + nf(p.y) + "</title></circle>").join("");
      return '<path d="' + d + '" fill="none" stroke="' + s.color +
        '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>' + dots;
    }).join("");

    const legend = series.map((s) => {
      const last = s.events[s.events.length - 1].y;
      return '<span class="cpos-cmp-leg"><span class="dot" style="background:' + s.color + '"></span>' +
        '<b>' + esc(s.handle) + "</b><i>" + nf(last) + "</i></span>";
    }).join("");
    const unrated = data.filter((d) => !series.some((s) => s.handle === d.handle) && d.info)
      .map((d) => esc(d.handle));
    const unratedNote = unrated.length ? '<div class="cpos-cmp-note">Unrated (no history): ' + unrated.join(", ") + "</div>" : "";

    return '<div class="cpos-cmp-chartwrap"><svg viewBox="0 0 ' + W + " " + H + '" class="cpos-cmp-chart" role="img" preserveAspectRatio="none">' +
      bands + yticks + lines + xhints + "</svg>" +
      '<div class="cpos-cmp-legend">' + legend + "</div>" + unratedNote + "</div>";
  }

  // ── theme ────────────────────────────────────────────────────────────────
  async function applyTheme(root) {
    if (!T || !C) return;
    activeThemeId = await (C.activePageThemeId ? C.activePageThemeId() : C.activeThemeId());
    T.applyTheme(root, activeThemeId);
  }

  // ── persistence of extra handles ───────────────────────────────────────────
  async function getExtraHandles() {
    const s = await C.get([HANDLES_KEY]);
    const arr = s[HANDLES_KEY];
    return Array.isArray(arr) ? arr : [];
  }
  async function setExtraHandles(arr) { await C.set({ [HANDLES_KEY]: arr }); }

  // ── render pipeline ─────────────────────────────────────────────────────────
  let rendering = 0;
  async function render(root) {
    const me = handleFromUrl();
    if (!me) return;
    const extras = (await getExtraHandles())
      .filter((h) => h && h.toLowerCase() !== me.toLowerCase());
    const order = [me, ...extras].slice(0, MAX_HANDLES);

    const body = root.querySelector(".cpos-cmp-body");
    if (!body) return;

    // With zero competitor handles a single-column table / single-line overlay
    // would just duplicate CF's own rating graph and the CPOS analytics stats.
    // Show only a friendly hint until at least one extra handle is added.
    if (!extras.length) {
      body.innerHTML =
        '<div class="cpos-cmp-prompt">Add a handle to compare <b>@' + esc(me) +
        "</b> against — you'll get a side-by-side stat table and an overlaid rating chart.</div>";
      return;
    }

    const token = ++rendering;
    body.innerHTML = '<div class="cpos-cmp-empty">Loading comparison…</div>';

    const data = await Promise.all(order.map(async (h) => {
      const base = await fetchHandle(h);
      const solved = base.info ? await fetchSolved(base.handle) : null;
      return Object.assign({}, base, { solved });
    }));

    if (token !== rendering || !document.getElementById(ROOT_ID)) return; // superseded / removed
    const palette = seriesPalette();
    const colorOf = (i) => palette[i % palette.length];

    body.innerHTML =
      '<div class="cpos-cmp-section">' + statTable(data, colorOf) + "</div>" +
      '<div class="cpos-cmp-section"><h5>Rating history overlay</h5>' + ratingChart(data, colorOf) + "</div>";
  }

  function chipRow(extras, me) {
    return extras.map((h) =>
      '<span class="cpos-cmp-chip" data-h="' + esc(h) + '">' + esc(h) +
      '<button class="cpos-cmp-x" data-rm="' + esc(h) + '" title="remove" aria-label="remove ' + esc(h) + '">×</button></span>'
    ).join("") || '<span class="cpos-cmp-hint">Add a handle to compare with @' + esc(me) + ".</span>";
  }

  async function refreshChips(root) {
    const me = handleFromUrl();
    const extras = (await getExtraHandles()).filter((h) => h && h.toLowerCase() !== me.toLowerCase());
    const wrap = root.querySelector(".cpos-cmp-chips");
    if (wrap) wrap.innerHTML = chipRow(extras, me);
  }

  function insertPanel(node) {
    // Place below CPOS analytics if present, else below the userbox.
    const analytics = document.getElementById("cpos-analytics-root");
    if (analytics && analytics.parentNode) { analytics.parentNode.insertBefore(node, analytics.nextSibling); return; }
    const anchor = document.querySelector(".userbox") || document.querySelector("#pageContent .roundbox") || document.querySelector("#pageContent");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(node, anchor.nextSibling);
    else (document.querySelector("#pageContent") || document.body).prepend(node);
  }

  async function build() {
    if (document.getElementById(ROOT_ID)) return;
    const me = handleFromUrl();
    if (!me) return;

    const root = el("div", "cpos-cmp");
    root.id = ROOT_ID;
    const extras = (await getExtraHandles()).filter((h) => h && h.toLowerCase() !== me.toLowerCase());
    root.innerHTML =
      '<div class="cpos-cmp-head"><span class="badge">CPOS</span> Compare ' +
      '<span class="who">@' + esc(me) + " vs…</span></div>" +
      '<div class="cpos-cmp-controls">' +
      '<form class="cpos-cmp-form"><input type="text" class="cpos-cmp-input" placeholder="add handle(s) — space/comma separated" autocomplete="off" spellcheck="false" />' +
      '<button type="submit" class="cpos-cmp-add">Add</button></form>' +
      '<div class="cpos-cmp-chips">' + chipRow(extras, me) + "</div></div>" +
      '<div class="cpos-cmp-body"></div>';

    insertPanel(root);
    await applyTheme(root);

    const form = root.querySelector(".cpos-cmp-form");
    const input = root.querySelector(".cpos-cmp-input");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const raw = input.value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
      if (!raw.length) return;
      const cur = await getExtraHandles();
      const lower = new Set([me.toLowerCase(), ...cur.map((h) => h.toLowerCase())]);
      for (const h of raw) {
        if (lower.has(h.toLowerCase())) continue;
        if (1 + cur.length >= MAX_HANDLES) break; // cap including profile handle
        cur.push(h); lower.add(h.toLowerCase());
      }
      await setExtraHandles(cur);
      input.value = "";
      await refreshChips(root);
      render(root);
    });

    root.querySelector(".cpos-cmp-chips").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-rm]");
      if (!btn) return;
      const rm = btn.getAttribute("data-rm").toLowerCase();
      const cur = (await getExtraHandles()).filter((h) => h.toLowerCase() !== rm);
      await setExtraHandles(cur);
      await refreshChips(root);
      render(root);
    });

    render(root).catch((err) => {
      const b = root.querySelector(".cpos-cmp-body");
      if (b) b.innerHTML = '<div class="cpos-cmp-empty">Comparison failed: ' + esc(err.message || "error") + "</div>";
    });
  }

  function remove() { document.getElementById(ROOT_ID)?.remove(); }

  async function sync() {
    const on = await C.feature(FEATURE);
    if (on) build().catch((e) => console.debug("CPOS compare:", e));
    else remove();
  }

  C.onChange((changes) => {
    if (changes[C.KEYS.FEATURES]) sync();
    else { const root = document.getElementById(ROOT_ID); if (root) applyTheme(root); }
  });
  sync();
})();
