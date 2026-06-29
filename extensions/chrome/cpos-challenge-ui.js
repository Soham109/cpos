// CPOS Compete — popup UI. The browser companion owns delivery/refereeing and
// mirrors the same races, identity, matching preferences, and lobby results to
// VS Code over localhost.
(function () {
  const C = self.CPOSChallenge;
  const mount = document.getElementById("cpos-challenges-section");
  if (!C || !mount || typeof chrome === "undefined" || !chrome.storage) return;

  const store = chrome.storage.local;
  const get = (keys) => new Promise((resolve) => store.get(keys, (value) => resolve(value || {})));
  const set = (value) => new Promise((resolve) => store.set(value, resolve));
  const send = (message) => {
    try { chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError); } catch (_) {}
  };
  const PROBLEMS_TTL = 24 * 60 * 60 * 1000;
  let raceMode = "friend";

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    if (attrs) for (const key in attrs) node.setAttribute(key, attrs[key]);
    if (text != null) node.textContent = text;
    return node;
  }
  function normalizeRange(range) {
    const a = Math.max(800, Math.min(3500, Number(range && range.min) || 800));
    const b = Math.max(800, Math.min(3500, Number(range && range.max) || 3500));
    return a <= b ? { min: a, max: b } : { min: b, max: a };
  }
  async function loadSettings(raw) {
    if (raw[C.SETTINGS_KEY]) {
      const value = raw[C.SETTINGS_KEY];
      return { publicOn: value.publicOn === true, range: normalizeRange(value.range), updatedAt: Number(value.updatedAt) || 0 };
    }
    return {
      publicOn: raw["cpos.challenge.publicOn"] === true,
      range: normalizeRange(raw["cpos.challenge.range"]),
      updatedAt: 0
    };
  }
  async function saveSettings(publicOn, range) {
    const value = { publicOn: publicOn === true, range: normalizeRange(range), updatedAt: Date.now() };
    await set({
      [C.SETTINGS_KEY]: value,
      "cpos.challenge.publicOn": value.publicOn,
      "cpos.challenge.range": value.range
    });
    send({ type: "cpos-challenge-sync" });
  }
  async function saveChallenge(challenge) {
    const raw = await get([C.STORE_KEY]);
    const map = raw[C.STORE_KEY] || {};
    map[challenge.id] = challenge;
    await set({ [C.STORE_KEY]: map });
  }

  function ensureStyle() {
    if (document.getElementById("cpos-compete-style")) return;
    const style = el("style", { id: "cpos-compete-style" });
    style.textContent =
      "#cpos-challenges-section{display:flex;flex-direction:column;gap:9px;font-size:12px}" +
      "#cpos-challenges-section .ch-card{border:1px solid var(--border);border-radius:var(--radius,12px);padding:9px;background:var(--panel-2)}" +
      "#cpos-challenges-section .ch-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px}" +
      "#cpos-challenges-section .ch-title{font-weight:750;color:var(--fg)}" +
      "#cpos-challenges-section .ch-note{font-size:10px;line-height:1.4;color:var(--dim);margin-top:2px}" +
      "#cpos-challenges-section .ch-stack{display:flex;flex-direction:column;gap:7px}" +
      "#cpos-challenges-section .ch-two{display:flex;gap:7px}" +
      "#cpos-challenges-section .ch-two>*{flex:1;min-width:0}" +
      "#cpos-challenges-section .ch-field{display:flex;flex-direction:column;gap:4px}" +
      "#cpos-challenges-section .ch-field>label{font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim)}" +
      "#cpos-challenges-section input,#cpos-challenges-section select{box-sizing:border-box;width:100%;padding:7px 9px;border-radius:8px;border:1px solid var(--border);background:var(--panel);color:var(--fg);font:inherit;font-size:12px}" +
      "#cpos-challenges-section input:focus,#cpos-challenges-section select:focus{outline:none;border-color:var(--accent)}" +
      "#cpos-challenges-section .ch-segment{display:flex;gap:3px;padding:3px;border:1px solid var(--border);border-radius:8px;background:var(--panel)}" +
      "#cpos-challenges-section .ch-segment button{flex:1;border:0;border-radius:6px;padding:6px;background:transparent;color:var(--dim);font:inherit;cursor:pointer}" +
      "#cpos-challenges-section .ch-segment button.active{background:var(--panel-2);color:var(--fg);box-shadow:0 0 0 1px var(--border)}" +
      "#cpos-challenges-section .ch-send{width:100%;padding:9px;border:0;border-radius:9px;background:var(--accent);color:var(--accent-on);font-weight:750;font-size:12px;cursor:pointer}" +
      "#cpos-challenges-section .ch-mini{padding:5px 9px;border:1px solid var(--border);border-radius:7px;background:transparent;color:var(--fg);font:inherit;font-size:11px;font-weight:650;cursor:pointer}" +
      "#cpos-challenges-section .ch-mini.solid{background:var(--accent);color:var(--accent-on);border-color:var(--accent)}" +
      "#cpos-challenges-section .ch-msg,#cpos-challenges-section .ch-empty{font-size:10px;color:var(--dim);line-height:1.4}" +
      "#cpos-challenges-section .ch-identity{display:flex;gap:7px}" +
      "#cpos-challenges-section .ch-identity input{flex:1}" +
      "#cpos-challenges-section .ch-pub{display:flex;align-items:center;gap:7px}" +
      "#cpos-challenges-section .ch-pub .grow{flex:1}" +
      "#cpos-challenges-section .ch-range{width:58px!important;text-align:center}" +
      "#cpos-challenges-section .ch-row{display:flex;align-items:center;gap:7px;padding:7px 8px;border:1px solid var(--border);border-radius:8px}" +
      "#cpos-challenges-section .ch-who{flex:1;min-width:0}" +
      "#cpos-challenges-section .ch-prob{display:block;color:var(--accent);font-weight:650;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      "#cpos-challenges-section .ch-sub{font-size:10px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      "#cpos-challenges-section .ch-badge{font-size:9px;font-weight:750;padding:3px 7px;border-radius:var(--radius-pill,999px);white-space:nowrap}" +
      "#cpos-challenges-section .ch-x{border:0;background:transparent;color:var(--dim);cursor:pointer;padding:2px}" +
      "@media(max-width:360px){#cpos-challenges-section .ch-two,#cpos-challenges-section .ch-identity{flex-direction:column}}";
    document.head.appendChild(style);
  }

  async function getProblems() {
    const raw = await get([C.PROBLEMS_KEY]);
    const cached = raw[C.PROBLEMS_KEY];
    if (cached && cached.problems && Date.now() - (cached.ts || 0) < PROBLEMS_TTL) return cached.problems;
    try {
      const response = await fetch("https://codeforces.com/api/problemset.problems", { cache: "no-store", credentials: "omit" });
      const json = await response.json();
      if (json.status !== "OK") throw new Error("problemset");
      const problems = (json.result.problems || [])
        .filter((problem) => problem.contestId && problem.index && typeof problem.rating === "number")
        .map((problem) => ({ contestId: problem.contestId, index: problem.index, name: problem.name, rating: problem.rating }));
      await set({ [C.PROBLEMS_KEY]: { ts: Date.now(), problems } });
      return problems;
    } catch (_) {
      return (cached && cached.problems) || [];
    }
  }
  function pickRandom(problems, rating) {
    let pool = problems.filter((problem) => problem.rating === rating);
    if (pool.length < 5) pool = problems.filter((problem) => Math.abs(problem.rating - rating) <= 100);
    if (!pool.length) return null;
    const problem = pool[Math.floor(Math.random() * pool.length)];
    return {
      platform: "codeforces", contestId: problem.contestId, index: problem.index,
      id: `${problem.contestId}${problem.index}`, name: problem.name || "",
      url: `https://codeforces.com/contest/${problem.contestId}/problem/${problem.index}`, rating: problem.rating
    };
  }
  async function enrich(problem) {
    const match = (await getProblems()).find((item) => item.contestId === problem.contestId && item.index === problem.index);
    if (match) { problem.name = match.name || ""; problem.rating = match.rating || 0; }
    return problem;
  }

  function card(title, note) {
    const root = el("section", { class: "ch-card" });
    const head = el("div", { class: "ch-head" });
    const copy = el("div");
    copy.appendChild(el("div", { class: "ch-title" }, title));
    if (note) copy.appendChild(el("div", { class: "ch-note" }, note));
    head.appendChild(copy);
    root.appendChild(head);
    return { root, head };
  }

  async function render() {
    ensureStyle();
    const raw = await get([
      C.STORE_KEY, C.HANDLE_KEY, C.SETTINGS_KEY, C.PUBLIC_MATCHES_KEY,
      "cpos.challenge.publicOn", "cpos.challenge.range"
    ]);
    const map = raw[C.STORE_KEY] || {};
    const handle = raw[C.HANDLE_KEY] || "";
    const settings = await loadSettings(raw);
    const publicMatches = raw[C.PUBLIC_MATCHES_KEY] || [];
    mount.textContent = "";

    const identity = card("Codeforces identity", "Detected from Codeforces, or set it explicitly here. This stays synced with VS Code.");
    const identityRow = el("div", { class: "ch-identity" });
    const handleInput = el("input", { type: "text", value: handle, placeholder: "Codeforces handle", spellcheck: "false" });
    const handleSave = el("button", { type: "button", class: "ch-mini solid" }, "Save");
    handleSave.addEventListener("click", async () => {
      await set({ [C.HANDLE_KEY]: handleInput.value.trim(), "cpos.cf.handleManual": !!handleInput.value.trim() });
      await saveSettings(settings.publicOn, settings.range);
    });
    identityRow.append(handleInput, handleSave);
    identity.root.appendChild(identityRow);
    mount.appendChild(identity.root);

    const create = card("New race", "Challenge a friend directly, or publish an open race for someone to accept.");
    const form = el("div", { class: "ch-stack" });
    const segment = el("div", { class: "ch-segment" });
    const friendButton = el("button", { type: "button" }, "Friend");
    const publicButton = el("button", { type: "button" }, "Open race");
    segment.append(friendButton, publicButton);
    const opponentField = el("div", { class: "ch-field" });
    opponentField.appendChild(el("label", null, "Opponent"));
    const opponentInput = el("input", { type: "text", placeholder: "Codeforces handle" });
    opponentField.appendChild(opponentInput);
    const problemField = el("div", { class: "ch-field" });
    problemField.appendChild(el("label", null, "Problem"));
    const problemMode = el("select");
    [["random", "Random by rating"], ["custom", "Problem ID or link"]].forEach(([value, label]) => problemMode.appendChild(el("option", { value }, label)));
    problemField.appendChild(problemMode);
    const customField = el("div", { class: "ch-field" });
    customField.appendChild(el("label", null, "Problem ID or link"));
    const problemInput = el("input", { type: "text", placeholder: "2237D or Codeforces link" });
    customField.appendChild(problemInput);
    const two = el("div", { class: "ch-two" });
    const ratingField = el("div", { class: "ch-field" });
    ratingField.appendChild(el("label", null, "Rating"));
    const ratingInput = el("input", { type: "number", value: "1400", min: "800", max: "3500", step: "100" });
    ratingField.appendChild(ratingInput);
    const durationField = el("div", { class: "ch-field" });
    durationField.appendChild(el("label", null, "Time limit"));
    const duration = el("select");
    [["30", "30 minutes"], ["60", "1 hour"], ["120", "2 hours"], ["1440", "1 day"]].forEach(([value, label]) => {
      const option = el("option", { value }, label); if (value === "60") option.selected = true; duration.appendChild(option);
    });
    durationField.appendChild(duration);
    two.append(ratingField, durationField);
    const createButton = el("button", { type: "button", class: "ch-send" });
    const message = el("div", { class: "ch-msg" });
    form.append(segment, opponentField, problemField, customField, two, createButton, message);
    create.root.appendChild(form);
    mount.appendChild(create.root);

    const syncMode = () => {
      friendButton.classList.toggle("active", raceMode === "friend");
      publicButton.classList.toggle("active", raceMode === "public");
      opponentField.style.display = raceMode === "friend" ? "" : "none";
      createButton.textContent = raceMode === "friend" ? "Send challenge" : "Publish open race";
    };
    friendButton.addEventListener("click", () => { raceMode = "friend"; syncMode(); });
    publicButton.addEventListener("click", () => { raceMode = "public"; syncMode(); });
    syncMode();
    const syncProblemMode = () => {
      customField.style.display = problemMode.value === "custom" ? "" : "none";
      ratingField.style.display = problemMode.value === "random" ? "" : "none";
    };
    problemMode.addEventListener("change", syncProblemMode);
    syncProblemMode();

    createButton.addEventListener("click", async () => {
      if (!handle) { message.textContent = "Set your Codeforces handle first."; return; }
      const opponent = raceMode === "friend" ? opponentInput.value.trim() : "";
      if (raceMode === "friend" && !opponent) { message.textContent = "Enter your friend's Codeforces handle."; return; }
      createButton.disabled = true;
      message.textContent = "Preparing race…";
      try {
        let problem;
        if (problemMode.value === "custom") {
          problem = C.parseProblem(problemInput.value.trim());
          if (!problem) throw new Error("Use a Codeforces problem ID or link.");
          problem = await enrich(problem);
        } else {
          problem = pickRandom(await getProblems(), Math.max(800, Math.min(3500, Number(ratingInput.value) || 1400)));
          if (!problem) throw new Error("Couldn't load a random problem.");
        }
        const challenge = {
          id: C.makeId(), role: "out", me: handle, opponent, problem,
          createdAt: Date.now(), durationMin: Number(duration.value) || 60,
          nonce: C.genNonce(), status: C.STATUS.PENDING, myAcSec: null, oppAcSec: null,
          polled: false, notified: false, online: true
        };
        await saveChallenge(challenge);
        send({ type: "cpos-challenge-net", action: "invite", challengeId: challenge.id });
        send({ type: "cpos-challenge-poll" });
        message.textContent = opponent ? `Sent to ${opponent}.` : "Open race published.";
      } catch (error) {
        message.textContent = error && error.message ? error.message : "Something went wrong.";
      } finally {
        createButton.disabled = false;
      }
    });

    const matching = card("Public matching", "Automatically discover open races in your rating range. CPOS never accepts one without you.");
    const switchLabel = el("label", { class: "sw" });
    const switchInput = el("input", { type: "checkbox" });
    switchInput.checked = settings.publicOn;
    switchLabel.append(switchInput, el("span"));
    matching.head.appendChild(switchLabel);
    const publicRow = el("div", { class: "ch-pub" });
    publicRow.appendChild(el("span", { class: "grow" }, "Problem rating"));
    const minInput = el("input", { type: "number", class: "ch-range", value: settings.range.min, min: "800", max: "3500", step: "100" });
    const maxInput = el("input", { type: "number", class: "ch-range", value: settings.range.max, min: "800", max: "3500", step: "100" });
    publicRow.append(minInput, el("span", null, "–"), maxInput);
    matching.root.appendChild(publicRow);
    const matchList = el("div", { class: "ch-stack" });
    matchList.style.marginTop = "8px";
    if (!settings.publicOn) {
      matchList.appendChild(el("div", { class: "ch-empty" }, "Turn matching on to discover races."));
    } else if (!publicMatches.length) {
      matchList.appendChild(el("div", { class: "ch-empty" }, "Listening for matching open races…"));
    } else {
      publicMatches.slice(0, 8).forEach((invite) => {
        const row = raceRow(invite, `from ${invite.from || "another coder"} · ${invite.durationMin || 60} min`);
        const accept = el("button", { type: "button", class: "ch-mini solid" }, "Accept");
        accept.addEventListener("click", () => acceptIncoming(invite, handle));
        row.appendChild(accept);
        matchList.appendChild(row);
      });
    }
    matching.root.appendChild(matchList);
    mount.appendChild(matching.root);
    const persistMatching = () => saveSettings(switchInput.checked, { min: minInput.value, max: maxInput.value });
    switchInput.addEventListener("change", persistMatching);
    minInput.addEventListener("change", persistMatching);
    maxInput.addEventListener("change", persistMatching);

    const history = card("Your races", "Invites, active races, and recent results synced with VS Code.");
    const list = el("div", { class: "ch-stack" });
    const races = Object.values(map)
      .filter((challenge) => challenge && challenge.status !== C.STATUS.REMOVED)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 12);
    if (!races.length) list.appendChild(el("div", { class: "ch-empty" }, handle
      ? "No races yet — send a friend a challenge or publish an open race."
      : "Set your Codeforces handle above to start a race."));
    races.forEach((challenge) => {
      const opponent = challenge.opponent ? `${challenge.role === "out" ? "vs" : "from"} ${challenge.opponent}` : "open";
      const row = raceRow(challenge, opponent);
      if (challenge.role === "in" && challenge.status === C.STATUS.PENDING) {
        const accept = el("button", { type: "button", class: "ch-mini solid" }, "Accept");
        const decline = el("button", { type: "button", class: "ch-mini" }, "Decline");
        accept.addEventListener("click", () => acceptIncoming(challenge, challenge.me));
        decline.addEventListener("click", async () => {
          challenge.status = C.STATUS.DECLINED;
          await saveChallenge(challenge);
          send({ type: "cpos-challenge-net", action: "decline", challengeId: challenge.id });
        });
        row.append(accept, decline);
      } else {
        const badgeData = {
          pending: ["Pending", "var(--warn)"], active: ["Racing", "var(--accent)"], won: ["Won", "var(--ok)"],
          lost: ["Lost", "var(--bad)"], draw: ["Draw", "var(--warn)"], expired: ["Expired", "var(--dim)"], declined: ["Declined", "var(--dim)"]
        }[challenge.status] || [challenge.status, "var(--dim)"];
        const badge = el("span", { class: "ch-badge" }, badgeData[0]);
        const token = badgeData[1];
        badge.style.background = "color-mix(in srgb, " + token + " 16%, transparent)";
        badge.style.color = token;
        badge.style.border = "1px solid color-mix(in srgb, " + token + " 40%, transparent)";
        row.appendChild(badge);
      }
      const remove = el("button", { type: "button", class: "ch-x", title: "Remove", "aria-label": "Remove" });
      remove.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>';
      remove.addEventListener("click", async () => {
        challenge.status = C.STATUS.REMOVED;
        challenge.removedAt = Date.now();
        await saveChallenge(challenge);
        send({ type: "cpos-challenge-sync" });
      });
      row.appendChild(remove);
      list.appendChild(row);
    });
    history.root.appendChild(list);
    mount.appendChild(history.root);
  }

  function raceRow(challenge, subtitle) {
    const row = el("div", { class: "ch-row" });
    const who = el("div", { class: "ch-who" });
    const problem = challenge.problem || {};
    const link = el("a", { class: "ch-prob", href: problem.url || "#", target: "_blank", rel: "noopener" }, C.problemLabel(problem) || "Codeforces problem");
    who.append(link, el("div", { class: "ch-sub" }, subtitle));
    row.appendChild(who);
    return row;
  }

  async function acceptIncoming(invite, me) {
    if (!me) return;
    await saveChallenge({
      id: invite.id, role: "in", me, opponent: invite.from || invite.opponent || "", problem: invite.problem,
      createdAt: invite.createdAt || Date.now(), durationMin: invite.durationMin || 60, nonce: invite.nonce || "",
      status: C.STATUS.ACTIVE, myAcSec: null, oppAcSec: null, polled: false, notified: false, online: true
    });
    send({ type: "cpos-challenge-net", action: "accept", challengeId: invite.id });
    send({ type: "cpos-challenge-poll" });
    try { window.open(invite.problem.url, "_blank", "noopener"); } catch (_) {}
  }

  if (chrome.storage.onChanged) {
    let renderTimer = null;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (!changes[C.STORE_KEY] && !changes[C.HANDLE_KEY] && !changes[C.SETTINGS_KEY] && !changes[C.PUBLIC_MATCHES_KEY]) return;
      clearTimeout(renderTimer);
      renderTimer = setTimeout(render, 80);
    });
  }
  send({ type: "cpos-challenge-poll" });
  render();
})();
