// CPOS Challenge — shared core (pure helpers, no side effects).
//
// Loaded in three contexts that cannot share a module otherwise:
//   • the popup            (via a <script> tag)
//   • Codeforces pages     (as a content script, before cpos-challenge.js)
//   • the background worker (via importScripts / background.scripts)
// so it only ever attaches pure functions to `self.CPOSChallenge`.
//
// The whole feature is serverless: a challenge is encoded into a shareable link,
// and Codeforces' own public API (user.status) is the referee for who solved the
// problem first. There is no backend and no shared state beyond the link itself.
(function (root) {
  const STORE_KEY = "cpos.challenges"; // { [id]: Challenge }
  const HANDLE_KEY = "cpos.cf.handle"; // the user's detected Codeforces handle
  const NOTIFY_KEY = "cpos.challenge.notify"; // bool, default true
  const PROBLEMS_KEY = "cpos.challenge.problems"; // cached problemset for random picks
  const SETTINGS_KEY = "cpos.challenge.settings"; // { publicOn, range, updatedAt }
  const PUBLIC_MATCHES_KEY = "cpos.challenge.publicMatches"; // discovered lobby races
  const FEATURE = "challenges"; // cpos.features flag (mirrors cpos-config defaults)

  const STATUS = {
    PENDING: "pending", // online: invited, awaiting the other side to accept
    ACTIVE: "active",
    WON: "won",
    LOST: "lost",
    DRAW: "draw",
    EXPIRED: "expired",
    DECLINED: "declined",
    REMOVED: "removed"
  };
  const TERMINAL = [STATUS.WON, STATUS.LOST, STATUS.DRAW, STATUS.EXPIRED, STATUS.DECLINED, STATUS.REMOVED];

  const LINK_PARAM = "cposc"; // https://codeforces.com/?cposc=<payload>

  // ---- online race delivery via ntfy.sh --------------------------------------
  // ntfy.sh is a free, no-account, open pub/sub relay. Each user subscribes to a
  // topic derived from their handle; challenging someone publishes to THEIR topic
  // (no URL to share, real push). Topics are PUBLIC — fine for a friendly race,
  // but we never put anything sensitive in them. Off by default; the user opts in.
  const ONLINE_KEY = "cpos.challenge.online"; // legacy compatibility key; delivery defaults on
  const NET_SINCE_KEY = "cpos.challenge.netSince"; // { [topic]: lastSeenSec }
  const INVITE_TTL_MIN = 4; // a pending invite lapses if not accepted within this many minutes
  const NTFY_BASE = "https://ntfy.sh";
  const TOPIC_PREFIX = "cpos-chal-v1-";
  const LOBBY_TOPIC = "cpos-chal-v1-lobby";
  const NET_TAG = "cposchal"; // discriminator inside ntfy message bodies

  function topicForHandle(handle) {
    return TOPIC_PREFIX + String(handle || "").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  }

  // App messages ride inside the ntfy message body as compact JSON.
  //   invite : { g:"cposchal", k:"invite",  p:<encoded challenge> }
  //   accept : { g:"cposchal", k:"accept",  id, from }
  //   decline: { g:"cposchal", k:"decline", id, from }
  function buildInvite(ch) { return JSON.stringify({ g: NET_TAG, k: "invite", p: encode(ch) }); }
  function buildReply(kind, id, from) { return JSON.stringify({ g: NET_TAG, k: kind, id: String(id), from: String(from || "") }); }
  function parseNetBody(body) {
    try {
      const o = JSON.parse(body);
      if (!o || o.g !== NET_TAG || !o.k) return null;
      if (o.k === "invite") {
        const dec = decode(o.p);
        return dec ? { kind: "invite", challenge: dec } : null;
      }
      if (o.k === "accept" || o.k === "decline") {
        if (!o.id) return null;
        return { kind: o.k, id: String(o.id), from: String(o.from || "") };
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  // ---- base64url <-> utf8 JSON ------------------------------------------------
  function b64urlEncode(str) {
    const b64 = btoa(unescape(encodeURIComponent(str)));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64urlDecode(b64) {
    let s = b64.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return decodeURIComponent(escape(atob(s)));
  }

  // ---- ids --------------------------------------------------------------------
  function rand() {
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
    } catch (_) {}
    try {
      if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        const a = new Uint8Array(16);
        crypto.getRandomValues(a);
        return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
      }
    } catch (_) {}
    return "x" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  function makeId() { return rand().slice(0, 12); }
  function genNonce() { return rand().slice(0, 8); }

  // ---- problem url parsing ----------------------------------------------------
  // Accepts a full CF problem URL or a "contestId index" / "1234A" shorthand.
  // Returns { platform, contestId, index, id, url } or null. Gym/group problems
  // are rejected (they carry no public rating and don't appear in user.status as
  // ratable submissions in the same way).
  function parseProblem(input) {
    if (!input) return null;
    const s = String(input).trim();

    let m = s.match(/codeforces\.com\/problemset\/problem\/(\d+)\/([A-Za-z][0-9]*)/i);
    if (!m) m = s.match(/codeforces\.com\/contest\/(\d+)\/problem\/([A-Za-z][0-9]*)/i);
    if (!m) m = s.match(/^\s*(\d+)\s*[\/ ]?\s*([A-Za-z][0-9]*)\s*$/); // "1234 A" or "1234A" or "1234/A"
    if (!m) return null;

    const contestId = parseInt(m[1], 10);
    const index = m[2].toUpperCase();
    if (!contestId || !index) return null;
    return {
      platform: "codeforces",
      contestId,
      index,
      id: `${contestId}${index}`,
      url: `https://codeforces.com/contest/${contestId}/problem/${index}`
    };
  }

  function problemLabel(p) {
    if (!p) return "";
    return p.name ? `${p.id} — ${p.name}` : p.id;
  }

  // Invites arrive over a PUBLIC ntfy topic, so the embedded problem URL is
  // attacker-controllable. Only trust a real Codeforces https URL; otherwise
  // rebuild it from the (validated) contest/index. Blocks javascript:/data: hrefs.
  function safeCfUrl(u, contestId, index) {
    const s = String(u || "");
    if (/^https:\/\/codeforces\.com\//i.test(s)) return s;
    return `https://codeforces.com/contest/${contestId}/problem/${index}`;
  }

  // ---- challenge encode / decode (compact keys keep the link short) ----------
  // Wire shape: { i:id, f:from, t:to, p:{c,x,n,u,r}, s:startSec, d:durationMin, k:nonce }
  function encode(ch) {
    const p = ch.problem || {};
    const obj = {
      i: ch.id,
      f: ch.me,
      t: ch.opponent || "",
      p: { c: p.contestId, x: p.index, n: p.name || "", u: p.url || "", r: p.rating || 0 },
      s: Math.floor((ch.createdAt || 0) / 1000),
      d: ch.durationMin || 0,
      k: ch.nonce || ""
    };
    return b64urlEncode(JSON.stringify(obj));
  }

  // Decode a link payload from the *recipient's* point of view: `from` is the
  // creator (their opponent), `to` is who it was addressed to (may be "").
  function decode(code) {
    try {
      const o = JSON.parse(b64urlDecode(String(code).trim()));
      if (!o || !o.p || !o.i) return null;
      const c = parseInt(o.p.c, 10);
      const x = String(o.p.x || "").toUpperCase();
      if (!c || !x) return null;
      return {
        id: String(o.i),
        from: String(o.f || ""),
        to: String(o.t || ""),
        problem: {
          platform: "codeforces",
          contestId: c,
          index: x,
          id: `${c}${x}`,
          name: String(o.p.n || ""),
          url: safeCfUrl(o.p.u, c, x),
          rating: Number(o.p.r) || 0
        },
        createdAt: (Number(o.s) || 0) * 1000,
        durationMin: Number(o.d) || 60,
        nonce: String(o.k || "")
      };
    } catch (_) {
      return null;
    }
  }

  function link(ch) {
    return `https://codeforces.com/?${LINK_PARAM}=${encode(ch)}`;
  }

  function deadlineAt(ch) {
    return (ch.createdAt || 0) + (ch.durationMin || 0) * 60000;
  }

  // A pending invite that nobody accepted within INVITE_TTL_MIN has lapsed.
  function inviteExpired(ch, now) {
    if (ch.status !== STATUS.PENDING) return false;
    return (now || 0) - (ch.createdAt || 0) > INVITE_TTL_MIN * 60000;
  }
  function inviteSecondsLeft(ch, now) {
    const left = (ch.createdAt || 0) + INVITE_TTL_MIN * 60000 - (now || 0);
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  // ---- referee: earliest accepted submission in the challenge window ----------
  // `submissions` is the array from user.status. Returns the earliest
  // creationTimeSeconds (a number) with verdict OK on the exact problem at or
  // after startSec, or null. A problem solved *before* the challenge started does
  // not count — you must solve it during the window.
  function firstAcSeconds(submissions, contestId, index, startSec) {
    if (!Array.isArray(submissions)) return null;
    const want = String(index).toUpperCase();
    let best = null;
    for (const s of submissions) {
      if (!s || s.verdict !== "OK") continue;
      const p = s.problem || {};
      if (Number(p.contestId) !== Number(contestId)) continue;
      if (String(p.index || "").toUpperCase() !== want) continue;
      const t = Number(s.creationTimeSeconds);
      if (!Number.isFinite(t) || t < startSec) continue;
      if (best === null || t < best) best = t;
    }
    return best;
  }

  // Given both players' first-AC seconds (or null) and whether the deadline has
  // passed, return the resolved status from `me`'s perspective, or null to keep
  // racing. Only valid for two-sided (opponent-known) challenges.
  function resolve(myAcSec, oppAcSec, deadlinePassed) {
    if (myAcSec != null && oppAcSec != null) {
      if (myAcSec < oppAcSec) return STATUS.WON;
      if (oppAcSec < myAcSec) return STATUS.LOST;
      return STATUS.DRAW; // identical second — vanishingly rare
    }
    if (myAcSec != null) return STATUS.WON; // first to solve wins
    if (oppAcSec != null) return STATUS.LOST;
    if (deadlinePassed) return STATUS.EXPIRED; // neither solved in time
    return null;
  }

  root.CPOSChallenge = {
    STORE_KEY, HANDLE_KEY, NOTIFY_KEY, PROBLEMS_KEY, SETTINGS_KEY, PUBLIC_MATCHES_KEY, FEATURE, STATUS, TERMINAL, LINK_PARAM,
    ONLINE_KEY, NET_SINCE_KEY, NTFY_BASE, TOPIC_PREFIX, LOBBY_TOPIC, NET_TAG, INVITE_TTL_MIN,
    b64urlEncode, b64urlDecode, makeId, genNonce,
    parseProblem, problemLabel, safeCfUrl, encode, decode, link, deadlineAt, inviteExpired, inviteSecondsLeft,
    firstAcSeconds, resolve,
    topicForHandle, buildInvite, buildReply, parseNetBody
  };
})(typeof self !== "undefined" ? self : this);
