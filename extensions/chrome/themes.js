// Shared CPOS theme tokens — loaded by the popup, the analytics page, and the
// page content scripts so everything (popup chrome + injected site themes)
// draws from one palette. Flat, no gradients; mirrors the VS Code panel / TUI.
//
// Each theme is a flat map of CSS custom properties. `applyTheme(root, id)`
// writes them onto an element's style. Site theming (Phase 3) maps a subset of
// these onto Codeforces/CSES selectors.

(function (root) {
  const THEMES = {
    purple: {
      name: "Purple",
      "--bg": "#14141f",
      "--panel": "#1b1b2b",
      "--panel-2": "#20202e",
      "--fg": "#e8e6f0",
      "--dim": "#8a86a3",
      "--border": "#2a2a3e",
      "--accent": "#b794ff",
      "--accent-dim": "#7c5cbf",
      "--accent-on": "#14141f",
      "--ok": "#7ee787",
      "--bad": "#ff7a93",
      "--warn": "#f0b860",
      "--cf": "#7aa2f7"
    },
    github: {
      name: "GitHub Dark",
      "--bg": "#0d1117",
      "--panel": "#161b22",
      "--panel-2": "#1c2128",
      "--fg": "#e6edf3",
      "--dim": "#7d8590",
      "--border": "#30363d",
      "--accent": "#6cb6ff",
      "--accent-dim": "#3b6ea5",
      "--accent-on": "#0d1117",
      "--ok": "#3fb950",
      "--bad": "#f85149",
      "--warn": "#d29922",
      "--cf": "#6cb6ff"
    },
    amber: {
      name: "Amber",
      "--bg": "#16130c",
      "--panel": "#1e1a10",
      "--panel-2": "#2a2418",
      "--fg": "#f1e9d6",
      "--dim": "#a8966c",
      "--border": "#2a2418",
      "--accent": "#f0b860",
      "--accent-dim": "#aa7c30",
      "--accent-on": "#16130c",
      "--ok": "#b8c46a",
      "--bad": "#e88a6a",
      "--warn": "#f0b860",
      "--cf": "#e0b341"
    },
    mono: {
      name: "Mono",
      "--bg": "#101010",
      "--panel": "#181818",
      "--panel-2": "#202020",
      "--fg": "#e0e0e0",
      "--dim": "#8a8a8a",
      "--border": "#2a2a2a",
      "--accent": "#e0e0e0",
      "--accent-dim": "#8a8a8a",
      "--accent-on": "#101010",
      "--ok": "#c8d4c8",
      "--bad": "#d6b0b0",
      "--warn": "#d8cba0",
      "--cf": "#cfcfcf"
    },
    light: {
      name: "Neutral",
      "--bg": "#f7f7f8",
      "--panel": "#ffffff",
      "--panel-2": "#f0f1f3",
      "--fg": "#1f2328",
      "--dim": "#6b7280",
      "--border": "#d5d7dc",
      "--accent": "#2f6df6",
      "--accent-dim": "#1f56cf",
      "--accent-on": "#ffffff",
      "--ok": "#1a7f37",
      "--bad": "#cf222e",
      "--warn": "#9a6700",
      "--cf": "#44546a"
    },
    // Flat teal/slate dark palette (no gradients), tuned for CF dark-mode contrast.
    ocean: {
      name: "Ocean",
      "--bg": "#0c1418",
      "--panel": "#111c22",
      "--panel-2": "#16242c",
      "--fg": "#dce8ec",
      "--dim": "#7e95a0",
      "--border": "#243640",
      "--accent": "#4fd1c5",
      "--accent-dim": "#2c8a82",
      "--accent-on": "#0c1418",
      "--ok": "#5bd99a",
      "--bad": "#ff8b8b",
      "--warn": "#e6c060",
      "--cf": "#6cc5e0"
    },
    // Flat rose-tinted dark palette (no gradients), warm but high-contrast.
    rose: {
      name: "Rose",
      "--bg": "#151013",
      "--panel": "#1c1418",
      "--panel-2": "#241a1f",
      "--fg": "#f0e2e6",
      "--dim": "#a98a92",
      "--border": "#33242a",
      "--accent": "#ff8fb0",
      "--accent-dim": "#bf5d79",
      "--accent-on": "#151013",
      "--ok": "#8fd6a0",
      "--bad": "#ff7a7a",
      "--warn": "#e8b96a",
      "--cf": "#f49ac0"
    },
    // Catppuccin themes
    catppuccin: {
      name: "Catppuccin Mocha",
      "--bg": "#1e1e2e",
      "--panel": "#181825",
      "--panel-2": "#11111b",
      "--fg": "#cdd6f4",
      "--dim": "#a6adc8",
      "--border": "#313244",
      "--accent": "#cba6f7",
      "--accent-dim": "#7f4fa8",
      "--accent-on": "#1e1e2e",
      "--ok": "#a6e3a1",
      "--bad": "#f38ba8",
      "--warn": "#f9e2af",
      "--cf": "#89b4fa"
    },
    catppuccin_latte: {
      name: "Catppuccin Latte",
      "--bg": "#eff1f5",
      "--panel": "#e8ebf0",
      "--panel-2": "#dce0e8",
      "--fg": "#4c4f69",
      "--dim": "#6c6f85",
      "--border": "#ccd0da",
      "--accent": "#8839ef",
      "--accent-dim": "#6120b0",
      "--accent-on": "#eff1f5",
      "--ok": "#40a02b",
      "--bad": "#d20f39",
      "--warn": "#df8e1d",
      "--cf": "#1e66f5"
    },
  };

  // Structural token defaults — the geometry scale CPOS_STYLE_CORE applies. Kept
  // here so the palette file is the single place to tweak the look. These are
  // NOT per-theme colour keys; they're shared, flat (no gradients) and read by
  // the style core's STRUCT defaults. Exposed for reference / popup use.
  //
  // Two derived values reference var(--accent)/var(--fg): they resolve on the
  // element they're written to, giving every surface a theme-aware accent tint
  // ladder (wash < soft < dim < accent) and a soft, light-logic elevation that
  // works on light themes (no muddy fixed-black shadows).
  const STRUCT_TOKENS = {
    "--radius-sm": "8px",
    "--radius": "12px",
    "--radius-lg": "16px",
    "--radius-pill": "999px",
    "--space": "16px",
    "--shadow": "0 1px 2px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04)",
    "--shadow-float": "0 1px 2px color-mix(in srgb, var(--fg) 9%, transparent), 0 8px 24px color-mix(in srgb, var(--fg) 13%, transparent)",
    "--accent-soft": "color-mix(in srgb, var(--accent) 16%, transparent)",
    "--accent-wash": "color-mix(in srgb, var(--accent) 8%, transparent)",
    "--font-sans":
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif',
    "--font-mono":
      'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
  };

  const DEFAULT_THEME = "light";

  // ── custom theme (built from a single accent the user picks) ────────────────
  function clamp8(n) { return Math.max(0, Math.min(255, Math.round(n))); }
  function parseHex(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function toHex(r, g, b) { return "#" + ((1 << 24) + (clamp8(r) << 16) + (clamp8(g) << 8) + clamp8(b)).toString(16).slice(1); }
  function mix(hex, amt) { const c = parseHex(hex); return c ? toHex(c.r + amt, c.g + amt, c.b + amt) : hex; }
  function luminance(hex) { const c = parseHex(hex); return c ? (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255 : 0.5; }

  // Derive a full flat dark palette from one accent colour. Base stays a neutral
  // near-black so the accent reads on every surface; ink auto-contrasts.
  function buildFromAccent(accent) {
    const a = parseHex(accent) ? accent : "#b794ff";
    const on = luminance(a) > 0.6 ? "#15151c" : "#ffffff";
    return {
      name: "Custom",
      "--bg": "#101015", "--panel": "#17171f", "--panel-2": "#1f1f29",
      "--fg": "#e9e8f0", "--dim": "#8b8a9c", "--border": "#2b2b39",
      "--accent": a, "--accent-dim": mix(a, -46), "--accent-on": on,
      "--ok": "#7ee787", "--bad": "#ff7a93", "--warn": "#f0b860", "--cf": a
    };
  }
  // The live custom theme (re-registered from storage by callers). Defaults to
  // the default accent until the user picks one.
  THEMES.custom = buildFromAccent(THEMES.purple["--accent"]);
  function registerCustom(accent) { THEMES.custom = buildFromAccent(accent); return THEMES.custom; }

  function get(id) {
    return THEMES[id] || THEMES[DEFAULT_THEME];
  }

  function applyTheme(el, id) {
    const theme = get(id);
    for (const [key, value] of Object.entries(theme)) {
      if (key === "name") continue;
      el.style.setProperty(key, value);
    }
    // Also write the shared geometry/elevation/accent-ladder tokens so popup
    // CSS can use var(--radius)/var(--font-sans)/var(--accent-soft)/etc.
    for (const [key, value] of Object.entries(STRUCT_TOKENS)) el.style.setProperty(key, value);
  }

  // Dev guard: catch palette slips (non-6-digit hex, or accent that collapses
  // into --dim with no hierarchy — the "everything looks gray" tell).
  (function validateThemes() {
    try {
      const hex = /^#[0-9a-f]{6}$/i;
      for (const [id, t] of Object.entries(THEMES)) {
        for (const [k, v] of Object.entries(t)) {
          if (k === "name") continue;
          if (!hex.test(v)) console.warn("CPOS theme " + id + ": " + k + " is not 6-digit hex (" + v + ")");
        }
        if (t["--accent"] && t["--accent"] === t["--dim"]) console.warn("CPOS theme " + id + ": --accent equals --dim (no hierarchy)");
      }
    } catch (_) { /* never block load */ }
  })();

  // Preset ids only (excludes the special "custom" entry) — for swatch rows.
  const PRESETS = ["purple", "github", "amber", "mono", "light", "ocean", "rose", "catppuccin", "catppuccin_latte"];
  const api = { THEMES, DEFAULT_THEME, STRUCT_TOKENS, get, applyTheme, registerCustom, buildFromAccent, presets: () => PRESETS.slice(), list: () => Object.keys(THEMES) };

  // Works both as a content-script global and (via importScripts-free) the popup.
  root.CPOS_THEMES = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this);
