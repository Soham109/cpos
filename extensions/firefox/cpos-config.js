// Shared CPOS config — one source of truth for feature flags + theme selection,
// used by the popup and every content script so defaults never drift. Loaded
// before the other scripts in each content_scripts entry.
(function (root) {
  const KEYS = {
    UI_THEME: "cpos.ui.theme",
    SITE_THEME: "cpos.siteThemeId",
    CUSTOM_ACCENT: "cpos.ui.customAccent",
    FEATURES: "cpos.features"
  };

  // Default ON for the things that should "just work" when you open a page.
  // siteTheme is opt-in (it restyles the whole site) — everything else is on.
  const DEFAULT_FEATURES = {
    profile: true,
    carrot: true,
    highlight: true,
    ide: true,
    viz: true,
    problemTools: true,
    problemsetTools: true,
    standingsTools: true,
    contestReminders: true,
    challenges: true,
    dailyProblem: true,
    favorites: true,
    problemTimer: true,
    profileCompare: true,
    annotate: false,
    draw: false,
    modernize: true,
    siteTheme: false
  };
  const DEFAULT_UI_THEME = "light";
  const DEFAULT_SITE_THEME = "light";

  const store = (chrome && chrome.storage && chrome.storage.local) || null;

  function get(keys) {
    return new Promise((res) => {
      if (!store) return res({});
      try {
        store.get(keys, (v) => {
          if (chrome.runtime && chrome.runtime.lastError) return res({});
          res(v || {});
        });
      } catch (e) {
        res({});
      }
    });
  }
  function set(obj) {
    return new Promise((res) => {
      if (!store) return res();
      try {
        store.set(obj, () => {
          if (chrome.runtime && chrome.runtime.lastError) return res();
          res();
        });
      } catch (e) {
        res();
      }
    });
  }

  async function load() {
    const raw = await get([KEYS.UI_THEME, KEYS.SITE_THEME, KEYS.CUSTOM_ACCENT, KEYS.FEATURES]);
    const features = Object.assign({}, DEFAULT_FEATURES, raw[KEYS.FEATURES] || {});
    // Re-register the user's custom palette (built from one accent) so get("custom")
    // resolves it everywhere — popup, injected tools, and the site recolour.
    if (raw[KEYS.CUSTOM_ACCENT] && self.CPOS_THEMES && self.CPOS_THEMES.registerCustom) {
      self.CPOS_THEMES.registerCustom(raw[KEYS.CUSTOM_ACCENT]);
    }
    return {
      uiTheme: raw[KEYS.UI_THEME] || DEFAULT_UI_THEME,
      siteThemeId: raw[KEYS.SITE_THEME] || DEFAULT_SITE_THEME,
      customAccent: raw[KEYS.CUSTOM_ACCENT] || null,
      features
    };
  }

  // Resolve a true/false for one feature, honoring defaults for missing keys.
  async function feature(name) {
    const cfg = await load();
    return cfg.features[name] !== false && (cfg.features[name] === true || DEFAULT_FEATURES[name]);
  }

  // The theme id everything paints with. There is ONE chosen theme (cpos.ui.theme)
  // that drives the popup, every injected CPOS UI surface, AND the optional site
  // recolour — so the whole experience stays visually consistent. (siteThemeId is
  // kept in storage only for backward-compat; it is no longer a separate palette.)
  async function activeThemeId() {
    const cfg = await load();
    return cfg.uiTheme;
  }

  // Theme for CPOS UI injected into the page content. When whole-site theming is
  // disabled, keep injected widgets visually native/light instead of using the
  // popup's dark palette on Codeforces' light page.
  async function activePageThemeId() {
    const cfg = await load();
    return cfg.features.siteTheme === false ? "light" : cfg.uiTheme;
  }

  // Write defaults once so the popup toggles reflect reality on first run.
  async function ensureDefaults() {
    const raw = await get([KEYS.FEATURES]);
    if (!raw[KEYS.FEATURES]) await set({ [KEYS.FEATURES]: DEFAULT_FEATURES });
  }

  function onChange(cb) {
    try {
      if (!chrome.storage || !chrome.storage.onChanged) return;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes[KEYS.FEATURES] || changes[KEYS.UI_THEME] || changes[KEYS.SITE_THEME] || changes[KEYS.CUSTOM_ACCENT]) {
          cb(changes);
        }
      });
    } catch (e) {
      /* Extension context was invalidated; the page reload will get a fresh script. */
    }
  }

  root.CPOS = {
    KEYS,
    DEFAULT_FEATURES,
    DEFAULT_UI_THEME,
    DEFAULT_SITE_THEME,
    get,
    set,
    load,
    feature,
    activeThemeId,
    activePageThemeId,
    ensureDefaults,
    onChange
  };
})(typeof self !== "undefined" ? self : this);
