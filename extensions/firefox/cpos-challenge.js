// CPOS Challenge — Codeforces page content script.
//   • Detects the logged-in handle and remembers it (needed to track the user's
//     own submissions for the race).
//   • When a challenge link (…/?cposc=<payload>) is opened, shows an accept /
//     decline banner. Accepting records the challenge and opens the problem so
//     CPOS captures it into VS Code / the terminal; the background module then
//     watches Codeforces for who solves first.
// Read-only w.r.t. Codeforces, feature-flagged ("challenges"), fully isolated.
(function () {
  const C = self.CPOSChallenge;
  if (!C || typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;

  const store = chrome.storage.local;
  const get = (keys) => new Promise((res) => store.get(keys, (v) => res(v || {})));
  const set = (obj) => new Promise((res) => store.set(obj, () => res()));

  async function featureOn() {
    return true; // Challenges is always on (no toggle); handle detection + link import always run.
  }

  // ---- detect + persist the logged-in handle ---------------------------------
  function detectHandle() {
    // The logged-in handle is the profile link beside the "Logout" control in the
    // top bar. Keying off Logout avoids grabbing the profile you happen to be
    // VIEWING (e.g. /profile/someone-else).
    const logout =
      document.querySelector('#header a[href*="/logout"]') ||
      document.querySelector('a[href*="action=logout"]') ||
      document.querySelector('a[href*="/logout"]');
    if (!logout) return null; // not logged in (or can't tell) — never guess
    let scope = logout.parentElement;
    for (let i = 0; i < 4 && scope; i++) {
      const a = scope.querySelector('a[href^="/profile/"]');
      if (a) {
        const m = (a.getAttribute("href") || "").match(/\/profile\/([^/?#]+)/);
        if (m) return decodeURIComponent(m[1]);
      }
      scope = scope.parentElement;
    }
    return null;
  }
  async function rememberHandle() {
    const h = detectHandle();
    if (!h) return;
    const raw = await get([C.HANDLE_KEY, "cpos.cf.handleManual"]);
    if (raw["cpos.cf.handleManual"]) return; // user set it explicitly (e.g. in VS Code) — don't override
    if (raw[C.HANDLE_KEY] !== h) await set({ [C.HANDLE_KEY]: h });
  }

  // ---- read a challenge link from the URL ------------------------------------
  function readLinkPayload() {
    try {
      const sp = new URLSearchParams(location.search);
      if (sp.get(C.LINK_PARAM)) return sp.get(C.LINK_PARAM);
      const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
      const hp = new URLSearchParams(hash);
      if (hp.get(C.LINK_PARAM)) return hp.get(C.LINK_PARAM);
    } catch (_) {}
    return null;
  }
  function stripLinkParam() {
    try {
      const url = new URL(location.href);
      url.searchParams.delete(C.LINK_PARAM);
      const clean = url.pathname + (url.searchParams.toString() ? "?" + url.searchParams.toString() : "");
      history.replaceState({}, "", clean || "/");
    } catch (_) {}
  }

  // ---- UI ---------------------------------------------------------------------
  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  function removeBanner() {
    const b = document.getElementById("cpos-chal-banner");
    if (b) b.remove();
  }

  function showBanner(dec, myHandle) {
    removeBanner();
    const card = el(
      "div",
      "position:fixed;top:16px;right:16px;z-index:2147483600;max-width:370px;" +
        "background:#1d1b29;color:#ececf4;border:1px solid #b794ff;border-radius:14px;" +
        "padding:16px 18px;box-shadow:0 10px 34px rgba(0,0,0,.45);" +
        "font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;"
    );
    card.id = "cpos-chal-banner";

    const head = el("div", "display:flex;align-items:center;gap:8px;font-weight:700;font-size:14px;margin-bottom:8px;");
    head.appendChild(el("span", "font-size:16px;", "⚔️"));
    head.appendChild(el("span", null, "CPOS Challenge"));
    card.appendChild(head);

    const fromTxt = dec.from ? dec.from : "Someone";
    card.appendChild(el("div", "margin-bottom:4px;", `${fromTxt} challenges you to:`));
    const prob = el("a", "color:#b794ff;font-weight:600;text-decoration:none;display:block;margin-bottom:6px;", C.problemLabel(dec.problem));
    prob.href = safeHref(dec.problem.url);
    prob.target = "_blank";
    card.appendChild(prob);
    card.appendChild(
      el(
        "div",
        "opacity:.75;font-size:12px;margin-bottom:12px;",
        `First to get Accepted wins · ${dec.durationMin} min · verified on Codeforces`
      )
    );

    if (dec.to && myHandle && dec.to.toLowerCase() !== myHandle.toLowerCase()) {
      card.appendChild(
        el("div", "color:#ffcf6b;font-size:12px;margin-bottom:10px;", `Note: addressed to ${dec.to}. You can still accept as ${myHandle}.`)
      );
    }

    const btnRow = el("div", "display:flex;gap:8px;");
    const btnStyle =
      "flex:1;padding:8px 10px;border-radius:9px;border:0;cursor:pointer;font-weight:600;font-size:13px;";

    if (!myHandle) {
      const note = el(
        "div",
        "color:#ffcf6b;font-size:12px;margin-bottom:10px;",
        "Log in to Codeforces to accept (CPOS needs your handle to track the race)."
      );
      card.appendChild(note);
    }

    const accept = el("button", btnStyle + "background:#7c5cff;color:#fff;" + (myHandle ? "" : "opacity:.5;cursor:not-allowed;"), "Accept");
    const decline = el("button", btnStyle + "background:#2c2a3a;color:#cfcfe0;", "Decline");
    const dismiss = el("button", btnStyle + "background:transparent;color:#9a9ab0;flex:0 0 auto;padding:8px 10px;", "✕");

    accept.onclick = async () => {
      if (!myHandle) return;
      await acceptChallenge(dec, myHandle);
      stripLinkParam();
      showAccepted(dec);
    };
    decline.onclick = async () => {
      await declineChallenge(dec, myHandle);
      stripLinkParam();
      removeBanner();
    };
    dismiss.onclick = () => removeBanner();

    btnRow.appendChild(accept);
    btnRow.appendChild(decline);
    btnRow.appendChild(dismiss);
    card.appendChild(btnRow);

    (document.body || document.documentElement).appendChild(card);
  }

  function showAccepted(dec) {
    removeBanner();
    const card = el(
      "div",
      "position:fixed;top:16px;right:16px;z-index:2147483600;max-width:370px;" +
        "background:#16221a;color:#dfeede;border:1px solid #3fb950;border-radius:14px;" +
        "padding:16px 18px;box-shadow:0 10px 34px rgba(0,0,0,.45);" +
        "font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;"
    );
    card.id = "cpos-chal-banner";
    card.appendChild(el("div", "font-weight:700;font-size:14px;margin-bottom:6px;", "✅ Challenge accepted — go!"));
    card.appendChild(el("div", "margin-bottom:10px;", `Solve ${C.problemLabel(dec.problem)} and submit. CPOS will announce the winner.`));
    const open = el("a", "display:inline-block;background:#3fb950;color:#06210f;padding:8px 12px;border-radius:9px;font-weight:700;text-decoration:none;", "Open the problem →");
    open.href = dec.problem.url;
    open.target = "_blank";
    card.appendChild(open);
    (document.body || document.documentElement).appendChild(card);
    setTimeout(removeBanner, 9000);
  }

  // ---- accept / decline -------------------------------------------------------
  function challengeFromLink(dec, myHandle, status) {
    return {
      id: dec.id,
      role: "in",
      me: myHandle,
      opponent: dec.from || "",
      problem: dec.problem,
      createdAt: dec.createdAt || Date.now(),
      durationMin: dec.durationMin || 60,
      nonce: dec.nonce || "",
      status,
      myAcSec: null,
      oppAcSec: null,
      polled: false,
      notified: false,
      acceptedAt: Date.now()
    };
  }

  async function acceptChallenge(dec, myHandle) {
    const raw = await get([C.STORE_KEY]);
    const map = raw[C.STORE_KEY] || {};
    if (!map[dec.id] || map[dec.id].status === C.STATUS.DECLINED) {
      map[dec.id] = challengeFromLink(dec, myHandle, C.STATUS.ACTIVE);
      await set({ [C.STORE_KEY]: map });
    }
    // Open the problem so the existing capture flow creates the file in VS Code.
    try { window.open(dec.problem.url, "_blank", "noopener"); } catch (_) {}
    // Nudge the background module to begin polling right away.
    try { chrome.runtime.sendMessage({ type: "cpos-challenge-poll" }, () => void chrome.runtime.lastError); } catch (_) {}
  }

  async function declineChallenge(dec, myHandle) {
    const raw = await get([C.STORE_KEY]);
    const map = raw[C.STORE_KEY] || {};
    if (!map[dec.id]) {
      map[dec.id] = challengeFromLink(dec, myHandle || "", C.STATUS.DECLINED);
      await set({ [C.STORE_KEY]: map });
    }
  }

  // Defense-in-depth: never render/open a non-http(s) URL. decode() already
  // sanitizes invite URLs at the source, but invites ride a public relay so the
  // href/window.open sinks stay guarded too (blocks javascript:/data: URLs).
  function safeHref(u) { const s = String(u || ""); return /^https?:\/\//i.test(s) ? s : "#"; }

  // ---- accept / decline a challenge already stored (ntfy-delivered) -----------
  // Unlike acceptChallenge() (link flow), this updates the EXISTING entry the
  // background wrote on invite, flips it to ACTIVE, and replies over the relay.
  async function acceptStored(ch) {
    const raw = await get([C.STORE_KEY]);
    const map = raw[C.STORE_KEY] || {};
    const cur = map[ch.id] || ch;
    cur.status = C.STATUS.ACTIVE;
    cur.acceptedAt = Date.now();
    if (!cur.me) cur.me = detectHandle() || cur.me || "";
    map[ch.id] = cur;
    await set({ [C.STORE_KEY]: map });
    // Poll nudges the background, which publishes the accept reply via
    // publishPending — one publish path (no duplicate netSend race).
    try { chrome.runtime.sendMessage({ type: "cpos-challenge-poll" }, () => void chrome.runtime.lastError); } catch (_) {}
    const url = safeHref((cur.problem && cur.problem.url) || (ch.problem && ch.problem.url));
    if (url !== "#") { try { window.open(url, "_blank", "noopener"); } catch (_) {} }
  }
  async function declineStored(ch) {
    const raw = await get([C.STORE_KEY]);
    const map = raw[C.STORE_KEY] || {};
    const cur = map[ch.id] || ch;
    cur.status = C.STATUS.DECLINED;
    map[ch.id] = cur;
    await set({ [C.STORE_KEY]: map });
    try { chrome.runtime.sendMessage({ type: "cpos-challenge-net", action: "decline", challengeId: ch.id }, () => void chrome.runtime.lastError); } catch (_) {}
  }

  // ---- in-page popups for relay-delivered events -----------------------------
  // A themed top-right card shown when a friend challenges you (accept/decline
  // right there) or when your own challenge gets accepted. Distinct from the
  // link-flow banner (showBanner) and complements the OS notification.
  async function showIncoming(ch, myHandle) {
    const co = await themeColors();
    removeBanner();
    const card = el("div",
      "position:fixed;top:16px;right:16px;z-index:2147483600;max-width:370px;" +
      "background:" + co.bg + ";color:" + co.fg + ";border:1px solid " + co.accent + ";border-radius:14px;" +
      "padding:16px 18px;box-shadow:" + co.shadow + ";font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;");
    card.id = "cpos-chal-banner";
    const head = el("div", "display:flex;align-items:center;gap:8px;font-weight:700;font-size:14px;margin-bottom:8px;");
    head.appendChild(el("span", "font-size:16px;", "⚔️"));
    head.appendChild(el("span", null, "CPOS Challenge"));
    card.appendChild(head);
    card.appendChild(el("div", "margin-bottom:4px;", (ch.opponent || "Someone") + " challenges you to:"));
    const prob = el("a", "color:" + co.accent + ";font-weight:600;text-decoration:none;display:block;margin-bottom:6px;", C.problemLabel(ch.problem));
    prob.href = safeHref(ch.problem && ch.problem.url);
    prob.target = "_blank";
    card.appendChild(prob);
    card.appendChild(el("div", "opacity:.75;font-size:12px;margin-bottom:12px;", "First to get Accepted wins · " + (ch.durationMin || 60) + " min · verified on Codeforces"));
    const btnRow = el("div", "display:flex;gap:8px;");
    const btnStyle = "flex:1;padding:8px 10px;border-radius:9px;border:0;cursor:pointer;font-weight:600;font-size:13px;";
    const canAccept = !!(myHandle);
    const accept = el("button", btnStyle + "background:" + co.accent + ";color:" + co.accentOn + ";" + (canAccept ? "" : "opacity:.5;cursor:not-allowed;"), "Accept");
    const decline = el("button", btnStyle + "background:" + co.panel2 + ";color:" + co.fg + ";", "Decline");
    const dismiss = el("button", btnStyle + "background:transparent;color:" + co.dim + ";flex:0 0 auto;padding:8px 10px;", "✕");
    if (!canAccept) card.appendChild(el("div", "color:#ffcf6b;font-size:12px;margin:-4px 0 10px;", "Log in to Codeforces to accept (CPOS needs your handle)."));
    accept.onclick = async () => { if (!canAccept) return; removeBanner(); await acceptStored(ch); };
    decline.onclick = async () => { removeBanner(); await declineStored(ch); };
    dismiss.onclick = () => removeBanner();
    btnRow.append(accept, decline, dismiss);
    card.appendChild(btnRow);
    (document.body || document.documentElement).appendChild(card);
  }
  async function showAcceptedOut(ch) {
    const co = await themeColors();
    removeBanner();
    const card = el("div",
      "position:fixed;top:16px;right:16px;z-index:2147483600;max-width:370px;" +
      "background:" + co.bg + ";color:" + co.fg + ";border:1px solid #3fb950;border-radius:14px;" +
      "padding:16px 18px;box-shadow:" + co.shadow + ";font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;");
    card.id = "cpos-chal-banner";
    card.appendChild(el("div", "font-weight:700;font-size:14px;margin-bottom:6px;", "✅ Challenge accepted — race on!"));
    card.appendChild(el("div", "margin-bottom:10px;", (ch.opponent || "Your opponent") + " accepted. Solve " + C.problemLabel(ch.problem) + " first to win."));
    const open = el("a", "display:inline-block;background:#3fb950;color:#06210f;padding:8px 12px;border-radius:9px;font-weight:700;text-decoration:none;", "Open the problem →");
    open.href = safeHref(ch.problem && ch.problem.url);
    open.target = "_blank";
    card.appendChild(open);
    (document.body || document.documentElement).appendChild(card);
    setTimeout(removeBanner, 9000);
  }

  // Surfaced-event dedup: an in-memory Set guards this tab; a small persisted map
  // (SURFACED_KEY) guards across tabs and reloads, so a relay event shows a single
  // in-page popup even with several CF tabs open, and a tab opened AFTER the event
  // still surfaces it exactly once.
  const SURFACED_KEY = "cpos.challenge.surfaced";
  const announced = new Set();
  async function maybeSurface(kind, ch, myHandle) {
    const key = kind + ":" + ch.id;
    if (announced.has(key)) return;
    announced.add(key);
    const raw = await get([SURFACED_KEY]);
    const map = raw[SURFACED_KEY] || {};
    if (map[key]) return; // another tab/session already showed it
    map[key] = Date.now();
    const keys = Object.keys(map);
    if (keys.length > 80) keys.sort((a, b) => map[a] - map[b]).slice(0, keys.length - 60).forEach((k) => delete map[k]);
    await set({ [SURFACED_KEY]: map });
    if (kind === "in") await showIncoming(ch, myHandle);
    else await showAcceptedOut(ch);
  }
  async function announceChanges(change) {
    const oldMap = (change && change.oldValue) || {};
    const newMap = (change && change.newValue) || {};
    const myHandle = detectHandle() || "";
    for (const id of Object.keys(newMap)) {
      const cur = newMap[id];
      const prev = oldMap[id];
      if (!cur) continue;
      // A friend challenged me: a freshly-arrived pending incoming invite.
      if (cur.role === "in" && cur.status === C.STATUS.PENDING) {
        const wasPending = prev && prev.role === "in" && prev.status === C.STATUS.PENDING;
        if (!wasPending) await maybeSurface("in", cur, myHandle);
      }
      // My outgoing challenge was accepted: any non-active state -> active
      // (covers pending->active AND the bg's expired->active reactivation).
      else if (cur.role === "out" && cur.status === C.STATUS.ACTIVE) {
        const wasActive = prev && prev.status === C.STATUS.ACTIVE;
        if (!wasActive) await maybeSurface("acc", cur, myHandle);
      }
    }
  }
  // storage.onChanged only reaches already-open tabs, so surface a still-actionable
  // event that landed while no CF tab was open (the common "I never saw it" case).
  async function surfaceOnLoad() {
    const myHandle = detectHandle() || "";
    const list = Object.values((await get([C.STORE_KEY]))[C.STORE_KEY] || {}).filter(Boolean);
    const byNew = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
    const incoming = list.filter((c) => c.role === "in" && c.status === C.STATUS.PENDING).sort(byNew);
    if (incoming[0]) { await maybeSurface("in", incoming[0], myHandle); return; }
    const acceptedOut = list.filter((c) => c.role === "out" && c.status === C.STATUS.ACTIVE).sort(byNew);
    if (acceptedOut[0]) await maybeSurface("acc", acceptedOut[0], myHandle);
  }

  // One-time injected style for the "race in progress" icon pulse (the button is
  // otherwise inline-styled). Static ring under prefers-reduced-motion.
  function ensureChalStyle() {
    if (document.getElementById("cpos-chal-style")) return;
    const s = document.createElement("style");
    s.id = "cpos-chal-style";
    s.textContent =
      "@keyframes cpos-chal-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--cpos-chal-accent,#7c5cff) 55%,transparent)}70%{box-shadow:0 0 0 6px color-mix(in srgb,var(--cpos-chal-accent,#7c5cff) 0%,transparent)}100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--cpos-chal-accent,#7c5cff) 0%,transparent)}}" +
      ".cpos-chal-live{box-shadow:0 0 0 2px color-mix(in srgb,var(--cpos-chal-accent,#7c5cff) 45%,transparent)}" +
      "@media (prefers-reduced-motion: no-preference){.cpos-chal-live{animation:cpos-chal-pulse 1.6s ease-in-out infinite}}";
    (document.head || document.documentElement).appendChild(s);
  }

  // ---- on-page "Challenge" button (Codeforces problem pages) -----------------
  // crossed-swords icon (Lucide), tinted with the active theme's accent.
  const SWORDS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" y1="19" x2="19" y2="13"/><line x1="16" y1="16" x2="20" y2="20"/><line x1="19" y1="21" x2="21" y2="19"/><polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/><line x1="5" y1="14" x2="9" y2="18"/><line x1="7" y1="17" x2="4" y2="20"/><line x1="3" y1="19" x2="5" y2="21"/></svg>';

  // Resolve the active CPOS theme tokens so the button/popover match the site theme.
  async function themeColors() {
    const T = self.CPOS_THEMES, CFG = self.CPOS;
    let tk = null;
    try { if (T && CFG) tk = T.get(await (CFG.activePageThemeId ? CFG.activePageThemeId() : CFG.activeThemeId())); } catch (_) {}
    const g = (k, d) => (tk && tk[k]) || d;
    return {
      accent: g("--accent", "#7c5cff"),
      accentOn: g("--accent-on", "#ffffff"),
      bg: g("--panel", g("--bg", "#1d1b29")),
      fg: g("--fg", "#ececf4"),
      dim: g("--dim", "#9a9ab0"),
      border: g("--border", "#3a3550"),
      panel2: g("--panel-2", "#2c2a3a"),
      bad: g("--bad", "#e5534b"),
      // Softer than pure black so the floating card doesn't read muddy on light themes.
      shadow: "0 8px 28px rgba(0,0,0,0.26)"
    };
  }

  async function toast(text) {
    const co = await themeColors();
    const old = document.getElementById("cpos-chal-toast");
    if (old) old.remove();
    const t = el(
      "div",
      "position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:2147483600;border-radius:10px;padding:10px 16px;" +
        "background:" + co.bg + ";color:" + co.fg + ";border:1px solid " + co.accent + ";" +
        "font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;",
      text
    );
    t.id = "cpos-chal-toast";
    (document.body || document.documentElement).appendChild(t);
    setTimeout(() => { t.style.transition = "opacity .3s"; t.style.opacity = "0"; }, 2400);
    setTimeout(() => t.remove(), 2800);
  }

  async function createOnPageChallenge(prob, opponent) {
    const me = detectHandle();
    if (!me) { toast("Log in to Codeforces to challenge."); return; }
    const ch = {
      id: C.makeId(), role: "out", me, opponent: (opponent || "").trim(), problem: prob,
      createdAt: Date.now(), durationMin: 60, nonce: C.genNonce(), status: C.STATUS.PENDING,
      myAcSec: null, oppAcSec: null, polled: false, notified: false, online: true
    };
    const raw = await get([C.STORE_KEY]);
    const map = raw[C.STORE_KEY] || {};
    map[ch.id] = ch;
    await set({ [C.STORE_KEY]: map });
    // The background module publishes the invite (publishPending) on the next tick.
    try { chrome.runtime.sendMessage({ type: "cpos-challenge-poll" }, () => void chrome.runtime.lastError); } catch (_) {}
    toast(opponent ? `⚔️ Challenge sent to ${opponent}` : "⚔️ Open challenge posted — anyone can take it");
  }

  function closePopover() { const p = document.getElementById("cpos-chal-pop"); if (p) p.remove(); }

  async function openPopover(prob, anchor) {
    closePopover();
    const co = await themeColors();
    const r = anchor.getBoundingClientRect();
    const pop = el(
      "div",
      "position:fixed;z-index:2147483601;width:236px;border-radius:12px;padding:12px;" +
        "background:" + co.bg + ";color:" + co.fg + ";border:1px solid " + co.accent + ";" +
        "font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;"
    );
    pop.id = "cpos-chal-pop";
    pop.style.top = Math.min(window.innerHeight - 190, r.bottom + 6) + "px";
    pop.style.left = Math.max(8, Math.min(window.innerWidth - 244, r.left)) + "px";
    const head = el("div", "font-weight:700;margin-bottom:9px;display:flex;align-items:center;gap:7px;");
    head.innerHTML = '<span style="display:inline-flex;color:' + co.accent + '">' + SWORDS + '</span><span>Challenge — ' + prob.id + '</span>';
    pop.appendChild(head);
    const bcss = "width:100%;padding:8px;border:0;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px;margin-bottom:6px;font-family:inherit;";
    const friend = el("button", bcss + "background:" + co.accent + ";color:" + co.accentOn + ";", "Challenge a friend");
    const random = el("button", bcss + "background:" + co.panel2 + ";color:" + co.fg + ";", "Random opponent");
    const inputWrap = el("div", "display:none;");
    const inp = el("input", "width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;border:1px solid " + co.border + ";background:" + co.bg + ";color:" + co.fg + ";font:inherit;");
    inp.placeholder = "friend's handle";
    const sendBtn = el("button", bcss + "background:" + co.accent + ";color:" + co.accentOn + ";margin-top:6px;margin-bottom:0;", "Send");
    inputWrap.appendChild(inp); inputWrap.appendChild(sendBtn);
    friend.onclick = () => { inputWrap.style.display = "block"; random.style.display = "none"; friend.style.display = "none"; inp.focus(); };
    random.onclick = async () => { await createOnPageChallenge(prob, ""); closePopover(); };
    sendBtn.onclick = async () => { const h = inp.value.trim(); if (!h) { inp.focus(); return; } await createOnPageChallenge(prob, h); closePopover(); };
    pop.appendChild(friend); pop.appendChild(random); pop.appendChild(inputWrap);
    (document.body || document.documentElement).appendChild(pop);
    setTimeout(() => {
      const onDoc = (e) => {
        if (!pop.contains(e.target) && e.target !== anchor) { closePopover(); document.removeEventListener("mousedown", onDoc); }
      };
      document.addEventListener("mousedown", onDoc);
    }, 0);
  }

  // Small icon button to the right of the problem title. Flips to a Cancel state
  // when you already have a live challenge out for this problem. Themed + flat.
  async function renderChallengeButton() {
    const prob = C.parseProblem(location.href);
    if (!prob) return; // not a problem page
    const titleEl = document.querySelector(".problem-statement .title") || document.querySelector(".title");
    const old = document.getElementById("cpos-chal-btn");
    if (old) old.remove();
    if (titleEl) prob.name = titleEl.textContent.replace(/^[A-Z]\d*\.\s*/, "").trim();
    prob.rating = 0;

    const map = (await get([C.STORE_KEY]))[C.STORE_KEY] || {};
    const here = Object.keys(map).map((k) => map[k]).filter((c) => c && c.problem && c.problem.id === prob.id);
    // A live race (either side) takes priority over a still-pending invite I sent.
    const active = here.find((c) => c.status === C.STATUS.ACTIVE);
    const pendingOut = here.find((c) => c.role === "out" && c.status === C.STATUS.PENDING);

    const co = await themeColors();
    const base = "display:inline-flex!important;align-items:center!important;justify-content:center!important;vertical-align:middle;" +
      "margin-left:10px!important;width:30px!important;height:30px!important;min-width:30px!important;box-sizing:border-box!important;" +
      "border-radius:8px!important;cursor:pointer!important;padding:0!important;line-height:0!important;";
    const btn = el("button");
    btn.id = "cpos-chal-btn";

    if (active) {
      // Race in progress — pulsing accent swords, opens nothing destructive.
      ensureChalStyle();
      btn.style.cssText = base + "background:" + co.accent + "!important;color:" + co.accentOn + "!important;border:0!important;";
      btn.style.setProperty("--cpos-chal-accent", co.accent);
      btn.classList.add("cpos-chal-live");
      const opp = active.opponent || "your opponent";
      btn.title = "Challenge in progress vs " + opp + " — solve & submit to win";
      btn.setAttribute("aria-label", "Challenge in progress");
      btn.innerHTML = SWORDS;
      const swords = btn.querySelector("svg");
      if (swords) {
        swords.style.setProperty("display", "block", "important");
        swords.style.setProperty("fill", "none", "important");
        swords.style.setProperty("stroke", co.accentOn, "important");
      }
      btn.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        toast("⚔️ Race on vs " + opp + " — first Accepted wins");
      };
    } else if (pendingOut) {
      btn.style.cssText = base + "background:transparent!important;color:" + co.bad + "!important;border:1px solid " + co.bad + "!important;";
      btn.title = "Cancel your challenge to this problem";
      btn.setAttribute("aria-label", "Cancel challenge");
      btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="' + co.bad + '" stroke-width="2.6" stroke-linecap="round" style="display:block!important;fill:none!important;stroke:' + co.bad + '!important"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
      btn.onclick = async (e) => {
        e.preventDefault(); e.stopPropagation();
        const m = (await get([C.STORE_KEY]))[C.STORE_KEY] || {};
        if (m[pendingOut.id]) {
          m[pendingOut.id].status = C.STATUS.REMOVED;
          m[pendingOut.id].removedAt = Date.now();
        }
        await set({ [C.STORE_KEY]: m });
        toast("Challenge cancelled");
      };
    } else {
      btn.style.cssText = base + "background:" + co.accent + "!important;color:" + co.accentOn + "!important;border:0!important;";
      btn.title = "Challenge someone to this problem";
      btn.setAttribute("aria-label", "Challenge");
      btn.innerHTML = SWORDS;
      const swords = btn.querySelector("svg");
      if (swords) {
        swords.style.setProperty("display", "block", "important");
        swords.style.setProperty("fill", "none", "important");
        swords.style.setProperty("stroke", co.accentOn, "important");
      }
      btn.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (document.getElementById("cpos-chal-pop")) closePopover();
        else openPopover(prob, btn);
      };
    }

    if (titleEl) titleEl.appendChild(btn);
    else {
      btn.style.cssText += "position:fixed!important;bottom:18px!important;right:18px!important;z-index:2147483600!important;";
      btn.style.setProperty("width", "38px", "important");
      btn.style.setProperty("height", "38px", "important");
      btn.style.setProperty("min-width", "38px", "important");
      (document.body || document.documentElement).appendChild(btn);
    }
  }

  // ---- entry ------------------------------------------------------------------
  async function run() {
    if (!(await featureOn())) return;
    await rememberHandle();
    renderChallengeButton().catch(() => {});
    surfaceOnLoad().catch(() => {});

    const payload = readLinkPayload();
    if (!payload) return;
    const dec = C.decode(payload);
    if (!dec) return;

    const raw = await get([C.STORE_KEY]);
    const existing = (raw[C.STORE_KEY] || {})[dec.id];
    if (existing) { stripLinkParam(); return; } // already handled

    const myHandle = detectHandle();
    showBanner(dec, myHandle);
  }

  // Re-render the on-page button when challenges or the theme change.
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[C.STORE_KEY]) announceChanges(changes[C.STORE_KEY]).catch(() => {});
      if (changes[C.STORE_KEY] || changes["cpos.ui.theme"] || changes["cpos.features"] || changes["cpos.siteThemeId"]) {
        renderChallengeButton().catch(() => {});
      }
    });
  }

  run().catch(() => {});
})();
