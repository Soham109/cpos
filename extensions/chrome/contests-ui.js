// CPOS contest reminders — popup UI. Self-contained IIFE that renders into the
// #cpos-contests-section container if the popup includes it. Reads/writes the
// "cpos.contests.*" storage keys and talks to the background module by message.
// Uses inherited theme CSS vars (the popup applies them to <body>).
(function () {
  const root = document.getElementById("cpos-contests-section");
  if (!root) return; // popup didn't include the section — do nothing
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;

  const FEATURE_KEY = "contestReminders";
  const FEATURES_STORE_KEY = "cpos.features";
  const K = {
    LIST: "cpos.contests.list",
    REMINDERS: "cpos.contests.reminders",
    LEAD: "cpos.contests.leadMinutes"
  };
  const DEFAULT_LEAD = 30;
  const LEAD_OPTIONS = [10, 15, 30, 60, 120];

  const store = chrome.storage.local;
  const get = (keys) => new Promise((res) => store.get(keys, (v) => res(v || {})));
  const set = (obj) => new Promise((res) => store.set(obj, () => res()));

  function sendMsg(msg) {
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage(msg, (reply) => {
          void chrome.runtime.lastError; // swallow "no receiver"
          res(reply || null);
        });
      } catch {
        res(null);
      }
    });
  }

  let state = { contests: [], reminders: {}, lead: DEFAULT_LEAD, featureOn: true, loading: true };

  async function loadState() {
    const raw = await get([K.LIST, K.REMINDERS, K.LEAD, FEATURES_STORE_KEY]);
    const list = raw[K.LIST] || {};
    const features = raw[FEATURES_STORE_KEY] || {};
    state.contests = list.contests || [];
    state.reminders = raw[K.REMINDERS] || {};
    const n = Number(raw[K.LEAD]);
    state.lead = Number.isFinite(n) && n > 0 ? n : DEFAULT_LEAD;
    state.featureOn = features[FEATURE_KEY] !== false; // default on
  }

  function fmtCountdown(startSeconds) {
    const ms = startSeconds * 1000 - Date.now();
    if (ms <= 0) return "starting";
    const mins = Math.floor(ms / 60000);
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (d > 0) return `in ${d}d ${h}h`;
    if (h > 0) return `in ${h}h ${m}m`;
    return `in ${m}m`;
  }
  // Proximity bucket for color-grading the countdown. Reserve --accent.
  function countdownClass(startSeconds) {
    const ms = startSeconds * 1000 - Date.now();
    if (ms < 60 * 60 * 1000) return "cc-cd is-soon"; // < 1h
    if (ms < 24 * 60 * 60 * 1000) return "cc-cd is-near"; // < 24h
    return "cc-cd is-far";
  }
  // Compact contest length, e.g. "2h", "90m", "2h 30m".
  function fmtDuration(durationSeconds) {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return "";
    const mins = Math.round(durationSeconds / 60);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h <= 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }
  function fmtLocal(startSeconds) {
    try {
      return new Date(startSeconds * 1000).toLocaleString([], {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch {
      return "";
    }
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Inline SVG icon (24x24 viewBox, stroke=currentColor) built without innerHTML
  // so it stays CSP-safe. `paths` is an array of path "d" strings.
  const SVG_NS = "http://www.w3.org/2000/svg";
  function icon(paths, label) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    if (label) {
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", label);
    } else {
      svg.setAttribute("aria-hidden", "true");
    }
    for (const d of paths) {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    }
    return svg;
  }
  // Circular-arrow refresh glyph.
  const REFRESH_PATHS = [
    "M3 12a9 9 0 0 1 15-6.7L21 8",
    "M21 3v5h-5",
    "M21 12a9 9 0 0 1-15 6.7L3 16",
    "M3 21v-5h5"
  ];

  function render() {
    root.innerHTML = "";

    const head = el("div", "cc-head");
    const titles = el("div", "cc-titles");
    titles.appendChild(el("span", "cc-title", "Upcoming contests"));
    titles.appendChild(el("span", "cc-scope", "Codeforces · upcoming"));
    head.appendChild(titles);
    const refresh = el("button", "cc-refresh");
    refresh.type = "button";
    refresh.title = "Refresh contests";
    refresh.setAttribute("aria-label", "Refresh contests");
    refresh.appendChild(icon(REFRESH_PATHS)); // button carries the label; icon is decorative
    if (state.loading) refresh.classList.add("is-busy");
    refresh.onclick = () => doRefresh(true);
    head.appendChild(refresh);
    root.appendChild(head);

    // Global lead selector.
    const leadRow = el("div", "cc-lead");
    leadRow.appendChild(el("span", "cc-lead-label", "Remind me"));
    const sel = el("select", "cc-select");
    for (const v of LEAD_OPTIONS) {
      const o = el("option", null, v >= 60 ? `${v / 60} h before` : `${v} min before`);
      o.value = String(v);
      if (v === state.lead) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = async () => {
      state.lead = Number(sel.value);
      await set({ [K.LEAD]: state.lead });
    };
    leadRow.appendChild(sel);
    root.appendChild(leadRow);

    if (!state.featureOn) {
      root.appendChild(el("div", "cc-empty", "Contest reminders are off. Enable them above."));
      return;
    }
    if (state.loading && state.contests.length === 0) {
      const skel = el("div", "cc-skeleton");
      skel.setAttribute("aria-label", "Loading contests");
      skel.setAttribute("aria-busy", "true");
      for (let i = 0; i < 3; i++) {
        const row = el("div", "cc-skel-row");
        const lines = el("div", "cc-skel-lines");
        lines.appendChild(el("span", "cc-skel-bar cc-skel-name"));
        lines.appendChild(el("span", "cc-skel-bar cc-skel-meta"));
        row.appendChild(lines);
        row.appendChild(el("span", "cc-skel-bar cc-skel-sw"));
        skel.appendChild(row);
      }
      root.appendChild(skel);
      return;
    }
    if (state.contests.length === 0) {
      root.appendChild(
        el("div", "cc-empty", "No contests scheduled yet — check back after the next round is announced.")
      );
      return;
    }

    const listEl = el("div", "cc-list");
    for (const c of state.contests) {
      const item = el("div", "cc-item");

      const info = el("div", "cc-info");
      info.appendChild(el("div", "cc-name", c.name));
      const meta = el("div", "cc-meta");
      meta.appendChild(el("span", "cc-when", fmtLocal(c.startTimeSeconds)));
      meta.appendChild(el("span", countdownClass(c.startTimeSeconds), fmtCountdown(c.startTimeSeconds)));
      const dur = fmtDuration(c.durationSeconds);
      if (dur) meta.appendChild(el("span", "cc-dur", dur));
      info.appendChild(meta);
      item.appendChild(info);

      const sw = el("label", "cc-sw");
      const inp = document.createElement("input");
      inp.type = "checkbox";
      inp.checked = !!state.reminders[c.id];
      inp.title = "Remind me before this contest";
      inp.onchange = async () => {
        if (inp.checked) state.reminders[c.id] = true;
        else delete state.reminders[c.id];
        await set({ [K.REMINDERS]: state.reminders });
      };
      sw.appendChild(inp);
      sw.appendChild(el("span"));
      item.appendChild(sw);

      listEl.appendChild(item);
    }
    root.appendChild(listEl);
  }

  async function doRefresh(force) {
    state.loading = true;
    render();
    const reply = await sendMsg({ type: "cpos-contests-refresh", force: !!force });
    if (reply && reply.ok && Array.isArray(reply.contests)) {
      state.contests = reply.contests;
    } else {
      // Background unavailable — fall back to whatever is in storage.
      await loadState();
    }
    state.loading = false;
    render();
  }

  // Keep countdowns live while the popup stays open: re-render every 30s so the
  // "in 2d 3h" text and its proximity color stay accurate. Cleared on teardown.
  let tickTimer = null;
  function startTick() {
    if (tickTimer != null) return;
    tickTimer = setInterval(() => {
      // Cheap: re-render at most ~30 rows; recomputes countdowns + grading.
      if (state.featureOn && state.contests.length > 0) render();
    }, 30000);
  }
  function teardown() {
    if (tickTimer != null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }
  window.addEventListener("pagehide", teardown);
  window.addEventListener("unload", teardown);

  // React to background updates / toggles flipped elsewhere in the popup.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[K.LIST] || changes[K.REMINDERS] || changes[K.LEAD] || changes[FEATURES_STORE_KEY]) {
      loadState().then(render);
    }
  });

  (async function init() {
    await loadState();
    render();
    startTick();
    doRefresh(false);
  })();
})();
