// CPOS Challenge — background module. Loaded into the MV3 service worker via
// importScripts('cpos-challenge-core.js','cpos-challenge-bg.js') (Chrome) or as
// background.scripts entries (Firefox). It owns its own chrome.alarms /
// chrome.notifications / onMessage listeners and NEVER touches the submit-pickup
// logic in background.js (same isolation contract as cpos-contests.js).
//
// Serverless referee: it polls the public Codeforces user.status API for both
// players and decides the winner by earliest accepted submission in the window.
(function () {
  if (typeof chrome === "undefined" || !chrome.alarms || !chrome.notifications || !chrome.storage || !chrome.storage.local) return;
  const C = self.CPOSChallenge;
  if (!C) return; // core must load first

  const FEATURES_STORE_KEY = "cpos.features";
  const POLL_ALARM = "cpos.challenge.poll";
  const POLL_PERIOD_MIN = 1; // CF AC detection cadence
  const NOTIF_PREFIX = "cpos.challenge.notif.";
  const ICON = "icons/icon128.png";

  const store = chrome.storage.local;
  const get = (keys) => new Promise((res) => store.get(keys, (v) => res(v || {})));
  const set = (obj) => new Promise((res) => store.set(obj, () => res()));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function featureEnabled() {
    return true; // Challenges is always on (no enable/disable toggle anymore).
  }
  async function notifyEnabled() {
    const raw = await get([C.NOTIFY_KEY]);
    return raw[C.NOTIFY_KEY] !== false; // default on
  }
  async function loadChallenges() {
    const raw = await get([C.STORE_KEY]);
    return raw[C.STORE_KEY] || {};
  }
  async function saveChallenges(map) {
    await set({ [C.STORE_KEY]: map });
  }
  function normalizeRange(range) {
    const a = Math.max(800, Math.min(3500, Number(range && range.min) || 800));
    const b = Math.max(800, Math.min(3500, Number(range && range.max) || 3500));
    return a <= b ? { min: a, max: b } : { min: b, max: a };
  }
  async function loadSettings() {
    const raw = await get([C.SETTINGS_KEY, "cpos.challenge.publicOn", "cpos.challenge.range"]);
    const saved = raw[C.SETTINGS_KEY];
    if (saved) {
      return {
        publicOn: saved.publicOn === true,
        range: normalizeRange(saved.range),
        updatedAt: Number(saved.updatedAt) || 0
      };
    }
    const migrated = {
      publicOn: raw["cpos.challenge.publicOn"] === true,
      range: normalizeRange(raw["cpos.challenge.range"]),
      updatedAt: Date.now()
    };
    await saveSettings(migrated);
    return migrated;
  }
  async function saveSettings(settings) {
    const value = {
      publicOn: settings.publicOn === true,
      range: normalizeRange(settings.range),
      updatedAt: Number(settings.updatedAt) || Date.now()
    };
    await set({
      [C.SETTINGS_KEY]: value,
      "cpos.challenge.publicOn": value.publicOn,
      "cpos.challenge.range": value.range
    });
    return value;
  }

  // ---- public CF API ----------------------------------------------------------
  async function userStatus(handle) {
    try {
      const url = `https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}&from=1&count=80`;
      const res = await fetch(url, { cache: "no-store", credentials: "omit" });
      if (!res.ok) return null;
      const j = await res.json();
      if (j.status !== "OK" || !Array.isArray(j.result)) return null;
      return j.result;
    } catch (_) {
      return null;
    }
  }

  // ---- notifications ----------------------------------------------------------
  async function notify(ch, title, message) {
    if (!chrome.notifications) return;
    if (!(await notifyEnabled())) return;
    try {
      chrome.notifications.create(NOTIF_PREFIX + ch.id, {
        type: "basic",
        iconUrl: chrome.runtime.getURL(ICON),
        title,
        message,
        priority: 2
      });
    } catch (_) {}
  }

  function resultMessage(ch) {
    const prob = C.problemLabel(ch.problem);
    const opp = ch.opponent || "your opponent";
    switch (ch.status) {
      case C.STATUS.WON: return { title: "🏆 Challenge won!", msg: `You solved ${prob} before ${opp}.` };
      case C.STATUS.LOST: return { title: "💀 Challenge lost", msg: `${opp} solved ${prob} first.` };
      case C.STATUS.DRAW: return { title: "🤝 Challenge draw", msg: `You and ${opp} solved ${prob} together.` };
      case C.STATUS.EXPIRED: return { title: "⏰ Challenge expired", msg: `Nobody solved ${prob} in time.` };
      default: return null;
    }
  }

  // ---- the poll ---------------------------------------------------------------
  // Resolve one challenge against fresh CF data. Returns true if it changed.
  async function pollChallenge(ch) {
    if (ch.status !== C.STATUS.ACTIVE) return false;
    if (!ch.me || !ch.opponent) return false; // open/untracked challenges resolve only on the acceptor's side; need both handles
    const startSec = Math.floor((ch.createdAt || 0) / 1000);
    const { contestId, index } = ch.problem || {};
    if (!contestId || !index) return false;

    const mySubs = await userStatus(ch.me);
    await sleep(350); // stay polite with CF's call limit
    const oppSubs = await userStatus(ch.opponent);

    let changed = false;
    if (mySubs) {
      const t = C.firstAcSeconds(mySubs, contestId, index, startSec);
      if (t != null && ch.myAcSec == null) { ch.myAcSec = t; changed = true; }
    }
    if (oppSubs) {
      const t = C.firstAcSeconds(oppSubs, contestId, index, startSec);
      if (t != null && ch.oppAcSec == null) { ch.oppAcSec = t; changed = true; }
    }
    // Track that we've successfully observed both sides at least once, so a
    // transient fetch failure can never wrongly mark a challenge expired.
    if (mySubs && oppSubs) { if (!ch.polled) { ch.polled = true; changed = true; } }

    const deadlinePassed = Date.now() > C.deadlineAt(ch) && !!ch.polled;
    const next = C.resolve(ch.myAcSec ?? null, ch.oppAcSec ?? null, deadlinePassed);
    if (next && next !== ch.status) {
      ch.status = next;
      ch.resolvedAt = Date.now();
      if (next === C.STATUS.WON || next === C.STATUS.DRAW) ch.winner = ch.me;
      else if (next === C.STATUS.LOST) ch.winner = ch.opponent;
      else ch.winner = "";
      changed = true;
      const r = resultMessage(ch);
      if (r && !ch.notified) { ch.notified = true; await notify(ch, r.title, r.msg); }
    }
    return changed;
  }

  async function pollAll() {
    if (!(await featureEnabled())) return;
    const map = await loadChallenges();
    const all = Object.values(map);
    let dirty = false;
    const now = Date.now();
    // Expire pending invites that were never accepted in time.
    for (const ch of all) {
      if (ch && ch.status === C.STATUS.PENDING && C.inviteExpired(ch, now)) {
        ch.status = C.STATUS.EXPIRED;
        map[ch.id] = ch;
        dirty = true;
      }
    }
    // Referee active challenges against Codeforces.
    for (const ch of all) {
      if (!ch || ch.status !== C.STATUS.ACTIVE) continue;
      try {
        const changed = await pollChallenge(ch);
        if (changed) { map[ch.id] = ch; dirty = true; }
      } catch (_) { /* one bad challenge never breaks the rest */ }
    }
    if (dirty) await saveChallenges(map);
  }

  // ---- online transport (ntfy.sh) --------------------------------------------
  // Direct, no-URL delivery: each user subscribes (polls) a topic derived from
  // their own handle; challenging someone publishes to THEIR topic. Codeforces
  // still decides the winner — ntfy only carries the invite/accept/decline.
  async function onlineEnabled() {
    const raw = await get([C.ONLINE_KEY]);
    return raw[C.ONLINE_KEY] !== false; // default ON (delivery by handle is the core flow)
  }
  async function myHandle() {
    const raw = await get([C.HANDLE_KEY]);
    return raw[C.HANDLE_KEY] || "";
  }
  async function getSince(topic) {
    const raw = await get([C.NET_SINCE_KEY]);
    return (raw[C.NET_SINCE_KEY] || {})[topic] || 0;
  }
  async function setSince(topic, sec) {
    const raw = await get([C.NET_SINCE_KEY]);
    const m = raw[C.NET_SINCE_KEY] || {};
    m[topic] = sec;
    await set({ [C.NET_SINCE_KEY]: m });
  }
  async function ntfyPublish(topic, body, title) {
    try {
      const res = await fetch(`${C.NTFY_BASE}/${topic}`, {
        method: "POST",
        headers: { Title: title || "CPOS Challenge", Tags: "crossed_swords" },
        body
      });
      return res.ok;
    } catch (_) { return false; }
  }
  async function ntfyPoll(topic) {
    const since = await getSince(topic);
    const sinceParam = since > 0 ? String(since) : "12h"; // first run: look back 12h
    let text;
    try {
      const res = await fetch(`${C.NTFY_BASE}/${topic}/json?poll=1&since=${sinceParam}`, { cache: "no-store" });
      if (!res.ok) return [];
      text = await res.text();
    } catch (_) { return []; }
    const out = [];
    let maxTime = since;
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      let ev;
      try { ev = JSON.parse(s); } catch (_) { continue; }
      if (!ev || ev.event !== "message") continue;
      if (typeof ev.time === "number" && ev.time > maxTime) maxTime = ev.time;
      const parsed = C.parseNetBody(ev.message || "");
      if (parsed) out.push(parsed);
    }
    if (maxTime > since) await setSince(topic, maxTime);
    return out;
  }

  async function processInvite(dec) {
    const me = await myHandle();
    if (!me) return; // need our own handle to race
    const map = await loadChallenges();
    if (map[dec.id]) return; // already seen
    map[dec.id] = {
      id: dec.id, role: "in", me, opponent: dec.from || "", problem: dec.problem,
      createdAt: dec.createdAt || Date.now(), durationMin: dec.durationMin || 60, nonce: dec.nonce || "",
      status: C.STATUS.PENDING, myAcSec: null, oppAcSec: null, polled: false, notified: false,
      online: true, receivedAt: Date.now()
    };
    await saveChallenges(map);
    await notify(map[dec.id], "⚔️ New challenge", `${dec.from || "Someone"} challenges you to ${C.problemLabel(dec.problem)} — open CPOS to accept.`);
  }
  async function processReply(kind, id, from) {
    const map = await loadChallenges();
    const ch = map[id];
    if (!ch || ch.role !== "out") return;
    if (kind === "accept") {
      // Accept the reply if the invite is still pending, OR if it only just
      // lapsed (PENDING -> EXPIRED) but the friend accepted shortly after — a
      // short invite TTL must never silently drop a real accept. Bound the grace
      // (a few × the TTL, capped by the race length) so a long-stale invite
      // can't restart a badly-truncated race.
      const graceMs = Math.min(ch.durationMin || 60, (C.INVITE_TTL_MIN || 4) * 3) * 60000;
      const withinGrace = Date.now() - (ch.createdAt || 0) < graceMs;
      if (ch.status !== C.STATUS.PENDING && !(ch.status === C.STATUS.EXPIRED && withinGrace)) return;
      ch.status = C.STATUS.ACTIVE;
      if (!ch.opponent && from) ch.opponent = from; // bind open challenge to first accepter
      await saveChallenges(map);
      await notify(ch, "✅ Challenge accepted", `${ch.opponent || from || "Your opponent"} accepted — race on for ${C.problemLabel(ch.problem)}!`);
    } else if (kind === "decline") {
      if (ch.status !== C.STATUS.PENDING) return;
      ch.status = C.STATUS.DECLINED;
      await saveChallenges(map);
      await notify(ch, "Challenge declined", `${from || ch.opponent || "Your opponent"} declined ${C.problemLabel(ch.problem)}.`);
    }
  }
  async function netPollInbox() {
    if (!(await onlineEnabled())) return;
    const me = await myHandle();
    if (!me) return;
    const msgs = await ntfyPoll(C.topicForHandle(me));
    for (const m of msgs) {
      try {
        if (m.kind === "invite") await processInvite(m.challenge);
        else if (m.kind === "accept" || m.kind === "decline") await processReply(m.kind, m.id, m.from);
      } catch (_) {}
    }
  }

  // Publish one challenge's invite/accept/decline to the right ntfy topic.
  async function netSend(action, challengeId) {
    if (!(await onlineEnabled())) return false;
    const map = await loadChallenges();
    const ch = map[challengeId];
    if (!ch) return false;
    let ok = false;
    if (action === "invite") {
      const topic = ch.opponent ? C.topicForHandle(ch.opponent) : C.LOBBY_TOPIC;
      ok = await ntfyPublish(topic, C.buildInvite(ch), `${ch.me} challenges you`);
      if (ok) ch.invitePublished = true;
    } else if (action === "accept" || action === "decline") {
      if (!ch.opponent) return false; // creator's handle unknown
      const topic = C.topicForHandle(ch.opponent);
      ok = await ntfyPublish(topic, C.buildReply(action, ch.id, ch.me), `${ch.me} ${action}ed your challenge`);
      if (ok) ch[action === "accept" ? "acceptSent" : "declineSent"] = true;
    }
    if (ok) { map[challengeId] = ch; await saveChallenges(map); }
    return ok;
  }

  // Publish invites/replies for challenges that haven't been sent yet — covers
  // challenges created/accepted in VS Code (synced in) that never went through a
  // netSend message. Flag-guarded so nothing is published twice.
  async function publishPending() {
    if (!(await onlineEnabled())) return;
    const map = await loadChallenges();
    let dirty = false;
    for (const ch of Object.values(map)) {
      if (!ch || !ch.online) continue;
      if (ch.role === "out" && ch.status === C.STATUS.PENDING && !ch.invitePublished) {
        const topic = ch.opponent ? C.topicForHandle(ch.opponent) : C.LOBBY_TOPIC;
        if (await ntfyPublish(topic, C.buildInvite(ch), `${ch.me} challenges you`)) { ch.invitePublished = true; dirty = true; }
      } else if (ch.role === "in" && ch.opponent && ch.status === C.STATUS.ACTIVE && !ch.acceptSent) {
        if (await ntfyPublish(C.topicForHandle(ch.opponent), C.buildReply("accept", ch.id, ch.me), `${ch.me} accepted your challenge`)) { ch.acceptSent = true; dirty = true; }
      } else if (ch.role === "in" && ch.opponent && ch.status === C.STATUS.DECLINED && !ch.declineSent) {
        if (await ntfyPublish(C.topicForHandle(ch.opponent), C.buildReply("decline", ch.id, ch.me), `${ch.me} declined your challenge`)) { ch.declineSent = true; dirty = true; }
      }
    }
    if (dirty) await saveChallenges(map);
  }

  // The browser companion owns delivery, public-lobby discovery, and refereeing.
  // VS Code mirrors this state over localhost. Preferences are timestamped so an
  // older client can never silently overwrite a newer choice.
  const APP_BASES = ["http://127.0.0.1:27122"];
  const rank = (s) => ({ pending: 0, active: 1, won: 2, lost: 2, draw: 2, expired: 2, declined: 2, removed: 3 }[s] ?? 0);

  async function refreshPublicMatches() {
    const settings = await loadSettings();
    if (!settings.publicOn) {
      await set({ [C.PUBLIC_MATCHES_KEY]: [] });
      return [];
    }
    const me = await myHandle();
    const have = await loadChallenges();
    let text = "";
    try {
      const res = await fetch(`${C.NTFY_BASE}/${C.LOBBY_TOPIC}/json?poll=1&since=6h`, { cache: "no-store" });
      if (res.ok) text = await res.text();
    } catch (_) {
      return (await get([C.PUBLIC_MATCHES_KEY]))[C.PUBLIC_MATCHES_KEY] || [];
    }
    const seen = new Set();
    const matches = [];
    for (const line of text.split("\n")) {
      const value = line.trim();
      if (!value) continue;
      let event;
      try { event = JSON.parse(value); } catch (_) { continue; }
      if (!event || event.event !== "message") continue;
      const parsed = C.parseNetBody(event.message || "");
      if (!(parsed && parsed.kind === "invite" && parsed.challenge)) continue;
      const invite = parsed.challenge;
      if (have[invite.id] || seen.has(invite.id) || invite.from === me || C.inviteExpired({ ...invite, status: C.STATUS.PENDING }, Date.now())) continue;
      const rating = Number(invite.problem && invite.problem.rating) || 0;
      if (rating && (rating < settings.range.min || rating > settings.range.max)) continue;
      seen.add(invite.id);
      matches.push(invite);
    }
    matches.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    await set({ [C.PUBLIC_MATCHES_KEY]: matches.slice(0, 30) });
    return matches;
  }

  async function syncWithApps() {
    const me = await myHandle();
    for (const base of APP_BASES) {
      let app = null;
      try {
        const res = await fetch(base + "/challenges", { cache: "no-store" });
        if (res.ok) app = await res.json();
      } catch (_) { continue; } // app not running
      if (!app || !app.ok) continue;

      // adopt app -> browser
      const map = await loadChallenges();
      let dirty = false;
      for (const id of Object.keys(app.challenges || {})) {
        const rem = app.challenges[id]; const loc = map[id];
        if (!loc) { map[id] = rem; dirty = true; }
        else if (rank(rem.status) > rank(loc.status)) { map[id] = rem; dirty = true; }
      }
      if (dirty) await saveChallenges(map);

      let settings = await loadSettings();
      if (app.cf) {
        const appUpdatedAt = Number(app.cf.updatedAt) || 0;
        if (appUpdatedAt > settings.updatedAt) {
          settings = await saveSettings({
            publicOn: app.cf.publicOn,
            range: app.cf.range,
            updatedAt: appUpdatedAt
          });
          if (app.cf.handle) {
            const current = await get([C.HANDLE_KEY, "cpos.cf.handleManual"]);
            if (!current["cpos.cf.handleManual"] || app.cf.handleManual) {
              await set({
                [C.HANDLE_KEY]: app.cf.handle,
                "cpos.cf.handleManual": app.cf.handleManual === true
              });
            }
          }
        } else if (app.cf.handleManual && app.cf.handle) {
          const current = await get([C.HANDLE_KEY, "cpos.cf.handleManual"]);
          if (!current["cpos.cf.handleManual"]) {
            await set({ [C.HANDLE_KEY]: app.cf.handle, "cpos.cf.handleManual": true });
          }
        }
      }

      // push browser -> app
      const after = await get([C.STORE_KEY, C.PUBLIC_MATCHES_KEY, C.HANDLE_KEY, "cpos.cf.handleManual"]);
      settings = await loadSettings();
      try {
        await fetch(base + "/challenges", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            challenges: after[C.STORE_KEY] || {},
            publicMatches: after[C.PUBLIC_MATCHES_KEY] || [],
            cf: {
              handle: after[C.HANDLE_KEY] || me,
              handleManual: after["cpos.cf.handleManual"] === true,
              publicOn: settings.publicOn,
              range: settings.range,
              updatedAt: settings.updatedAt
            }
          })
        });
      } catch (_) { /* best-effort */ }
    }
  }

  // ---- listeners (our own; coexist with background.js + cpos-contests.js) -----
  async function tickPoll() {
    await syncWithApps();                  // first pull any newer VS Code preferences
    await refreshPublicMatches();          // browser owns public-lobby discovery
    await publishPending();                // deliver any unpublished (e.g. VS Code-created) invites
    await pollAll();                       // CF referee
    await netPollInbox();                  // ntfy inbox — every tick so invites/accepts arrive promptly
    await syncWithApps();                  // push discovered matches and new statuses
  }
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MIN });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === POLL_ALARM) void tickPoll();
  });

  if (chrome.notifications && chrome.notifications.onClicked) {
    chrome.notifications.onClicked.addListener((id) => {
      if (!id || !id.startsWith(NOTIF_PREFIX)) return; // not ours
      const cid = id.slice(NOTIF_PREFIX.length);
      loadChallenges().then((map) => {
        const ch = map[cid];
        const url = ch && ch.problem && ch.problem.url;
        if (url && chrome.tabs) chrome.tabs.create({ url });
      });
      chrome.notifications.clear(id);
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return; // not ours
    if (msg.type === "cpos-challenge-poll") {
      Promise.resolve()
        .then(() => tickPoll())
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true; // async
    }
    if (msg.type === "cpos-challenge-sync") {
      Promise.resolve()
        .then(() => refreshPublicMatches())
        .then(() => syncWithApps())
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (msg.type === "cpos-challenge-net") {
      netSend(msg.action, msg.challengeId).then((ok) => sendResponse({ ok })).catch(() => sendResponse({ ok: false }));
      return true; // async
    }
    // Unknown type — let other listeners handle it.
  });

  let syncTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes[C.STORE_KEY] && !changes[C.SETTINGS_KEY] && !changes[C.HANDLE_KEY]) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => void syncWithApps(), 250);
  });

  // Poll once on load and on the usual lifecycle events.
  void tickPoll();
  if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(() => void tickPoll());
  if (chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener(() => void tickPoll());
})();
