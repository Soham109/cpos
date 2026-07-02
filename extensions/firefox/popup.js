// CPOS popup hub. Reads/writes feature flags + theme to chrome.storage.local;
// content scripts react to those changes live. Never touches submit/capture.
//
// There is ONE chosen theme (cpos.ui.theme): it colours the popup, every injected
// CPOS UI surface, and the optional site recolour. (cpos.siteThemeId is no longer
// a separate palette; site theming reads cpos.ui.theme via cpos-config.js.)
(function () {
  const T = self.CPOS_THEMES;
  const ENDPOINTS = ["http://127.0.0.1:27122", "http://127.0.0.1:27121"];

  const DEFAULTS = {
    "cpos.ui.theme": T.DEFAULT_THEME,
    "cpos.ui.customAccent": "#b794ff",
    "cpos.features": { profile: true, carrot: true, highlight: true, ide: true, viz: true, problemTools: true, problemsetTools: true, standingsTools: true, contestReminders: true, dailyProblem: true, favorites: true, problemTimer: true, profileCompare: true, annotate: false, draw: false, modernize: true, siteTheme: false },
    "cpos.templates": {},
    "cpos.templates.dirty": {},
    "cpos.template.defaultLanguage": "cpp"
  };
  const TEMPLATE_LANGS = ["cpp", "python", "pypy", "java", "kotlin", "rust", "go", "csharp", "javascript", "ruby", "haskell", "pascal", "c"];

  // Consistent inline line-icon set (16px grid, currentColor stroke) — replaces
  // the old emoji glyphs so the popup reads as one intentional design, not a
  // grab-bag of OS emoji. Each value is the inner markup of a shared <svg>.
  const ICONS = {
    profile: '<path d="M2.5 13.5h11"/><path d="M4.5 13.5v-3.5"/><path d="M8 13.5v-7"/><path d="M11.5 13.5v-2"/>',
    ide: '<rect x="2.2" y="3.5" width="11.6" height="9" rx="1.6"/><path d="M2.2 6h11.6"/><path d="M6.4 8.2 5 9.9l1.4 1.7"/><path d="m9.6 8.2 1.4 1.7-1.4 1.7"/>',
    viz: '<circle cx="4.2" cy="4.6" r="1.7"/><circle cx="11.8" cy="6.2" r="1.7"/><circle cx="6.6" cy="11.8" r="1.7"/><path d="M5.9 5 10.1 5.9"/><path d="M4.8 6.2 6 10.2"/><path d="M10.7 7.5 7.7 10.5"/>',
    highlight: '<path d="M6.2 5 3.4 8l2.8 3"/><path d="m9.8 5 2.8 3-2.8 3"/>',
    problemTools: '<path d="M8.1 2.6 3 7.7a1.3 1.3 0 0 0 0 1.8l3.5 3.5a1.3 1.3 0 0 0 1.8 0l5.1-5.1a1.2 1.2 0 0 0 .35-.95L13.6 3a1 1 0 0 0-.95-.95l-3.6-.15a1.2 1.2 0 0 0-.95.35Z"/><circle cx="10.6" cy="5.4" r=".95"/>',
    problemsetTools: '<rect x="2.4" y="2.6" width="11.2" height="10.8" rx="1.6"/><path d="M2.4 6.2h11.2"/><path d="M2.4 9.8h11.2"/><path d="M6 6.2v7.2"/>',
    dailyProblem: '<path d="M8.2 2.4c.3 2 1.7 2.7 1.7 4.3a1.7 1.7 0 0 1-3.1 1c-.9.7-1.4 1.7-1.4 2.8a3.1 3.1 0 0 0 6.2 0c0-3.2-3.4-5.1-3.4-8.1Z"/>',
    favorites: '<path d="M8 2.6 9.7 6l3.7.5-2.7 2.6.65 3.7L8 11.1 4.65 12.8l.65-3.7L2.6 6.5 6.3 6 8 2.6Z"/>',
    contestReminders: '<path d="M4.7 6.6a3.3 3.3 0 0 1 6.6 0c0 3 1.3 4.1 1.3 4.1H3.4s1.3-1.1 1.3-4.1Z"/><path d="M6.7 12.9a1.4 1.4 0 0 0 2.6 0"/>',
    carrot: '<path d="M2.6 11 6 7.5l2.2 2.2 5.2-5.4"/><path d="M10.6 4.3h3v3"/>',
    profileCompare: '<path d="M2.6 5.2h5.4M6 2.8 8.4 5.2 6 7.6"/><path d="M13.4 10.8H8M10 8.4l-2.4 2.4L10 13.2"/>',
    standingsTools: '<circle cx="3.2" cy="4" r=".95"/><circle cx="3.2" cy="8" r=".95"/><circle cx="3.2" cy="12" r=".95"/><path d="M5.8 4h7.6M5.8 8h7.6M5.8 12h7.6"/>',
    problemTimer: '<path d="M6.4 2.4h3.2"/><path d="M8 2.4v1.7"/><circle cx="8" cy="9.2" r="4.6"/><path d="M8 9.2V6.6"/>',
    annotate: '<path d="m2.8 13.2 1-3.1 6.7-6.7a1.45 1.45 0 0 1 2.05 2.05L5.85 12.2 2.8 13.2Z"/><path d="m9.6 4.4 2 2"/>',
    draw: '<path d="m2.8 13.2 1-3.1 6.7-6.7a1.45 1.45 0 0 1 2.05 2.05L5.85 12.2 2.8 13.2Z"/><path d="m9.6 4.4 2 2"/><path d="M2.6 13.4h3.2"/>',
    modernize: '<path d="M8 2.4 9.1 6.5 13.2 7.6 9.1 8.7 8 12.8 6.9 8.7 2.8 7.6 6.9 6.5 8 2.4Z"/>',
    siteTheme: '<path d="M8 2.4S3.9 7 3.9 10.1a4.1 4.1 0 0 0 8.2 0C12.1 7 8 2.4 8 2.4Z"/>',
    challenges: '<path d="M5 3.2h6v2.6a3 3 0 0 1-6 0V3.2Z"/><path d="M5 4.2H3.3v.9A2 2 0 0 0 5 7.1M11 4.2h1.7v.9A2 2 0 0 1 11 7.1"/><path d="M8 8.8v2"/><path d="M5.8 13h4.4l-.5-2.2H6.3L5.8 13Z"/>'
  };
  function renderIcons() {
    document.querySelectorAll(".ic[data-icon]").forEach((el) => {
      const name = el.getAttribute("data-icon");
      if (!ICONS[name]) return;
      el.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + "</svg>";
    });
  }

  const store = chrome.storage.local;
  const get = (keys) => new Promise((res) => store.get(keys, res));
  const set = (obj) => new Promise((res) => store.set(obj, res));

  let state = {};

  async function load() {
    const raw = await get(Object.keys(DEFAULTS));
    state = {
      uiTheme: raw["cpos.ui.theme"] || DEFAULTS["cpos.ui.theme"],
      customAccent: raw["cpos.ui.customAccent"] || DEFAULTS["cpos.ui.customAccent"],
      features: Object.assign({}, DEFAULTS["cpos.features"], raw["cpos.features"] || {}),
      templates: Object.assign({}, raw["cpos.templates"] || {}),
      templateDirty: Object.assign({}, raw["cpos.templates.dirty"] || {}),
      templateLanguage: raw["cpos.template.defaultLanguage"] || "cpp"
    };
    if (!state.features.siteTheme && state.uiTheme !== T.DEFAULT_THEME) {
      state.uiTheme = T.DEFAULT_THEME;
      await set({ "cpos.ui.theme": state.uiTheme, "cpos.siteThemeId": state.uiTheme });
    }
    // Keep get("custom") resolving to the user's chosen accent in the popup too.
    T.registerCustom(state.customAccent);
  }

  function applyUiTheme() {
    T.applyTheme(document.body, state.uiTheme);
    document.body.setAttribute("data-theme", state.uiTheme);
    // Match native UI (scrollbars, form controls, canvas) to the palette so a
    // light theme isn't left with dark browser chrome — and vice-versa.
    const bg = (T.get(state.uiTheme)["--bg"] || "").replace("#", "");
    let light = false;
    if (/^[0-9a-f]{6}$/i.test(bg)) {
      const lum = (0.299 * parseInt(bg.slice(0, 2), 16) + 0.587 * parseInt(bg.slice(2, 4), 16) + 0.114 * parseInt(bg.slice(4, 6), 16)) / 255;
      light = lum > 0.6;
    }
    document.documentElement.style.colorScheme = light ? "light" : "dark";
  }

  function swatchEl(id, selected, onClick) {
    const theme = T.get(id);
    const b = document.createElement("button");
    b.className = "swatch" + (selected ? " sel" : "");
    b.title = theme.name;
    b.style.background = theme["--panel"];
    const pip = document.createElement("span");
    pip.className = "pip";
    pip.style.background = theme["--accent"];
    b.appendChild(pip);
    b.onclick = onClick;
    return b;
  }

  // The "Default" choice = native Codeforces (recolour OFF). Shown as a swatch
  // with a diagonal "none" slash so it reads as "no theme / original site".
  function defaultSwatchEl(selected, onClick) {
    const b = document.createElement("button");
    b.className = "swatch swatch-default" + (selected ? " sel" : "");
    b.title = "Default — original Codeforces (no recolour)";
    b.innerHTML = '<span class="slash"></span>';
    b.onclick = onClick;
    return b;
  }

  function renderSwatches() {
    // One picker drives everything. "Default" turns the site recolour off and
    // resets CPOS chrome to the neutral palette; any palette/custom turns site
    // recolour on and uses that same palette everywhere.
    const wrap = document.getElementById("themeSwatches");
    if (!wrap) return;
    const siteOn = !!state.features.siteTheme;
    wrap.innerHTML = "";
    wrap.appendChild(defaultSwatchEl(!siteOn, async () => {
      state.uiTheme = T.DEFAULT_THEME;
      state.features.siteTheme = false;
      await set({ "cpos.ui.theme": state.uiTheme, "cpos.siteThemeId": state.uiTheme, "cpos.features": state.features });
      applyUiTheme();
      renderSwatches();
    }));
    for (const id of T.presets()) {
      wrap.appendChild(
        swatchEl(id, siteOn && state.uiTheme === id, async () => {
          state.uiTheme = id;
          state.features.siteTheme = true;
          await set({ "cpos.ui.theme": id, "cpos.siteThemeId": id, "cpos.features": state.features });
          applyUiTheme();
          renderSwatches();
        })
      );
    }
    // reflect custom-accent selection on the custom-colour chip
    const pick = document.getElementById("customPick");
    if (pick) pick.classList.toggle("sel", siteOn && state.uiTheme === "custom");
  }

  function renderToggles() {
    document.querySelectorAll("[data-feature-input]").forEach((inp) => {
      const key = inp.getAttribute("data-feature-input");
      inp.checked = !!state.features[key];
      inp.onchange = async () => {
        state.features[key] = inp.checked;
        await set({ "cpos.features": state.features });
      };
    });
  }

  async function checkConnection() {
    const pill = document.getElementById("syncPill");
    const text = document.getElementById("syncText");
    if (!pill || !text) return;
    for (const base of ENDPOINTS) {
      try {
        const res = await fetch(`${base}/pending-submit`, { cache: "no-store" });
        if (res.ok) {
          pill.classList.add("on");
          text.textContent = base.includes("27122") ? "VS Code" : "TUI";
          return;
        }
      } catch {
        /* try next */
      }
    }
    pill.classList.remove("on");
    text.textContent = "Offline";
  }

  async function fetchSharedConfig() {
    for (const base of ENDPOINTS) {
      try {
        const res = await fetch(base + "/config", { cache: "no-store" });
        if (!res.ok) continue;
        const data = await res.json();
        for (const [lang, content] of Object.entries(data.templates || {})) {
          if (!state.templateDirty[lang]) state.templates[lang] = content;
        }
        state.templateLanguage = data.defaultLanguage || state.templateLanguage;
        for (const lang of Object.keys(state.templateDirty)) {
          if (!state.templateDirty[lang]) continue;
          const synced = await pushSharedTemplate(lang, state.templates[lang] || "");
          if (synced) delete state.templateDirty[lang];
        }
        await set({
          "cpos.templates": state.templates,
          "cpos.templates.dirty": state.templateDirty,
          "cpos.template.defaultLanguage": state.templateLanguage
        });
        return base;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  async function pushSharedTemplate(language, content) {
    let synced = null;
    for (const base of ENDPOINTS) {
      try {
        const res = await fetch(base + "/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ language, content })
        });
        if (res.ok) synced = synced || base;
      } catch {
        /* try next */
      }
    }
    return synced;
  }

  function renderTemplateEditor() {
    const lang = document.getElementById("templateLang");
    const text = document.getElementById("templateText");
    if (!lang || !text) return;
    lang.innerHTML = TEMPLATE_LANGS.map((id) =>
      '<option value="' + id + '"' + (id === state.templateLanguage ? " selected" : "") + ">" + id + "</option>"
    ).join("");
    text.value = state.templates[state.templateLanguage] || "";
  }

  function wireTemplateEditor() {
    const lang = document.getElementById("templateLang");
    const text = document.getElementById("templateText");
    const file = document.getElementById("templateFile");
    const status = document.getElementById("templateSync");
    if (!lang || !text || !file) return;
    lang.onchange = () => {
      state.templateLanguage = lang.value;
      text.value = state.templates[lang.value] || "";
    };
    document.getElementById("templateUpload").onclick = () => file.click();
    file.onchange = async () => {
      const chosen = file.files && file.files[0];
      if (chosen) text.value = await chosen.text();
      file.value = "";
    };
    document.getElementById("templateReset").onclick = () => { text.value = ""; };
    document.getElementById("templateSave").onclick = async () => {
      state.templateLanguage = lang.value;
      state.templates[lang.value] = text.value;
      await set({
        "cpos.templates": state.templates,
        "cpos.templates.dirty": Object.assign({}, state.templateDirty, { [lang.value]: true }),
        "cpos.template.defaultLanguage": state.templateLanguage
      });
      const endpoint = await pushSharedTemplate(lang.value, text.value);
      if (endpoint) delete state.templateDirty[lang.value];
      else state.templateDirty[lang.value] = true;
      await set({ "cpos.templates.dirty": state.templateDirty });
      status.textContent = endpoint ? "synced" : "saved locally";
    };
  }

  function wireCustomColor() {
    const input = document.getElementById("customColor");
    if (!input) return;
    input.value = state.customAccent;
    const onPick = async () => {
      state.customAccent = input.value;
      state.uiTheme = "custom";
      state.features.siteTheme = true;
      T.registerCustom(state.customAccent);
      await set({
        "cpos.ui.customAccent": state.customAccent,
        "cpos.ui.theme": "custom",
        "cpos.siteThemeId": "custom",
        "cpos.features": state.features
      });
      applyUiTheme();
      renderSwatches();
    };
    input.oninput = onPick;
    input.onchange = onPick;
  }

  function wirePopupNavigation() {
    const buttons = Array.from(document.querySelectorAll("[data-popup-tab]"));
    const panels = Array.from(document.querySelectorAll("[data-popup-panel]"));
    const allowed = new Set(buttons.map((button) => button.getAttribute("data-popup-tab")));
    const activate = (name) => {
      const tab = allowed.has(name) ? name : "settings";
      buttons.forEach((button) => {
        const selected = button.getAttribute("data-popup-tab") === tab;
        button.classList.toggle("active", selected);
        button.setAttribute("aria-selected", selected ? "true" : "false");
      });
      panels.forEach((panel) => panel.classList.toggle("active", panel.getAttribute("data-popup-panel") === tab));
      try { sessionStorage.setItem("cpos.popup.tab", tab); } catch (_) {}
    };
    buttons.forEach((button) => {
      button.onclick = () => activate(button.getAttribute("data-popup-tab"));
    });
    let initial = "settings";
    try { initial = sessionStorage.getItem("cpos.popup.tab") || "settings"; } catch (_) {}
    activate(initial);
  }

  function wire() {
    document.getElementById("ver").textContent = "v" + chrome.runtime.getManifest().version;
    wirePopupNavigation();
    wireCustomColor();

    // Hint which site the active tab is on.
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs[0]?.url || "";
      const hint = document.getElementById("siteHint");
      if (!hint) return;
      if (url.includes("codeforces.com")) hint.textContent = "Active tab: Codeforces · changes apply live";
      else if (url.includes("cses.fi")) hint.textContent = "Active tab: CSES · changes apply live";
      else if (url.includes("atcoder.jp")) hint.textContent = "Active tab: AtCoder · changes apply live";
      else hint.textContent = "Open Codeforces, CSES, or AtCoder to use these";
    });
  }

  (async function init() {
    await load();
    // Persist the resolved feature set so content scripts and the toggles agree
    // on first run (otherwise storage stays empty until a toggle is flipped).
    await set({ "cpos.features": state.features });
    renderIcons();
    applyUiTheme();
    renderSwatches();
    renderToggles();
    wire();
    await fetchSharedConfig();
    renderTemplateEditor();
    wireTemplateEditor();
    checkConnection();
  })();
})();
