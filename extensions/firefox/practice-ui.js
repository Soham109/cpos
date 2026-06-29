// CPOS practice popup module — self-contained IIFE that renders into the
// container element id "cpos-practice-section" if present in the popup. Shows:
//   · today's problem (link + rating) with a "pick another" (respects the band)
//   · current & longest practice streak
//   · the favorites list (each linking out, with a remove button)
// Reads/writes only chrome.storage.local ("cpos.daily.*","cpos.streak.*",
// "cpos.fav.*"). Reflects the dailyProblem/favorites feature flags. Uses the
// popup's inherited CSS vars (var(--accent), var(--panel), var(--fg), var(--dim),
// var(--border)). No network calls of its own — the content script populates the
// daily problem; "pick another" re-rolls within the cached band/problemset.
(function () {
  const MOUNT_ID = "cpos-practice-section";
  const mount = document.getElementById(MOUNT_ID);
  if (!mount) return;

  // storage keys (must match content scripts)
  const K_DAILY = "cpos.daily.problem";
  const K_STREAK = "cpos.streak.data";
  const K_FAV = "cpos.fav.list";
  const PS_CACHE = "cpos.daily.problemsetCache";
  const K_FEATURES = "cpos.features";
  const K_RATING = "cpos.daily.rating";
  const DEFAULT_FEATURES = (self.CPOS && self.CPOS.DEFAULT_FEATURES) || {};

  const store = chrome.storage.local;
  const get = (keys) => new Promise((res) => store.get(keys, (v) => res(v || {})));
  const set = (obj) => new Promise((res) => store.set(obj, () => res()));

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // CF tier color for a problem rating — same breakpoints as profile.js ratingColor().
  function tierColor(r) {
    const n = Number(r);
    if (r == null || !Number.isFinite(n)) return "var(--dim)";
    if (n < 1200) return "#9aa0a6"; // gray
    if (n < 1400) return "#42c267"; // green
    if (n < 1600) return "#41b5b3"; // cyan
    if (n < 1900) return "#7aa2f7"; // blue
    if (n < 2100) return "#c77dff"; // violet
    if (n < 2400) return "#f0a13e"; // orange
    return "#ff5b5b";               // red
  }
  // Tinted-chip inline style for a rating pill, colored by CF tier.
  function ratingPillStyle(r) {
    const c = tierColor(r);
    return "color:" + c +
      ";border-color:color-mix(in srgb," + c + " 40%,transparent)" +
      ";background:color-mix(in srgb," + c + " 14%,transparent)";
  }

  // Inline SVG close-X glyph (matches the icon contract).
  const ICON_X = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M5 5l14 14M19 5L5 19"/></svg>';

  // ── deterministic RNG (mirrors cpos-daily.js so "pick another" matches band) ─
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

  function featOn(features, name) {
    const v = features[name];
    return v !== false && (v === true || DEFAULT_FEATURES[name] === true || DEFAULT_FEATURES[name] === undefined);
  }

  // ── "pick another" — re-roll within the stored band over cached problemset ──
  async function pickAnother() {
    const data = await get([K_DAILY, PS_CACHE]);
    const daily = data[K_DAILY];
    const cache = data[PS_CACHE];
    if (!daily || !cache || !cache.problems) return;
    const band = daily.band || [1100, 1400];
    const [lo, hi] = band;
    const cand = cache.problems.filter(
      (p) => p.rating != null && p.contestId != null && p.index && p.rating >= lo && p.rating <= hi
    );
    if (!cand.length) return;
    const nudge = (daily.nudge || 0) + 1;
    const rng = mulberry32((hashStr(daily.seed || daily.date || "") + nudge * 2654435761) >>> 0);
    const p = cand[Math.floor(rng() * cand.length)];
    await set({
      [K_DAILY]: Object.assign({}, daily, {
        nudge,
        contestId: p.contestId,
        index: p.index,
        name: p.name,
        rating: p.rating,
        url: "https://codeforces.com/problemset/problem/" + p.contestId + "/" + p.index
      })
    });
    render();
  }

  async function removeFav(id) {
    const list = (await get([K_FAV]))[K_FAV] || [];
    await set({ [K_FAV]: list.filter((f) => f.id !== id) });
    render();
  }

  // ── render ──────────────────────────────────────────────────────────────────
  async function render() {
    const data = await get([K_DAILY, K_STREAK, K_FAV, K_FEATURES, K_RATING]);
    const features = data[K_FEATURES] || {};
    const dailyOn = featOn(features, "dailyProblem");
    const favOn = featOn(features, "favorites");
    const daily = data[K_DAILY];
    const streak = data[K_STREAK] || { current: 0, longest: 0 };
    const favs = data[K_FAV] || [];
    const ratingPreference = data[K_RATING] || "auto";
    const ratingOptions = ['<option value="auto">Auto</option>'];
    for (let rating = 800; rating <= 3500; rating += 100) {
      ratingOptions.push('<option value="' + rating + '"' + (String(rating) === String(ratingPreference) ? ' selected' : '') + '>' + rating + '</option>');
    }
    if (ratingPreference === "auto") ratingOptions[0] = '<option value="auto" selected>Auto</option>';

    // The popup card already renders the "Practice" header — don't repeat it.
    let html = '';

    // Daily problem
    html += '<div class="cpos-pr-rating-pick"><label for="cpos-daily-rating">Daily rating</label>'
      + '<select id="cpos-daily-rating">' + ratingOptions.join('') + '</select></div>';
    if (!dailyOn) {
      html += '<div class="cpos-pr-block"><div class="cpos-pr-off">Daily problem is off. Enable it in Tools.</div></div>';
    } else if (daily && daily.url) {
      html +=
        '<div class="cpos-pr-block"><div class="cpos-pr-sub">Problem of the day' +
        (daily.band ? ' · ' + daily.band[0] + '–' + daily.band[1] : '') + '</div>' +
        '<div class="cpos-pr-daily">' +
        '<a class="cpos-pr-link" href="' + esc(daily.url) + '" target="_blank" rel="noopener">' +
        esc(daily.name || (daily.contestId + daily.index)) + '</a>' +
        (daily.rating != null ? '<span class="cpos-pr-rating" style="' + ratingPillStyle(daily.rating) + '">' + esc(daily.rating) + '</span>' : '') +
        '</div>' +
        '<button class="cpos-pr-btn" id="cpos-pr-another">Pick another</button></div>';
    } else {
      html += '<div class="cpos-pr-block"><div class="cpos-pr-off">Open Codeforces (logged in) to generate today’s problem.</div></div>';
    }

    // Streak
    if (dailyOn) {
      html +=
        '<div class="cpos-pr-block"><div class="cpos-pr-streaks">' +
        '<div class="cpos-pr-stat"><b>' + (streak.current || 0) + '</b><span>current streak</span></div>' +
        '<div class="cpos-pr-stat"><b>' + (streak.longest || 0) + '</b><span>longest streak</span></div>' +
        '</div></div>';
    }

    // Favorites
    html += '<div class="cpos-pr-block"><div class="cpos-pr-sub">Favorites' +
      (favOn ? '<span class="cpos-pr-count"> · ' + favs.length + '</span>' : '') + '</div>';
    if (!favOn) {
      html += '<div class="cpos-pr-off">Favorites is off. Enable it in Tools.</div>';
    } else if (!favs.length) {
      html += '<div class="cpos-pr-off">No favorites yet. Star a problem on its page.</div>';
    } else {
      html += '<ul class="cpos-pr-favlist">';
      for (const f of favs) {
        html +=
          '<li class="cpos-pr-fav"><a class="cpos-pr-link" href="' + esc(f.url) + '" target="_blank" rel="noopener">' +
          esc(f.name || f.id) + '</a>' +
          (f.rating != null ? '<span class="cpos-pr-rating" style="' + ratingPillStyle(f.rating) + '">' + esc(f.rating) + '</span>' : '') +
          '<button class="cpos-pr-x" data-fav="' + esc(f.id) + '" title="Remove" aria-label="Remove">' + ICON_X + '</button></li>';
      }
      html += '</ul>';
    }
    html += '</div>';

    mount.innerHTML = html;

    const another = mount.querySelector("#cpos-pr-another");
    if (another) another.addEventListener("click", pickAnother);
    const ratingSelect = mount.querySelector("#cpos-daily-rating");
    if (ratingSelect) {
      ratingSelect.addEventListener("change", async () => {
        await set({ [K_RATING]: ratingSelect.value, [K_DAILY]: null });
        render();
      });
    }
    mount.querySelectorAll(".cpos-pr-x").forEach((b) => {
      b.addEventListener("click", () => removeFav(b.getAttribute("data-fav")));
    });
  }

  // Live-refresh if storage changes while the popup is open.
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[K_DAILY] || changes[K_STREAK] || changes[K_FAV] || changes[K_FEATURES] || changes[K_RATING]) render();
    });
  }

  render();
})();
