// CPOS profile analytics — augments codeforces.com/profile/<handle> in place
// with charts Codeforces does NOT already show (it has its own rating graph, so
// we never repeat it). Read-only: fetches the public CF API and injects ONE
// panel (#cpos-analytics-root .cpos-analytics) near the userbox. We build:
//   · overview stat tiles (rating/max tier-colored, rank, solved, subs, accept%)
//   · rank-progress bar and rating-history facts (contests, best rank, max gain)
//   · activity heatmap (52 weeks) with current + longest streak
//   · solved-by-rating histogram, top tags, verdict + language donuts
//   · solved-by-index distribution and a panel of derived insights
// Distinct-problem dedup is used everywhere solved problems are counted, and
// acceptance = AC submissions / total submissions. Never touches capture/submit.
// Toggle from the CPOS popup (feature "profile").
(function () {
  const ROOT_ID = "cpos-analytics-root";
  const T = self.CPOS_THEMES;
  const C = self.CPOS;

  // [minRating, title, color]. Colors mirror Codeforces' own tier palette.
  const RANKS = [
    [0, "Newbie", "#9aa0a6"], [1200, "Pupil", "#42c267"], [1400, "Specialist", "#41b5b3"],
    [1600, "Expert", "#7aa2f7"], [1900, "Candidate Master", "#c77dff"], [2100, "Master", "#f0a13e"],
    [2300, "Int. Master", "#f0a13e"], [2400, "Grandmaster", "#ff5b5b"], [2600, "Int. Grandmaster", "#ff3333"],
    [3000, "Legendary GM", "#ff0000"]
  ];
  const PALETTE = ["#7aa2f7", "#c792ea", "#7ee787", "#f0b860", "#ff7a93", "#56d4dd", "#e0af68", "#bb9af7", "#9ece6a", "#f7768e"];

  // ── small helpers ──────────────────────────────────────────────────────────
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
  function rankInfo(r) {
    if (r == null) return { name: "Unrated", lo: 0, hi: 1200, color: "var(--dim)" };
    let idx = 0;
    for (let i = 0; i < RANKS.length; i++) if (r >= RANKS[i][0]) idx = i;
    const lo = RANKS[idx][0];
    const hi = idx + 1 < RANKS.length ? RANKS[idx + 1][0] : lo + 300;
    return { name: RANKS[idx][1], lo, hi, color: RANKS[idx][2] };
  }

  async function cfApi(method, qs) {
    const res = await fetch(`https://codeforces.com/api/${method}?${qs}`, { cache: "no-store" });
    if (!res.ok) throw new Error(method + " HTTP " + res.status);
    const json = await res.json();
    if (json.status !== "OK") throw new Error(json.comment || method + " failed");
    return json.result;
  }

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  const pad2 = (n) => String(n).padStart(2, "0");
  const ymd = (d) => d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  const nf = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // ── chart primitives (dependency-free SVG/CSS) ─────────────────────────────
  function bars(rows, colorFn, lblW) {
    if (!rows || !rows.length) return '<div class="cpos-empty">No data yet.</div>';
    const max = Math.max(...rows.map((r) => r.value), 1);
    const style = lblW ? ' style="--lblw:' + lblW + 'px"' : "";
    return '<div class="cpos-bars"' + style + ">" + rows.map((r, i) => {
      const pct = Math.max(3, Math.round((r.value / max) * 100));
      const color = colorFn ? colorFn(r, i) : "var(--accent)";
      const title = r.title ? ' title="' + esc(r.title) + '"' : "";
      return '<div class="cpos-bar" style="--bar-clr:' + color + '"' + title + '><span class="lbl" title="' + esc(r.label) + '">' + esc(r.label) + "</span>" +
        '<span class="track"><span class="fill" style="width:' + pct + '%"></span></span>' +
        '<span class="num">' + nf(r.value) + "</span></div>";
    }).join("") + "</div>";
  }

  function donut(rows, colorFn) {
    const total = rows.reduce((s, r) => s + r.value, 0);
    if (!total) return '<div class="cpos-empty">No data yet.</div>';
    const R = 46, CIRC = 2 * Math.PI * R;
    let off = 0;
    const segs = rows.map((r, i) => {
      const len = (r.value / total) * CIRC;
      const col = colorFn ? colorFn(r, i) : PALETTE[i % PALETTE.length];
      const pct = Math.round((r.value / total) * 100);
      const seg = '<circle r="' + R + '" cx="60" cy="60" fill="none" stroke="' + col +
        '" stroke-width="15" stroke-dasharray="' + len.toFixed(2) + " " + (CIRC - len).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) +
        '" transform="rotate(-90 60 60)"><title>' + esc(r.label) + ": " + nf(r.value) + " (" + pct + "%)</title></circle>";
      off += len;
      return seg;
    }).join("");
    const legend = rows.map((r, i) => {
      const col = colorFn ? colorFn(r, i) : PALETTE[i % PALETTE.length];
      const pct = Math.round((r.value / total) * 100);
      return '<div class="cpos-leg"><span class="dot" style="background:' + col + '"></span>' +
        '<span class="ll" title="' + esc(r.label) + '">' + esc(r.label) + '</span><b>' + nf(r.value) +
        '</b><span class="lp">' + pct + "%</span></div>";
    }).join("");
    return '<div class="cpos-donut-wrap"><svg viewBox="0 0 120 120" class="cpos-donut" role="img">' + segs +
      '<text x="60" y="57" text-anchor="middle" font-size="18" font-weight="800" fill="var(--fg)">' + nf(total) + "</text>" +
      '<text x="60" y="73" text-anchor="middle" font-size="8" fill="var(--dim)">total</text></svg>' +
      '<div class="cpos-legend">' + legend + "</div></div>";
  }

  // 52-week heatmap. Columns are weeks (Sun..Sat), aligned so today lands on its
  // real weekday in the last column. Returns { html, streaks }.
  function heatmap(byDay) {
    const WEEKS = 52;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const trailing = 6 - today.getDay(); // blank cells after today in last column
    const total = WEEKS * 7;
    const cells = [];
    let sum = 0, active = 0;
    const monthMarks = [];
    let prevMonth = -1, col = 0;
    for (let i = total - 1; i >= 0; i--) {
      const offset = i - trailing; // 0 = today, increasing = older
      if (offset < 0) { cells.push({ blank: true }); col++; continue; }
      const d = new Date(today);
      d.setDate(d.getDate() - offset);
      const c = byDay[ymd(d)] || 0;
      sum += c;
      if (c > 0) active++;
      // month label appears in the row that starts a new month (Sundays)
      if (d.getDay() === 0) {
        col = Math.floor((total - 1 - i) / 7);
        if (d.getMonth() !== prevMonth) { monthMarks.push({ col, label: MONTHS[d.getMonth()] }); prevMonth = d.getMonth(); }
      }
      cells.push({ c, date: ymd(d), label: d.getDate() + " " + MONTHS[d.getMonth()] });
    }
    // Bucket by percentile of the nonzero daily counts so a single outlier day
    // doesn't flatten the whole signature to l1/l2 (quartile splits → l1..l4).
    const nz = cells.filter((cell) => !cell.blank && cell.c > 0).map((cell) => cell.c).sort((a, b) => a - b);
    const q = (p) => (nz.length ? nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] : 1);
    const q1 = q(0.25), q2 = q(0.5), q3 = q(0.75);
    const level = (c) => {
      if (c <= 0) return 0;
      if (c > q3) return 4;
      if (c > q2) return 3;
      if (c > q1) return 2;
      return 1;
    };
    const cellHtml = cells.map((cell) => {
      if (cell.blank) return '<span class="cpos-hc blank"></span>';
      const c = cell.c;
      const lvl = level(c);
      return '<span class="cpos-hc l' + lvl + '" title="' + cell.label + ": " + c + (c === 1 ? " submission" : " submissions") + '"></span>';
    }).join("");
    const monthHtml = monthMarks.map((m) => '<span style="grid-column:' + (m.col + 1) + '">' + m.label + "</span>").join("");
    const html = '<div class="cpos-heatwrap"><div class="cpos-heat-scroll"><div class="cpos-heat-months" style="grid-template-columns:repeat(' + WEEKS + ',11px)">' + monthHtml + "</div>" +
      '<div class="cpos-heat">' + cellHtml + "</div></div>" +
      '<div class="cpos-heat-foot"><span>' + nf(sum) + " submissions over 52 weeks · " + active + " active days</span>" +
      '<span class="cpos-heat-legend">less <span class="cpos-hc l0"></span><span class="cpos-hc l1"></span>' +
      '<span class="cpos-hc l2"></span><span class="cpos-hc l3"></span><span class="cpos-hc l4"></span> more</span></div></div>';
    return html;
  }

  // Current & longest daily streaks computed across the full submission history.
  function streaks(byDay) {
    const days = Object.keys(byDay).filter((k) => byDay[k] > 0).sort();
    if (!days.length) return { current: 0, longest: 0 };
    const set = new Set(days);
    let longest = 0;
    for (const day of days) {
      const prev = new Date(day);
      prev.setDate(prev.getDate() - 1);
      if (set.has(ymd(prev))) continue; // not a run start
      let len = 0;
      const cur = new Date(day);
      while (set.has(ymd(cur))) { len++; cur.setDate(cur.getDate() + 1); }
      longest = Math.max(longest, len);
    }
    // current streak: walk back from today (or yesterday) while days are present
    let current = 0;
    const probe = new Date();
    probe.setHours(0, 0, 0, 0);
    if (!set.has(ymd(probe))) probe.setDate(probe.getDate() - 1); // allow "today not yet active"
    while (set.has(ymd(probe))) { current++; probe.setDate(probe.getDate() - 1); }
    return { current, longest };
  }

  function rankProgress(rating) {
    const info = rankInfo(rating);
    if (rating == null) return '<div class="cpos-empty">Unrated — no contests rated yet.</div>';
    const span = info.hi - info.lo || 1;
    const pct = Math.max(0, Math.min(100, Math.round(((rating - info.lo) / span) * 100)));
    const toNext = Math.max(0, info.hi - rating);
    return '<div class="cpos-rank"><div class="cpos-rank-row"><span style="color:' + info.color + ';font-weight:700">' + esc(info.name) + "</span>" +
      '<span class="cpos-dim">' + (toNext > 0 ? "+" + toNext + " to next tier" : "top tier") + "</span></div>" +
      '<div class="cpos-rank-track"><span class="cpos-rank-fill" style="width:' + pct + "%;background:" + info.color + '"></span></div></div>';
  }

  // ── stats from submissions (distinct-problem dedup throughout) ─────────────
  function computeStats(submissions) {
    const solved = new Set();              // distinct solved "contestId-index"
    const attempted = new Set();           // distinct attempted problems (any verdict)
    const attemptsBySolved = {};           // problemKey -> submission count (to first AC)
    const solvedByRating = {}, tagCount = {}, verdicts = {}, langs = {}, byDay = {}, byIndex = {}, byMonth = {};
    const tagSeen = new Set();
    let acCount = 0, hardest = null, firstTs = null, lastTs = null;

    // Oldest-first so "attempts until first AC" counts correctly.
    const ordered = submissions.slice().sort((a, b) => (a.creationTimeSeconds || 0) - (b.creationTimeSeconds || 0));

    for (const s of ordered) {
      const v = s.verdict || "TESTING";
      verdicts[v] = (verdicts[v] || 0) + 1;
      const lang = (s.programmingLanguage || "").replace(/\s*\(.*\)$/, "").trim() || "Unknown";
      langs[lang] = (langs[lang] || 0) + 1;
      const p = s.problem || {};
      const key = (p.contestId != null ? p.contestId : "x") + "-" + (p.index || "?");
      if (s.creationTimeSeconds) {
        const ts = s.creationTimeSeconds * 1000;
        firstTs = firstTs == null ? ts : Math.min(firstTs, ts);
        lastTs = lastTs == null ? ts : Math.max(lastTs, ts);
        const d = new Date(ts);
        byDay[ymd(d)] = (byDay[ymd(d)] || 0) + 1;
        const mk = d.getFullYear() + "-" + pad2(d.getMonth() + 1);
        byMonth[mk] = (byMonth[mk] || 0) + 1;
      }
      attempted.add(key);
      // count one attempt per submission toward the problem until it is solved
      if (!solved.has(key)) attemptsBySolved[key] = (attemptsBySolved[key] || 0) + 1;

      if (v !== "OK") continue;
      acCount++;
      if (solved.has(key)) continue;       // distinct dedup for solved-derived charts
      solved.add(key);
      if (p.rating) {
        solvedByRating[p.rating] = (solvedByRating[p.rating] || 0) + 1;
        if (hardest == null || p.rating > hardest.rating) hardest = { rating: p.rating, name: p.name, index: p.index, contestId: p.contestId };
      }
      const letter = (p.index || "?").charAt(0).toUpperCase();
      byIndex[letter] = (byIndex[letter] || 0) + 1;
      for (const tag of p.tags || []) {
        const tk = key + "|" + tag;
        if (tagSeen.has(tk)) continue;
        tagSeen.add(tk);
        tagCount[tag] = (tagCount[tag] || 0) + 1;
      }
    }

    const solvedCount = solved.size;
    const accept = submissions.length ? Math.round((acCount / submissions.length) * 100) : 0;
    // average submissions to solve a problem (only over solved problems)
    let totalAttempts = 0;
    for (const k of solved) totalAttempts += attemptsBySolved[k] || 1;
    const avgAttempts = solvedCount ? totalAttempts / solvedCount : 0;
    const attemptedUnsolved = attempted.size - solvedCount;

    return {
      solvedCount, acCount, accept, solvedByRating, tagCount, verdicts, langs, byDay, byIndex, byMonth,
      hardest, avgAttempts, attemptedUnsolved, firstTs, lastTs, totalSubs: submissions.length
    };
  }

  // Derive facts from rating history WITHOUT redrawing CF's rating graph.
  function ratingFacts(history) {
    if (!history || !history.length) return { contests: 0, bestRank: null, maxGain: null, maxDrop: null, volatility: null };
    let bestRank = Infinity, maxGain = -Infinity, maxDrop = Infinity;
    let bestRankContest = "", maxGainContest = "";
    const deltas = [];
    for (const r of history) {
      if (r.rank != null && r.rank < bestRank) { bestRank = r.rank; bestRankContest = r.contestName || ""; }
      const delta = (r.newRating || 0) - (r.oldRating || 0);
      deltas.push(delta);
      if (delta > maxGain) { maxGain = delta; maxGainContest = r.contestName || ""; }
      if (delta < maxDrop) maxDrop = delta;
    }
    // volatility = std-dev of per-contest rating change
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const variance = deltas.reduce((a, b) => a + (b - mean) * (b - mean), 0) / deltas.length;
    const volatility = Math.round(Math.sqrt(variance));
    return {
      contests: history.length,
      bestRank: bestRank === Infinity ? null : bestRank, bestRankContest,
      maxGain: maxGain === -Infinity ? null : maxGain, maxGainContest,
      maxDrop: maxDrop === Infinity ? null : maxDrop,
      volatility
    };
  }

  // ── row builders ───────────────────────────────────────────────────────────
  function topRows(obj, n, byKeyNum, keyMap) {
    let e = Object.entries(obj).map(([label, value]) => ({ label: keyMap ? keyMap(label) : label, value }));
    if (byKeyNum) { e.sort((a, b) => Number(a.label) - Number(b.label)); return e; }
    e.sort((a, b) => b.value - a.value);
    return n ? e.slice(0, n) : e;
  }

  const VERDICT_NAMES = {
    OK: "Accepted", WRONG_ANSWER: "Wrong answer", TIME_LIMIT_EXCEEDED: "Time limit",
    MEMORY_LIMIT_EXCEEDED: "Memory limit", RUNTIME_ERROR: "Runtime error", COMPILATION_ERROR: "Compile error",
    IDLENESS_LIMIT_EXCEEDED: "Idleness limit", PRESENTATION_ERROR: "Presentation error", SKIPPED: "Skipped",
    CHALLENGED: "Hacked", PARTIAL: "Partial", FAILED: "Failed", TESTING: "Testing", REJECTED: "Rejected"
  };
  const prettyVerdict = (v) => VERDICT_NAMES[v] || String(v).replace(/_/g, " ").toLowerCase();
  const verdictColor = (r) =>
    /Accepted/.test(r.label) ? "var(--ok)" :
    /Wrong|Runtime|Compile|Failed|Rejected/.test(r.label) ? "var(--bad)" :
    /limit|Idleness/i.test(r.label) ? "var(--warn)" :
    /Hacked|Partial|Presentation|Skipped/.test(r.label) ? "var(--cf)" : "var(--dim)";

  // ── DOM scaffolding ─────────────────────────────────────────────────────────
  function panel(cls, title, bodyHtml) { return el("div", "cpos-panel " + cls, '<h4>' + esc(title) + "</h4>" + bodyHtml); }
  function showLatestHeatmapWeek(panelNode) {
    const scroller = panelNode && panelNode.querySelector(".cpos-heat-scroll");
    if (!scroller) return;
    const pinRight = () => { scroller.scrollLeft = scroller.scrollWidth; };
    pinRight();
    requestAnimationFrame(pinRight);
  }
  function stat(value, label, color, sub) {
    return '<div class="cpos-stat"><b' + (color ? ' style="color:' + color + '"' : "") + ">" + esc(value) + "</b>" +
      '<span>' + esc(label) + "</span>" + (sub ? '<i class="cpos-stat-sub">' + esc(sub) + "</i>" : "") + "</div>";
  }
  // A fact row: label (+ optional one-line hint) on the left, value on the right.
  // `accent` tints a thin leading rule so the list scans as grouped, not flat.
  function fact(label, value, color, hint, accent) {
    const a = accent || color || "var(--accent)";
    return '<div class="cpos-fact" style="--fa:' + a + '">' +
      '<span class="fl"><span class="fl-t">' + esc(label) + "</span>" +
      (hint ? '<span class="fl-h">' + esc(hint) + "</span>" : "") + "</span>" +
      '<span class="fv"' + (color ? ' style="color:' + color + '"' : "") + ">" + esc(value) + "</span></div>";
  }

  async function applyTheme(root) {
    if (!T || !C) return;
    T.applyTheme(root, await (C.activePageThemeId ? C.activePageThemeId() : C.activeThemeId()));
  }

  function insertPanel(node) {
    const page = document.querySelector("#pageContent") || document.body;
    const userbox = document.querySelector(".userbox");
    if (userbox && page.contains(userbox)) {
      // Native Codeforces wraps the userbox in a floated right column. Insert
      // after that top-level column (not inside it), then let the analytics root
      // form its own formatting context beside the float.
      let column = userbox;
      while (column.parentElement && column.parentElement !== page) column = column.parentElement;
      page.insertBefore(node, column.nextSibling);
      return;
    }
    const anchor = document.querySelector("#pageContent .roundbox");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(node, anchor.nextSibling);
    else page.prepend(node);
  }

  // loading skeleton shown while the API calls are in flight
  function skeleton(grid) {
    const tiles = ['span2', '', 'span3', 'span2', '', 'span2', ''];
    tiles.forEach((cls) => {
      const p = el("div", "cpos-panel cpos-skel " + cls, '<div class="sk sk-h"></div><div class="sk sk-b"></div>');
      grid.appendChild(p);
    });
  }

  async function build() {
    if (document.getElementById(ROOT_ID)) return;
    const handle = handleFromUrl();
    if (!handle) return;

    const root = el("div", "cpos-analytics");
    root.id = ROOT_ID;
    const head = el("div", "cpos-head", '<span class="badge">CPOS</span> Analytics <span class="who">@' + esc(handle) + '</span><span class="spin">· loading…</span>');
    const grid = el("div", "cpos-grid");
    root.appendChild(head);
    root.appendChild(grid);
    insertPanel(root);
    await applyTheme(root);
    skeleton(grid);

    const [info, submissions, history] = await Promise.all([
      cfApi("user.info", "handles=" + encodeURIComponent(handle)).then((r) => r[0]).catch((e) => ({ _err: e.message })),
      cfApi("user.status", "handle=" + encodeURIComponent(handle) + "&from=1&count=100000").catch((e) => ({ _err: e.message })),
      cfApi("user.rating", "handle=" + encodeURIComponent(handle)).catch(() => null) // optional; unrated users 200 with []
    ]);

    // Re-check we weren't toggled off mid-fetch.
    if (!document.getElementById(ROOT_ID)) return;
    head.querySelector(".spin")?.remove();
    grid.innerHTML = "";

    const mainCol = el("div", "cpos-col cpos-col-main");
    const sideCol = el("div", "cpos-col cpos-col-side");
    grid.appendChild(mainCol);
    grid.appendChild(sideCol);
    const main = (cls, title, bodyHtml) => mainCol.appendChild(panel(cls, title, bodyHtml));
    const side = (cls, title, bodyHtml) => sideCol.appendChild(panel(cls, title, bodyHtml));

    if ((!info || info._err) && (!submissions || submissions._err)) {
      mainCol.appendChild(panel("", "Error", '<div class="cpos-empty">Could not reach the Codeforces API (' +
        esc((info && info._err) || (submissions && submissions._err) || "network error") + '). Try reloading the page.</div>'));
      return;
    }

    const ok = info && !info._err;
    const rating = ok ? info.rating : null;
    const maxRating = ok ? info.maxRating : null;
    const rankTitle = ok && info.rank ? info.rank.replace(/\b\w/g, (c) => c.toUpperCase()) : (rating != null ? rankInfo(rating).name : "Unrated");
    const subs = Array.isArray(submissions) ? submissions : [];
    const st = computeStats(subs);
    const rf = ratingFacts(Array.isArray(history) ? history : []);
    const streak = streaks(st.byDay);

    if (!subs.length && !ok) {
      mainCol.appendChild(panel("", "No data", '<div class="cpos-empty">No submissions found for <b>' + esc(handle) + "</b>.</div>"));
      return;
    }

    // 1) Overview tiles
    main("span2", "Overview",
      '<div class="cpos-stats">' +
      stat(nf(rating), "rating", ratingColor(rating), rankTitle) +
      stat(nf(maxRating), "max rating", ratingColor(maxRating)) +
      stat(nf(st.solvedCount), "solved") +
      stat(nf(st.totalSubs), "submissions") +
      stat(st.accept + "%", "acceptance", "var(--ok)", nf(st.acCount) + " AC") +
      stat(nf(rf.contests), "contests") +
      "</div>");

    // 2) Rank progress
    side("", "Rank progress", rankProgress(rating));

    // 3) Activity heatmap + streaks
    const activityPanel = main("span3", "Submission activity",
      heatmap(st.byDay) +
      '<div class="cpos-streaks">' +
      '<span><b>' + streak.current + "</b> day current streak</span>" +
      '<span><b>' + streak.longest + "</b> day longest streak</span></div>");
    showLatestHeatmapWeek(activityPanel);

    // 4) Solved by rating histogram (bucketed to nearest 100, tier-colored)
    const ratingBuckets = {};
    for (const [r, v] of Object.entries(st.solvedByRating)) {
      const b = Math.floor(Number(r) / 100) * 100;
      ratingBuckets[b] = (ratingBuckets[b] || 0) + v;
    }
    main("span2", "Solved by problem rating",
      bars(topRows(ratingBuckets, 0, true), (r) => ratingColor(Number(r.label)), 54));

    // 5) Verdicts donut
    side("", "Verdicts",
      donut(topRows(st.verdicts, 8).map((r) => ({ label: prettyVerdict(r.label), value: r.value })), verdictColor));

    // 6) Top tags — ranked intensity ramp so the top tag reads hottest, fading
    //    toward --dim down the list (capped at 40% accent to stay legible).
    main("span2", "Top tags solved (distinct problems)",
      bars(topRows(st.tagCount, 14),
        (r, i) => "color-mix(in srgb, var(--accent) " + Math.max(40, 100 - i * 6) + "%, var(--dim))", 130));

    // 7) Languages donut
    side("", "Languages used", donut(topRows(st.langs, 6)));

    // 8) Solved by index
    main("span2", "Solved by problem index",
      bars(topRows(st.byIndex, 0, false).sort((a, b) => a.label.localeCompare(b.label)),
        (r) => PALETTE[Math.max(0, r.label.charCodeAt(0) - 65) % PALETTE.length], 30));

    // 9) Insights panel (derived accurate facts). Each value comes straight from
    //    computeStats()/ratingFacts(); hints add context, units stay explicit.
    const spanDays = (st.firstTs && st.lastTs) ? Math.max(1, Math.round((st.lastTs - st.firstTs) / 86400000)) : 0;
    const spanText = spanDays >= 365 ? (spanDays / 365).toFixed(1) + " yr" : spanDays >= 1 ? spanDays + " days" : "—";
    const hardest = st.hardest;
    const hardestName = hardest && hardest.name ? hardest.name : "";
    const insights =
      fact("Avg attempts / solved", st.solvedCount ? st.avgAttempts.toFixed(2) : "—",
        st.avgAttempts > 2 ? "var(--warn)" : "var(--ok)", "submissions to first AC", "var(--accent)") +
      fact("Attempted but unsolved", nf(st.attemptedUnsolved),
        st.attemptedUnsolved > 0 ? "var(--warn)" : "var(--ok)", "distinct problems with no AC", "var(--warn)") +
      fact("Hardest solved", hardest ? nf(hardest.rating) + (hardest.index ? " · " + hardest.index : "") : "—",
        hardest ? ratingColor(hardest.rating) : "var(--dim)", hardestName, "var(--cf)") +
      fact("Best contest rank", rf.bestRank != null ? "#" + nf(rf.bestRank) : "—",
        "var(--cf)", rf.bestRank != null ? rf.bestRankContest : "", "var(--cf)") +
      fact("Max rating gain", rf.maxGain != null ? (rf.maxGain >= 0 ? "+" : "") + nf(rf.maxGain) : "—",
        rf.maxGain != null && rf.maxGain >= 0 ? "var(--ok)" : "var(--bad)",
        rf.maxGain != null ? rf.maxGainContest : "", "var(--ok)") +
      fact("Biggest rating drop", rf.maxDrop != null ? nf(rf.maxDrop) : "—",
        rf.maxDrop != null && rf.maxDrop < 0 ? "var(--bad)" : "var(--dim)", "worst single contest", "var(--bad)") +
      fact("Rating volatility", rf.volatility != null ? "±" + nf(rf.volatility) : "—",
        "var(--fg)", "std-dev of contest deltas", "var(--accent)") +
      fact("Active span", spanText,
        "var(--fg)", st.firstTs ? "since " + ymd(new Date(st.firstTs)) : "", "var(--accent)");
    side("", "Insights", '<div class="cpos-facts">' + insights + "</div>");

    // 10) Submissions over time (monthly, last ~18 months)
    const months = Object.keys(st.byMonth).sort();
    const recent = months.slice(-18).map((m) => {
      const [y, mo] = m.split("-");
      return { label: MONTHS[Number(mo) - 1] + " '" + y.slice(2), value: st.byMonth[m] };
    });
    main("span2", "Submissions over time (monthly)", bars(recent, () => "var(--cf)", 56));
  }

  function remove() { document.getElementById(ROOT_ID)?.remove(); }

  async function sync() {
    if (!C) return;
    const on = await C.feature("profile");
    if (on) build().catch((e) => console.debug("CPOS profile:", e));
    else remove();
  }

  if (C) {
    C.onChange((changes) => {
      if (changes[C.KEYS.FEATURES]) sync();
      else { const root = document.getElementById(ROOT_ID); if (root) applyTheme(root); }
    });
    sync();
  }
})();
