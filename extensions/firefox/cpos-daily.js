// CPOS daily problem + practice streak — content script on codeforces.com.
// Read-only: scrapes the logged-in handle from the page header, fetches the
// public CF API (problemset.problems, user.status, user.info), and:
//   · picks a DETERMINISTIC "problem of the day" tuned to the user's rating,
//     stable per calendar day (seeded by date so it doesn't change on refresh)
//   · computes a PRACTICE STREAK (consecutive days with >=1 accepted submission)
//     in the user's LOCAL timezone (current + longest)
// Results are written to chrome.storage.local under "cpos.daily.*" / "cpos.streak.*"
// so the popup module (practice-ui.js) can render them. Optionally shows a small,
// dismissible banner on the CF homepage only. Never touches capture/submit.
// Toggle from the CPOS popup (feature "dailyProblem").
(function () {
  const C = self.CPOS;
  const T = self.CPOS_THEMES;
  if (!C) return;

  const BANNER_ID = "cpos-daily-banner";

  // storage keys (namespaced, see brief)
  const K_DAILY = "cpos.daily.problem";      // { date, contestId, index, name, rating, url, band }
  const K_HANDLE = "cpos.daily.handle";      // last known handle
  const K_STREAK = "cpos.streak.data";       // { current, longest, lastActive, computedAt }
  const K_DISMISS = "cpos.daily.dismissed";  // date string of last dismissal
  const K_RATING = "cpos.daily.rating";       // "auto" or an exact Codeforces rating

  // ── small helpers (mirrors profile.js conventions) ──────────────────────────
  const pad2 = (n) => String(n).padStart(2, "0");
  const ymd = (d) => d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  const todayStr = () => ymd(new Date());
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function get(keys) { return new Promise((res) => chrome.storage.local.get(keys, (v) => res(v || {}))); }
  function set(obj) { return new Promise((res) => chrome.storage.local.set(obj, () => res())); }

  async function cfApi(method, qs) {
    const res = await fetch(`https://codeforces.com/api/${method}?${qs}`, { cache: "no-store" });
    if (!res.ok) throw new Error(method + " HTTP " + res.status);
    const json = await res.json();
    if (json.status !== "OK") throw new Error(json.comment || method + " failed");
    return json.result;
  }

  // Logged-in handle: the header has a /profile/<handle> link in the top-right.
  function scrapeHandle() {
    // The user menu links to their own profile; prefer the header lang-chooser area.
    const sels = [
      "#header a[href^='/profile/']",
      ".lang-chooser a[href^='/profile/']",
      "a.user-link[href^='/profile/']"
    ];
    for (const sel of sels) {
      const a = document.querySelector(sel);
      if (a) {
        const m = a.getAttribute("href").match(/\/profile\/([^/?#]+)/);
        if (m) return decodeURIComponent(m[1]);
      }
    }
    return null;
  }

  const onHomepage = () => location.pathname === "/" || /^\/$/.test(location.pathname);

  // ── deterministic per-day RNG (mulberry32 seeded from date+handle) ──────────
  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── solved set (distinct contestId-index) from submissions ──────────────────
  function solvedSet(submissions) {
    const solved = new Set();
    for (const s of submissions) {
      if (s.verdict !== "OK") continue;
      const p = s.problem || {};
      solved.add((p.contestId != null ? p.contestId : "x") + "-" + (p.index || "?"));
    }
    return solved;
  }

  // ── streak math in LOCAL timezone (days with >=1 accepted submission) ────────
  function computeStreaks(submissions) {
    const acDays = new Set();
    let lastActive = null;
    for (const s of submissions) {
      if (s.verdict !== "OK" || !s.creationTimeSeconds) continue;
      const d = new Date(s.creationTimeSeconds * 1000); // local TZ
      const key = ymd(d);
      acDays.add(key);
      if (lastActive == null || key > lastActive) lastActive = key;
    }
    if (!acDays.size) return { current: 0, longest: 0, lastActive: null };

    // longest run
    const sorted = Array.from(acDays).sort();
    let longest = 0;
    for (const day of sorted) {
      const prev = new Date(day); prev.setDate(prev.getDate() - 1);
      if (acDays.has(ymd(prev))) continue; // not a run start
      let len = 0; const cur = new Date(day);
      while (acDays.has(ymd(cur))) { len++; cur.setDate(cur.getDate() + 1); }
      if (len > longest) longest = len;
    }

    // current: walk back from today (allow today not yet active -> start yesterday)
    let current = 0;
    const probe = new Date(); probe.setHours(0, 0, 0, 0);
    if (!acDays.has(ymd(probe))) probe.setDate(probe.getDate() - 1);
    while (acDays.has(ymd(probe))) { current++; probe.setDate(probe.getDate() - 1); }

    return { current, longest, lastActive };
  }

  // ── pick a deterministic-per-day problem within the rating band ─────────────
  // band tuned to user rating ~[r-100, r+200]; default 1100-1400 if unknown.
  function ratingBand(rating, preference) {
    const exact = Number(preference);
    if (preference !== "auto" && Number.isFinite(exact) && exact >= 800) return [exact, exact];
    if (rating == null) return [1100, 1400];
    return [Math.max(800, rating - 100), rating + 200];
  }

  // Filter problemset to candidates: have a rating in band, contestId+index, unsolved.
  function candidates(problems, band, solved) {
    const [lo, hi] = band;
    return problems.filter((p) => {
      if (p.rating == null || p.contestId == null || !p.index) return false;
      if (p.rating < lo || p.rating > hi) return false;
      return !solved.has(p.contestId + "-" + p.index);
    });
  }

  function problemUrl(p) {
    return "https://codeforces.com/problemset/problem/" + p.contestId + "/" + p.index;
  }

  // Pick the Nth (deterministic) candidate. `nudge` lets "pick another" advance
  // within the same day deterministically without re-fetching.
  function pickProblem(problems, band, solved, seedStr, nudge) {
    const cand = candidates(problems, band, solved);
    if (!cand.length) return null;
    const rng = mulberry32(hashStr(seedStr) + (nudge || 0) * 2654435761 >>> 0);
    const idx = Math.floor(rng() * cand.length);
    const p = cand[idx];
    return {
      contestId: p.contestId,
      index: p.index,
      name: p.name,
      rating: p.rating,
      url: problemUrl(p),
      band
    };
  }

  // Cache the heavy problemset list to avoid refetching all problems each load.
  const PS_CACHE = "cpos.daily.problemsetCache"; // { fetchedAt, problems:[{contestId,index,name,rating}] }
  async function getProblemset() {
    const now = Date.now();
    const cached = (await get([PS_CACHE]))[PS_CACHE];
    if (cached && cached.problems && now - cached.fetchedAt < 12 * 3600 * 1000) return cached.problems;
    const res = await cfApi("problemset.problems", "");
    const problems = (res.problems || []).map((p) => ({
      contestId: p.contestId, index: p.index, name: p.name, rating: p.rating
    }));
    await set({ [PS_CACHE]: { fetchedAt: now, problems } });
    return problems;
  }

  // ── main compute: refresh daily problem (if stale) + streak ─────────────────
  async function refresh() {
    const handle = scrapeHandle();
    if (handle) await set({ [K_HANDLE]: handle });

    let rating = null, submissions = [];
    try {
      if (handle) {
        const [info, subs] = await Promise.all([
          cfApi("user.info", "handles=" + encodeURIComponent(handle)).then((r) => r[0]).catch(() => null),
          cfApi("user.status", "handle=" + encodeURIComponent(handle) + "&from=1&count=100000").catch(() => [])
        ]);
        rating = info ? info.rating : null;
        submissions = Array.isArray(subs) ? subs : [];
      }
    } catch (e) { /* degrade gracefully */ }

    // Streak (only meaningful with submissions; otherwise zeros).
    const streak = Object.assign(computeStreaks(submissions), { computedAt: Date.now() });
    await set({ [K_STREAK]: streak });

    // Daily problem — only recompute if the stored one is from a previous day.
    const storedData = await get([K_DAILY, K_RATING]);
    const stored = storedData[K_DAILY];
    const ratingPreference = storedData[K_RATING] || "auto";
    const today = todayStr();
    if (!stored || stored.date !== today || stored.ratingPreference !== ratingPreference) {
      let problems = [];
      try { problems = await getProblemset(); } catch (e) { problems = []; }
      if (problems.length) {
        const solved = solvedSet(submissions);
        const band = ratingBand(rating, ratingPreference);
        const seed = today + "|" + (handle || "anon");
        const pick = pickProblem(problems, band, solved, seed, 0);
        if (pick) await set({ [K_DAILY]: Object.assign({ date: today, seed, nudge: 0, ratingPreference }, pick) });
        else await set({ [K_DAILY]: null });
      }
    }
  }

  // ── optional dismissible banner on the homepage only ────────────────────────
  function removeBanner() { document.getElementById(BANNER_ID)?.remove(); }

  // Codeforces rating tier colour (matches CF's tiers; cool→warm with difficulty).
  function tierColor(r) {
    const n = Number(r);
    if (!Number.isFinite(n)) return "var(--dim)";
    if (n < 1200) return "#9aa0a6"; // gray
    if (n < 1400) return "#42c267"; // green
    if (n < 1600) return "#41b5b3"; // cyan
    if (n < 1900) return "#7aa2f7"; // blue
    if (n < 2100) return "#c77dff"; // violet
    if (n < 2400) return "#f0a13e"; // orange
    return "#ff5b5b"; // red
  }
  // Tinted-chip recipe shared with the rest of the popup UI.
  function tintChip(node, token) {
    node.style.background = "color-mix(in srgb, " + token + " 16%, transparent)";
    node.style.color = token;
    node.style.border = "1px solid color-mix(in srgb, " + token + " 40%, transparent)";
    node.style.borderRadius = "var(--radius-pill, 999px)";
  }

  async function applyBannerTheme(node) {
    if (!T) return;
    try { T.applyTheme(node, await (C.activePageThemeId ? C.activePageThemeId() : C.activeThemeId())); } catch (e) { /* ignore */ }
  }

  async function maybeBanner() {
    if (!onHomepage()) return removeBanner();
    const data = await get([K_DAILY, K_DISMISS]);
    const daily = data[K_DAILY];
    if (!daily || daily.date !== todayStr()) return removeBanner();
    if (data[K_DISMISS] === todayStr()) return removeBanner();
    if (document.getElementById(BANNER_ID)) return;

    const node = document.createElement("div");
    node.id = BANNER_ID;
    node.className = "cpos-daily-banner";
    const hasRating = daily.rating != null && daily.rating !== "";
    node.innerHTML =
      '<span class="cpos-db-badge">CPOS</span>' +
      '<span class="cpos-db-label">Problem of the day</span>' +
      '<a class="cpos-db-link" href="' + esc(daily.url) + '" target="_blank" rel="noopener">' +
      esc(daily.name) + '</a>' +
      (hasRating ? '<span class="cpos-db-rating">' + esc(daily.rating) + '</span>' : '') +
      '<button class="cpos-db-x" title="Dismiss for today" aria-label="Dismiss">' +
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>' +
      '</button>';

    // Deliberate-callout framing: a quiet accent rule, not a generic toast.
    node.style.borderLeft = "3px solid var(--accent)";
    // Spend accent as currency: soften the solid CPOS pill into a tinted chip.
    const badge = node.querySelector(".cpos-db-badge");
    if (badge) tintChip(badge, "var(--accent)");
    // Tint the rating pill by Codeforces tier (cool → warm with difficulty).
    const ratingPill = node.querySelector(".cpos-db-rating");
    if (ratingPill) tintChip(ratingPill, tierColor(daily.rating));

    await applyBannerTheme(node);
    node.querySelector(".cpos-db-x").addEventListener("click", async () => {
      await set({ [K_DISMISS]: todayStr() });
      removeBanner();
    });
    const anchor = document.querySelector("#pageContent") || document.body;
    anchor.insertBefore(node, anchor.firstChild);
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────
  async function sync() {
    const on = await C.feature("dailyProblem");
    if (!on) { removeBanner(); return; }
    try { await refresh(); } catch (e) { console.debug("CPOS daily:", e); }
    await maybeBanner();
  }

  C.onChange((changes) => {
    if (changes[C.KEYS.FEATURES]) sync();
    else {
      const node = document.getElementById(BANNER_ID);
      if (node) applyBannerTheme(node);
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[K_RATING]) sync();
  });
  sync();
})();
