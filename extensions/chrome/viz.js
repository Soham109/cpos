// CPOS structure visualizer — a slide-in panel on CF/CSES/AtCoder problem
// pages (a sibling of the in-browser editor pill) that draws the problem's
// sample tests as the structure they are: graph, tree, grid, matrix, array,
// permutation cycles, intervals or points. All rendering happens locally in
// viz-core.js; this file only scrapes the page's public samples, mounts the
// core, and manages the pill/panel chrome. It never touches capture/submit.
(function () {
  const T = self.CPOS_THEMES;
  const C = self.CPOS;
  const VIZ = self.CPOS_VIZ;
  const WIDTH_KEY = "cpos.viz.width";
  const RUNNERS = ["http://127.0.0.1:27122", "http://127.0.0.1:27121"];

  // ---- page context -------------------------------------------------------
  const isCf = location.hostname.endsWith("codeforces.com");
  const isCses = location.hostname.endsWith("cses.fi");
  const isAtcoder = location.hostname.endsWith("atcoder.jp");
  function problemLabel() {
    if (isCf) {
      const m = location.pathname.match(/\/(?:contest|gym)\/(\d+)\/problem\/([^/]+)/i)
        || location.pathname.match(/\/problemset\/problem\/(\d+)\/([^/]+)/i);
      if (m) return m[1] + m[2].toUpperCase();
    }
    if (isCses) {
      const m = location.pathname.match(/\/problemset\/task\/(\d+)/);
      if (m) return "CSES " + m[1];
    }
    if (isAtcoder) {
      const m = location.pathname.match(/\/contests\/[^/]+\/tasks\/([^/?#]+)/);
      if (m) return m[1];
    }
    return "Problem";
  }
  const onProblemPage =
    (isCf && /\/(problemset\/problem|contest\/\d+\/problem|gym\/\d+\/problem)\//.test(location.pathname)) ||
    (isCses && /\/problemset\/task\/\d+/.test(location.pathname)) ||
    (isAtcoder && /\/contests\/[^/]+\/tasks\//.test(location.pathname));
  // Same per-problem key the in-browser editor uses to store code, so the
  // visualizer can run exactly what you wrote in the EDITOR panel.
  function problemKey() {
    if (isCf) {
      let m = location.pathname.match(/\/(?:contest|gym)\/(\d+)\/problem\/([^/]+)/i);
      if (m) return "cf:" + m[1] + m[2].toUpperCase();
      m = location.pathname.match(/\/problemset\/problem\/(\d+)\/([^/]+)/i);
      if (m) return "cf:" + m[1] + m[2].toUpperCase();
    }
    if (isCses) {
      const m = location.pathname.match(/\/problemset\/task\/(\d+)/);
      if (m) return "cses:" + m[1];
    }
    return "p:" + location.pathname;
  }

  // ---- storage --------------------------------------------------------------
  const sget = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v || {})));
  const sset = (o) => new Promise((r) => chrome.storage.local.set(o, () => r()));

  async function applyChrome(node) {
    if (!T || !C) return;
    const theme = T.get(await C.activeThemeId());
    const map = { "--cpos-bg": "--bg", "--cpos-panel": "--panel", "--cpos-panel-2": "--panel-2", "--cpos-fg": "--fg", "--cpos-dim": "--dim", "--cpos-border": "--border", "--cpos-accent": "--accent" };
    for (const [out, src] of Object.entries(map)) node.style.setProperty(out, theme[src]);
  }

  // ---- sample scraping ------------------------------------------------------
  function preToText(pre) {
    // New CF renders each line as a <div>; join them with newlines.
    const divs = pre.querySelectorAll("div");
    if (divs.length) return [...divs].map((d) => d.textContent).join("\n").trim();
    return pre.textContent.trim();
  }
  /** Block line counts from Codeforces test-example-line-N markup. */
  function blockSizes(preEl) {
    const lineEls = preEl.querySelectorAll(".test-example-line");
    if (!lineEls.length) return undefined;
    const counts = new Map();
    lineEls.forEach((line) => {
      if (/\btest-example-line-op\b/.test(line.className)) return;
      const m = line.className.match(/test-example-line-(\d+)/);
      const id = m ? parseInt(m[1], 10) : 0;
      counts.set(id, (counts.get(id) || 0) + 1);
    });
    const ids = [...counts.keys()].sort((a, b) => a - b);
    const sizes = ids.map((id) => counts.get(id));
    return sizes.length ? sizes : undefined;
  }
  function scrapeSamples() {
    const tests = [];
    if (isCf) {
      document.querySelectorAll(".sample-test").forEach((st) => {
        const ins = st.querySelectorAll(".input pre");
        const outs = st.querySelectorAll(".output pre");
        const n = Math.min(ins.length, outs.length);
        for (let i = 0; i < n; i++) {
          tests.push({
            input: preToText(ins[i]),
            expected: preToText(outs[i]),
            input_block_sizes: blockSizes(ins[i])
          });
        }
      });
    } else if (isAtcoder) {
      // AtCoder task pages carry ja+en copies of each sample; prefer English.
      const scope = document.querySelector("#task-statement .lang-en") || document.querySelector("#task-statement") || document;
      const ins = [], outs = [];
      scope.querySelectorAll("h3").forEach((h) => {
        const label = h.textContent || "";
        const pre = h.parentElement ? h.parentElement.querySelector("pre") : null;
        if (!pre) return;
        if (/sample input|入力例/i.test(label)) ins.push(pre.textContent.trim());
        else if (/sample output|出力例/i.test(label)) outs.push(pre.textContent.trim());
      });
      const n = Math.min(ins.length, outs.length);
      for (let i = 0; i < n; i++) tests.push({ input: ins[i], expected: outs[i] });
    } else {
      // CSES shows examples in <pre> pairs under the statement.
      const pres = [...document.querySelectorAll(".content pre, pre")];
      for (let i = 0; i + 1 < pres.length; i += 2) {
        tests.push({ input: pres[i].textContent.trim(), expected: pres[i + 1].textContent.trim() });
      }
    }
    return tests;
  }
  function statementText() {
    const el = (isCf && document.querySelector(".problem-statement"))
      || (isAtcoder && (document.querySelector("#task-statement .lang-en") || document.querySelector("#task-statement")))
      || (isCses && document.querySelector(".content"))
      || null;
    return el ? (el.textContent || "").slice(0, 20000) : document.title;
  }

  // ---- run-with-trace ---------------------------------------------------------
  // Reuses the in-browser editor's saved code and the local CPOS runner (/run on
  // the VS Code extension or the terminal app), which captures stderr per test.
  async function runTrace(input) {
    const codeKey = "cpos.ide.code." + problemKey();
    const conf = await sget([codeKey, "cpos.ide.lang"]);
    const code = conf[codeKey];
    if (!code || !String(code).trim()) {
      throw new Error("No code saved for this problem — write your solution in the EDITOR panel first, then hit ▶ RUN here.");
    }
    const language = conf["cpos.ide.lang"] || "cpp";
    let lastErr = null;
    for (const base of RUNNERS) {
      try {
        const res = await fetch(base + "/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, language, trace: true, tests: [{ input, expected: "" }] })
        });
        if (!res.ok) { lastErr = new Error("runner error " + res.status); continue; }
        const data = await res.json();
        const r = data && Array.isArray(data.results) ? data.results[0] : null;
        if (!r) { lastErr = new Error("runner returned no result"); continue; }
        if (r.verdict === "CE") throw new Error("compile error — fix it in the EDITOR panel (Run there shows the full message)");
        return { stderr: r.stderr || "", verdict: r.verdict, actual: r.actual };
      } catch (e) {
        if (e && /compile error/.test(String(e.message))) throw e;
        lastErr = e;
      }
    }
    throw new Error("No local CPOS runner reachable — open VS Code with the CPOS extension (or the terminal app) and try again." + (lastErr ? "" : ""));
  }

  // ---- panel ------------------------------------------------------------------
  let panel = null, launch = null, ctl = null;

  async function buildPanel() {
    if (document.getElementById("cpos-viz-panel") || !VIZ) return;
    const conf = await sget([WIDTH_KEY]);
    const width = Math.max(380, Math.min(conf[WIDTH_KEY] || 560, Math.round(window.innerWidth * 0.85)));

    launch = document.createElement("button");
    launch.id = "cpos-viz-launch";
    launch.innerHTML = '<span class="lglyph">◈</span><span class="lword">VIZ</span>';
    launch.title = "CPOS visualizer — draw this problem's samples as graphs, grids, arrays…";
    document.body.appendChild(launch);

    panel = document.createElement("div");
    panel.id = "cpos-viz-panel";
    panel.style.width = width + "px";
    panel.innerHTML =
      '<div class="cpos-viz-grip" title="Drag to resize"></div>' +
      '<div class="cpos-viz-head">' +
        '<span class="pid">' + problemLabel() + "</span>" +
        '<span class="dim">structure visualizer</span>' +
        '<span class="grow"></span>' +
        '<button class="ic" id="cpos-viz-zen" title="Maximize">⤢</button>' +
        '<button class="x" title="Close visualizer">✕</button>' +
      "</div>" +
      '<div class="cpos-viz-body" id="cpos-viz-mount"></div>';
    document.body.appendChild(panel);
    await applyChrome(panel);
    await applyChrome(launch);

    ctl = VIZ.mount(panel.querySelector("#cpos-viz-mount"), {
      tests: scrapeSamples(),
      statementText: statementText(),
      problemLabel: problemLabel(),
      runTrace
    });

    launch.onclick = () => {
      const open = panel.classList.toggle("open");
      if (open && ctl) ctl.repaint();
    };
    panel.querySelector(".x").onclick = () => panel.classList.remove("open");
    panel.querySelector("#cpos-viz-zen").onclick = () => {
      panel.classList.toggle("zen");
      if (ctl) ctl.repaint();
    };

    // resize grip
    const grip = panel.querySelector(".cpos-viz-grip");
    let dragging = false;
    grip.addEventListener("mousedown", (e) => {
      if (panel.classList.contains("zen")) return;
      dragging = true;
      e.preventDefault();
      panel.style.transition = "none";
      document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const w = Math.max(380, Math.min(window.innerWidth - e.clientX, Math.round(window.innerWidth * 0.85)));
      panel.style.width = w + "px";
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      panel.style.transition = "";
      document.body.style.userSelect = "";
      void sset({ [WIDTH_KEY]: parseInt(panel.style.width, 10) || 560 });
      if (ctl) ctl.repaint();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && panel && panel.classList.contains("open")) panel.classList.remove("open");
    });
  }

  // ---- lifecycle ------------------------------------------------------------------
  function teardown() {
    try { ctl?.destroy?.(); } catch {}
    document.getElementById("cpos-viz-panel")?.remove();
    document.getElementById("cpos-viz-launch")?.remove();
    panel = launch = ctl = null;
  }
  async function sync() {
    if (!C) return;
    const on = await C.feature("viz");
    if (on && onProblemPage) buildPanel().catch((e) => console.debug("CPOS viz:", e));
    else teardown();
  }

  if (C) {
    C.onChange((changes) => {
      const repaint = async () => {
        if (panel) await applyChrome(panel);
        if (launch) await applyChrome(launch);
        if (ctl) ctl.repaint();
      };
      if (changes[C.KEYS.FEATURES]) sync().then(repaint);
      else void repaint();
    });
  }
  if (onProblemPage) sync();
})();
