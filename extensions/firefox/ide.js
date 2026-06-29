// CPOS in-browser editor — an IDE-style slide-in panel on CF/CSES problem pages.
// Resizable, pushes the page (no overlap), multiple editor colour schemes, a
// a syntax-coloured editable code surface, a Run console that checks your
// solution against the page's sample tests via the local CPOS runner, and
// one-click Submit. SUBMISSION REUSES the existing background "cpos-cf-submit"
// injector — it never reimplements or alters capture/submit logic.
//
// Editor UX is LeetCode-grade: current-line highlight, bracket matching with
// auto-close for brackets/quotes, auto-indent that carries indentation (extra
// after "{"/":"), in-editor find & replace (Ctrl/Cmd+F), a font-size control,
// a line-wrap toggle, and Tab=4 spaces. The Run panel renders per-test cards
// with AC/WA/TLE/RE coloring, a got-vs-expected diff, optional time/memory,
// a custom-stdin box, and an "X/Y passed" summary. Layout adds a maximize/zen
// toggle on top of the existing resizable, page-pushing side panel.
(function () {
  const T = self.CPOS_THEMES;
  const C = self.CPOS;
  const HL = self.CPOS_HL;
  const SUBMIT_KEY = "cpos.ide.submit";
  const RUNNERS = ["http://127.0.0.1:27122", "http://127.0.0.1:27121"];

  const LANGS = [
    ["cpp", "C++"], ["python", "Python 3"], ["pypy", "PyPy 3"], ["java", "Java"],
    ["kotlin", "Kotlin"], ["rust", "Rust"], ["go", "Go"], ["csharp", "C#"], ["javascript", "JavaScript"]
  ];
  const HL_LANG = { cpp: "cpp", pypy: "py", python: "py", java: "java", javascript: "js" };
  // Languages whose blocks open with ":" (extra auto-indent after a line ending in ":").
  const COLON_INDENT = { python: true, pypy: true };
  const STARTERS = {
    cpp: "#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n\n    return 0;\n}\n",
    python: "import sys\ninput = sys.stdin.readline\n\n",
    pypy: "import sys\ninput = sys.stdin.readline\n\n",
    java: "import java.util.*;\nimport java.io.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n\n    }\n}\n"
  };

  // IDE colour schemes for the editor surface (token colours, gutter, caret).
  const EDITOR_THEMES = {
    "vscode-dark": { name: "VS Dark+", bg: "#1e1e1e", fg: "#d4d4d4", gutter: "#858585", caret: "#aeafad", sel: "#264f7855", line: "#ffffff0d", kw: "#569cd6", type: "#4ec9b0", str: "#ce9178", num: "#b5cea8", com: "#6a9955", fn: "#dcdcaa", pre: "#c586c0", panel: "#252526", border: "#333333" },
    monokai: { name: "Monokai", bg: "#272822", fg: "#f8f8f2", gutter: "#90908a", caret: "#f8f8f0", sel: "#49483e", line: "#ffffff0a", kw: "#f92672", type: "#66d9ef", str: "#e6db74", num: "#ae81ff", com: "#75715e", fn: "#a6e22e", pre: "#f92672", panel: "#2d2e27", border: "#3b3c35" },
    dracula: { name: "Dracula", bg: "#282a36", fg: "#f8f8f2", gutter: "#6272a4", caret: "#f8f8f2", sel: "#44475a", line: "#ffffff0a", kw: "#ff79c6", type: "#8be9fd", str: "#f1fa8c", num: "#bd93f9", com: "#6272a4", fn: "#50fa7b", pre: "#ff79c6", panel: "#21222c", border: "#3a3c4e" },
    nord: { name: "Nord", bg: "#2e3440", fg: "#d8dee9", gutter: "#4c566a", caret: "#d8dee9", sel: "#434c5e", line: "#ffffff0a", kw: "#81a1c1", type: "#8fbcbb", str: "#a3be8c", num: "#b48ead", com: "#616e88", fn: "#88c0d0", pre: "#81a1c1", panel: "#3b4252", border: "#434c5e" },
    "github-light": { name: "GitHub Light", bg: "#ffffff", fg: "#24292e", gutter: "#babbbd", caret: "#24292e", sel: "#c8e1ff", line: "#0000000a", kw: "#d73a49", type: "#6f42c1", str: "#032f62", num: "#005cc5", com: "#6a737d", fn: "#6f42c1", pre: "#d73a49", panel: "#f6f8fa", border: "#d0d7de" }
  };
  const EDITOR_THEME_IDS = Object.keys(EDITOR_THEMES);

  // ---- page context -------------------------------------------------------
  const isCf = location.hostname.endsWith("codeforces.com");
  function cfCtx() {
    let m = location.pathname.match(/\/contest\/(\d+)\/problem\/([^/]+)/i);
    if (m) return { kind: "contest", contest: m[1], index: m[2].toUpperCase(), submitUrl: `/contest/${m[1]}/submit` };
    m = location.pathname.match(/\/gym\/(\d+)\/problem\/([^/]+)/i);
    if (m) return { kind: "gym", contest: m[1], index: m[2].toUpperCase(), submitUrl: `/gym/${m[1]}/submit` };
    m = location.pathname.match(/\/problemset\/problem\/(\d+)\/([^/]+)/i);
    if (m) return { kind: "problemset", contest: m[1], index: m[2].toUpperCase(), submitUrl: `/problemset/submit/${m[1]}/${m[2].toUpperCase()}` };
    return null;
  }
  function csesCtx() {
    const m = location.pathname.match(/\/problemset\/task\/(\d+)/);
    return m ? { kind: "cses", id: m[1], submitUrl: `/problemset/submit/${m[1]}/` } : null;
  }
  const ctx = isCf ? cfCtx() : csesCtx();
  const onProblemPage = !!ctx && !/\/submit/.test(location.pathname);
  const onSubmitPage = isCf && /\/submit/.test(location.pathname);
  const problemKey = () => (isCf && ctx ? `cf:${ctx.contest}${ctx.index}` : ctx && ctx.kind === "cses" ? `cses:${ctx.id}` : "p:" + location.pathname);
  const problemLabel = () => (isCf && ctx ? ctx.contest + ctx.index : ctx && ctx.kind === "cses" ? "CSES " + ctx.id : "Problem");

  // ---- storage ------------------------------------------------------------
  const sget = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v || {})));
  const sset = (o) => new Promise((r) => chrome.storage.local.set(o, () => r()));
  const sdel = (k) => new Promise((r) => chrome.storage.local.remove(k, () => r()));
  const codeKey = () => "cpos.ide.code." + problemKey();
  const FONT_KEY = "cpos.ide.fontSize";
  const WRAP_KEY = "cpos.ide.wrap";
  const CONSOLE_H_KEY = "cpos.ide.consoleH";
  const TEMPLATES_KEY = "cpos.templates";
  const TEMPLATE_DIRTY_KEY = "cpos.templates.dirty";

  async function syncTemplatesFromRunner() {
    for (const base of RUNNERS) {
      try {
        const res = await fetch(base + "/config", { cache: "no-store" });
        if (!res.ok) continue;
        const data = await res.json();
        if (data && data.templates) {
          const local = await sget([TEMPLATES_KEY, TEMPLATE_DIRTY_KEY]);
          const templates = Object.assign({}, local[TEMPLATES_KEY] || {});
          const dirty = Object.assign({}, local[TEMPLATE_DIRTY_KEY] || {});
          for (const [lang, content] of Object.entries(data.templates)) {
            if (!dirty[lang]) templates[lang] = content;
          }
          for (const lang of Object.keys(dirty)) {
            if (!dirty[lang]) continue;
            const saved = await fetch(base + "/config", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ language: lang, content: templates[lang] || "" })
            });
            if (saved.ok) delete dirty[lang];
          }
          await sset({ [TEMPLATES_KEY]: templates, [TEMPLATE_DIRTY_KEY]: dirty });
        }
        return;
      } catch (_) {
        /* try next runner */
      }
    }
  }

  async function applyChrome(node) {
    if (!T || !C) return;
    const theme = T.get(await C.activeThemeId());
    const map = { "--cpos-bg": "--bg", "--cpos-panel": "--panel", "--cpos-panel-2": "--panel-2", "--cpos-fg": "--fg", "--cpos-dim": "--dim", "--cpos-border": "--border", "--cpos-accent": "--accent" };
    for (const [out, src] of Object.entries(map)) node.style.setProperty(out, theme[src]);
  }
  function applyEditorTheme(root, id) {
    const t = EDITOR_THEMES[id] || EDITOR_THEMES["vscode-dark"];
    const v = {
      "--ed-bg": t.bg, "--ed-fg": t.fg, "--ed-gutter": t.gutter, "--ed-caret": t.caret, "--ed-sel": t.sel, "--ed-line": t.line,
      "--ed-kw": t.kw, "--ed-type": t.type, "--ed-str": t.str, "--ed-num": t.num, "--ed-com": t.com,
      "--ed-fn": t.fn, "--ed-pre": t.pre, "--ed-panel": t.panel, "--ed-border": t.border
    };
    for (const [k, val] of Object.entries(v)) root.style.setProperty(k, val);
  }

  // ---- editor (contenteditable code surface + gutter) ----------------------
  // One visible editable layer owns both text and colours. That keeps the caret
  // in the same DOM the user sees, avoiding textarea/highlight overlay drift.
  const OPEN_BRACKETS = { "(": ")", "[": "]", "{": "}" };
  const CLOSE_BRACKETS = { ")": "(", "]": "[", "}": "{" };
  const QUOTES = { '"': true, "'": true, "`": true };

  function mountEditor(container, initial, lang, onChange, onCursor) {
    if (self.CPOS_CM && typeof self.CPOS_CM.createEditor === "function") {
      const wrap = document.createElement("div");
      wrap.className = "cpos-ed cpos-ed-cm";
      container.appendChild(wrap);
      const cm = self.CPOS_CM.createEditor(wrap, {
        value: initial || "",
        lang,
        wrap: false,
        fontSize: 15,
        onChange,
        onCursor
      });
      return {
        el: cm.el,
        getValue: cm.getValue,
        setValue: cm.setValue,
        setLang: cm.setLang,
        focus: cm.focus,
        setFontSize: cm.setFontSize,
        setWrap: (on) => { wrap.classList.toggle("wrap", !!on); cm.setWrap(on); },
        select: cm.select,
        replaceRange: cm.replaceRange,
        cursorPos: cm.cursorPos,
        selectedText: cm.selectedText,
        scrollToCaret: () => {},
        destroy: cm.destroy
      };
    }

    const wrap = document.createElement("div");
    wrap.className = "cpos-ed";
    const gutter = document.createElement("div");
    gutter.className = "cpos-ed-gutter";
    const scroll = document.createElement("div");
    scroll.className = "cpos-ed-scroll";
    const lineHi = document.createElement("div");
    lineHi.className = "cpos-ed-line";
    const ta = document.createElement("div");
    ta.className = "cpos-ed-ta";
    ta.contentEditable = "true";
    ta.setAttribute("role", "textbox");
    ta.setAttribute("aria-multiline", "true");
    ta.spellcheck = false;
    ta.autocomplete = "off";
    ta.autocapitalize = "off";
    scroll.appendChild(lineHi);
    scroll.appendChild(ta);
    wrap.appendChild(gutter);
    wrap.appendChild(scroll);
    container.appendChild(wrap);

    let curLang = lang;
    let wrapOn = false;
    let value = initial || "";
    let lastSel = { start: 0, end: 0 };
    const escape = (s) => (HL && HL.esc ? HL.esc(s) : String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])));
    const normalizeText = (s) => String(s || "").replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n");
    function editorMetrics() {
      const cs = getComputedStyle(ta);
      const fs = parseFloat(cs.fontSize) || 14;
      const parsed = parseFloat(cs.lineHeight);
      return {
        lh: Number.isFinite(parsed) ? parsed : fs * 1.55,
        padTop: parseFloat(cs.paddingTop) || 0
      };
    }
    function containsSelection() {
      const sel = getSelection();
      return !!sel && sel.rangeCount > 0 && ta.contains(sel.anchorNode) && ta.contains(sel.focusNode);
    }
    function offsetFor(node, offset) {
      if (!ta.contains(node) && node !== ta) return lastSel.start;
      const r = document.createRange();
      r.selectNodeContents(ta);
      try { r.setEnd(node, offset); }
      catch { return lastSel.start; }
      const currentLen = normalizeText(ta.textContent).length;
      return Math.max(0, Math.min(currentLen, normalizeText(r.toString()).length));
    }
    function selectionOffsets() {
      const sel = getSelection();
      if (!sel || sel.rangeCount === 0 || !containsSelection()) return lastSel;
      const start = offsetFor(sel.anchorNode, sel.anchorOffset);
      const end = offsetFor(sel.focusNode, sel.focusOffset);
      lastSel = { start: Math.min(start, end), end: Math.max(start, end) };
      return lastSel;
    }
    function locateOffset(offset) {
      offset = Math.max(0, Math.min(value.length, offset));
      const walker = document.createTreeWalker(ta, NodeFilter.SHOW_TEXT);
      let node, seen = 0, last = null;
      while ((node = walker.nextNode())) {
        last = node;
        const len = node.nodeValue.length;
        if (seen + len >= offset) return { node, offset: offset - seen };
        seen += len;
      }
      return last ? { node: last, offset: last.nodeValue.length } : { node: ta, offset: 0 };
    }
    function setSelectionOffsets(start, end = start) {
      lastSel = {
        start: Math.max(0, Math.min(value.length, start)),
        end: Math.max(0, Math.min(value.length, end))
      };
      const sel = getSelection();
      if (!sel) return;
      const a = locateOffset(lastSel.start);
      const b = locateOffset(lastSel.end);
      const r = document.createRange();
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    function highlightedHtml() {
      if (!value) return "<br>";
      const html = HL ? HL.highlight(value, HL_LANG[curLang] || curLang || "cpp") : escape(value);
      return html || "<br>";
    }

    function render(sel = lastSel) {
      ta.innerHTML = highlightedHtml();
      const lines = value.split("\n").length;
      let g = "";
      for (let i = 1; i <= lines; i++) g += i + "\n";
      gutter.textContent = g;
      if (document.activeElement === ta || containsSelection()) setSelectionOffsets(sel.start, sel.end);
    }
    function syncScroll() {
      gutter.style.transform = `translateY(${-ta.scrollTop}px)`;
      positionLine();
    }
    // Current-line band: measured from line metrics, kept in sync with scroll.
    function positionLine() {
      const { lh, padTop } = editorMetrics();
      const pos = selectionOffsets().start;
      const before = value.slice(0, pos);
      // Logical-line row (the band is hidden in wrap mode, where it's ambiguous).
      const row = before.split("\n").length - 1;
      lineHi.style.height = lh + "px";
      lineHi.style.transform = `translateY(${padTop + row * lh - ta.scrollTop}px)`;
    }
    function cursor() {
      const pos = selectionOffsets().start;
      const upto = value.slice(0, pos);
      const line = upto.split("\n").length;
      const col = upto.length - upto.lastIndexOf("\n");
      onCursor && onCursor(line, col, value);
      positionLine();
    }

    function emit(sel = lastSel) { render(sel); onChange(value); cursor(); }
    function replaceRange(start, end, text, caret) {
      value = value.slice(0, start) + text + value.slice(end);
      const pos = caret != null ? caret : start + text.length;
      lastSel = { start: pos, end: pos };
      emit(lastSel);
    }

    // ---- indentation helpers ----
    function lineStartOf(pos) {
      const i = value.lastIndexOf("\n", pos - 1);
      return i + 1;
    }
    function indentOfLine(pos) {
      const start = lineStartOf(pos);
      const m = value.slice(start).match(/^[ \t]*/);
      return m ? m[0] : "";
    }

    function handleEnter(e) {
      const { start: s, end: en } = selectionOffsets();
      const before = value.slice(0, s);
      const lineStart = before.lastIndexOf("\n") + 1;
      const curLine = before.slice(lineStart);
      let indent = (curLine.match(/^[ \t]*/) || [""])[0];
      const trimmed = curLine.trimEnd();
      const lastCh = trimmed.slice(-1);
      const nextCh = value.slice(en, en + 1);
      let extra = "";
      if (lastCh === "{" || (COLON_INDENT[curLang] && lastCh === ":")) extra = "    ";
      // Smart pair: caret sits between {} → open a body and place close on its own line.
      if (lastCh === "{" && nextCh === "}") {
        e.preventDefault();
        const insert = "\n" + indent + "    " + "\n" + indent;
        const caret = s + 1 + indent.length + 4;
        replaceRange(s, en, insert, caret);
        return true;
      }
      e.preventDefault();
      const insert = "\n" + indent + extra;
      replaceRange(s, en, insert, s + insert.length);
      return true;
    }

    function handleBackspace(e) {
      const { start: s, end: en } = selectionOffsets();
      if (s !== en) return false;
      const prev = value.slice(s - 1, s);
      const next = value.slice(s, s + 1);
      // Delete an empty auto-inserted pair as a unit.
      if ((OPEN_BRACKETS[prev] && next === OPEN_BRACKETS[prev]) || (QUOTES[prev] && next === prev)) {
        e.preventDefault();
        replaceRange(s - 1, s + 1, "", s - 1);
        return true;
      }
      // Dedent: if only whitespace precedes the caret on this line, remove up to 4.
      const lineStart = value.lastIndexOf("\n", s - 1) + 1;
      const seg = value.slice(lineStart, s);
      if (seg.length && /^[ \t]+$/.test(seg)) {
        e.preventDefault();
        const remove = Math.min(4, ((seg.length - 1) % 4) + 1);
        replaceRange(s - remove, s, "", s - remove);
        return true;
      }
      return false;
    }

    function handleTab(e) {
      e.preventDefault();
      const { start: s, end: en } = selectionOffsets();
      if (s !== en && value.slice(s, en).includes("\n")) {
        // Block (de)indent across selected lines.
        const startLine = value.lastIndexOf("\n", s - 1) + 1;
        const block = value.slice(startLine, en);
        let out;
        if (e.shiftKey) out = block.replace(/^( {1,4}|\t)/gm, "");
        else out = block.replace(/^/gm, "    ");
        const delta = out.length - block.length;
        value = value.slice(0, startLine) + out + value.slice(en);
        lastSel = { start: startLine, end: en + delta };
        emit(lastSel);
        return;
      }
      if (e.shiftKey) {
        const lineStart = value.lastIndexOf("\n", s - 1) + 1;
        const seg = value.slice(lineStart, lineStart + 4);
        const m = seg.match(/^( {1,4}|\t)/);
        if (m) replaceRange(lineStart, lineStart + m[0].length, "", Math.max(lineStart, s - m[0].length));
        return;
      }
      replaceRange(s, en, "    ", s + 4);
    }

    function handleChar(e, ch) {
      const { start: s, end: en } = selectionOffsets();
      const next = value.slice(en, en + 1);
      // Type-over a matching close bracket / quote.
      if ((CLOSE_BRACKETS[ch] || QUOTES[ch]) && next === ch && s === en) {
        e.preventDefault();
        setSelectionOffsets(s + 1);
        cursor();
        return true;
      }
      // Wrap selection in brackets/quotes.
      if (s !== en && (OPEN_BRACKETS[ch] || QUOTES[ch])) {
        e.preventDefault();
        const close = OPEN_BRACKETS[ch] || ch;
        const selected = value.slice(s, en);
        value = value.slice(0, s) + ch + selected + close + value.slice(en);
        lastSel = { start: s + 1, end: en + 1 };
        emit(lastSel);
        return true;
      }
      // Auto-close: only when followed by whitespace/closer/EOL (avoids noise mid-word).
      if (OPEN_BRACKETS[ch] && (next === "" || /[\s)\]};,]/.test(next))) {
        e.preventDefault();
        replaceRange(s, en, ch + OPEN_BRACKETS[ch], s + 1);
        return true;
      }
      if (QUOTES[ch] && s === en) {
        const prev = value.slice(s - 1, s);
        // Don't auto-close right after a word char (e.g. apostrophes, suffixes).
        if (next === "" || /[\s)\]};,]/.test(next)) {
          if (!/\w/.test(prev) || ch !== "'") {
            e.preventDefault();
            replaceRange(s, en, ch + ch, s + 1);
            return true;
          }
        }
      }
      return false;
    }

    ta.addEventListener("input", () => {
      const sel = selectionOffsets();
      value = normalizeText(ta.textContent);
      lastSel = { start: Math.min(sel.start, value.length), end: Math.min(sel.end, value.length) };
      emit(lastSel);
    });
    ta.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = normalizeText(e.clipboardData?.getData("text/plain") || "");
      const { start, end } = selectionOffsets();
      replaceRange(start, end, text, start + text.length);
    });
    ta.addEventListener("scroll", syncScroll);
    ta.addEventListener("keyup", cursor);
    ta.addEventListener("click", cursor);
    ta.addEventListener("mouseup", cursor);
    ta.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return; // leave shortcuts to the panel
      if (e.key === "Tab") return handleTab(e);
      if (e.key === "Enter") return void handleEnter(e);
      if (e.key === "Backspace") return void handleBackspace(e);
      if (e.key.length === 1 && (OPEN_BRACKETS[e.key] || CLOSE_BRACKETS[e.key] || QUOTES[e.key])) handleChar(e, e.key);
    });
    render();

    return {
      el: ta,
      getValue: () => value,
      setValue: (val) => { value = normalizeText(val); lastSel = { start: 0, end: 0 }; render(lastSel); syncScroll(); cursor(); },
      setLang: (l) => { curLang = l; render(); },
      focus: () => ta.focus(),
      setFontSize: (px) => {
        wrap.style.setProperty("--ed-fs", px + "px");
        // Round the line box to a whole pixel so the browser caret lands on a
        // stable grid at every zoom/font size.
        wrap.style.setProperty("--ed-lh", Math.round(px * 1.55) + "px");
        render(); syncScroll();
      },
      setWrap: (on) => { wrapOn = on; wrap.classList.toggle("wrap", on); render(); syncScroll(); },
      // For find & replace.
      select: (start, end) => { ta.focus(); setSelectionOffsets(start, end); scrollToCaret(); cursor(); },
      replaceRange,
      cursorPos: () => selectionOffsets().start,
      selectedText: () => {
        const { start, end } = selectionOffsets();
        return value.slice(start, end);
      },
      scrollToCaret
    };

    function scrollToCaret() {
      // Best-effort: scroll the line of the caret into view.
      const { lh, padTop } = editorMetrics();
      const row = value.slice(0, selectionOffsets().start).split("\n").length - 1;
      const y = padTop + row * lh;
      if (y < ta.scrollTop) ta.scrollTop = y;
      else if (y + lh > ta.scrollTop + ta.clientHeight) ta.scrollTop = y + lh - ta.clientHeight + lh;
      syncScroll();
    }
  }

  // ---- sample scraping ----------------------------------------------------
  function scrapeSamples() {
    const tests = [];
    if (isCf) {
      document.querySelectorAll(".sample-test").forEach((st) => {
        const ins = st.querySelectorAll(".input pre");
        const outs = st.querySelectorAll(".output pre");
        const n = Math.min(ins.length, outs.length);
        for (let i = 0; i < n; i++) {
          tests.push({ input: preToText(ins[i]), expected: preToText(outs[i]) });
        }
      });
    } else {
      // CSES shows examples in <pre> pairs under the statement.
      const pres = [...document.querySelectorAll(".content pre, pre")];
      for (let i = 0; i + 1 < pres.length; i += 2) {
        tests.push({ input: pres[i].textContent.trim(), expected: pres[i + 1].textContent.trim() });
      }
    }
    return tests;
  }
  function preToText(pre) {
    // New CF renders each line as a <div>; join them with newlines.
    const divs = pre.querySelectorAll("div");
    if (divs.length) return [...divs].map((d) => d.textContent).join("\n").trim();
    return pre.textContent.trim();
  }

  // ---- panel --------------------------------------------------------------
  let panel, editor, msgEl, launch, consoleEl, conBodyEl, statusEl, findBar, customWrap;
  let lastRunData = null;
  // Set while a run is in flight; used to cancel runs and gate re-entrancy.
  let runController = null;

  async function buildPanel() {
    if (document.getElementById("cpos-ide-panel")) return;
    await syncTemplatesFromRunner();
    const conf = await sget([codeKey(), "cpos.ide.lang", "cpos.ide.theme", "cpos.ide.width", FONT_KEY, WRAP_KEY, CONSOLE_H_KEY, TEMPLATES_KEY]);
    const lang = conf["cpos.ide.lang"] || "cpp";
    const templates = conf[TEMPLATES_KEY] || {};
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[TEMPLATES_KEY]) {
        Object.assign(templates, changes[TEMPLATES_KEY].newValue || {});
      }
    });
    const edThemeId = conf["cpos.ide.theme"] || "vscode-dark";
    const width = Math.max(360, Math.min(conf["cpos.ide.width"] || 640, Math.round(window.innerWidth * 0.85)));
    const fontSize = Math.max(10, Math.min(conf[FONT_KEY] || 15, 24));
    const wrapOn = !!conf[WRAP_KEY];

    launch = document.createElement("button");
    launch.id = "cpos-ide-launch";
    launch.innerHTML = '<span class="lglyph">&lt;/&gt;</span><span class="lword">EDITOR</span>';
    launch.title = "CPOS in-browser editor";
    document.body.appendChild(launch);

    panel = document.createElement("div");
    panel.id = "cpos-ide-panel";
    panel.style.width = width + "px";
    panel.innerHTML =
      '<div class="cpos-ide-grip" title="Drag to resize"></div>' +
      '<div class="cpos-ide-head">' +
        '<span class="pid">' + problemLabel() + "</span>" +
        '<span class="grow"></span>' +
        '<select id="cpos-ide-lang" title="Language"></select>' +
        '<select id="cpos-ide-theme" title="Editor theme"></select>' +
        '<button class="ic" id="cpos-ide-find" title="Find & replace (Ctrl/Cmd+F)">⌕</button>' +
        '<button class="ic" id="cpos-ide-wrap" title="Toggle line wrap">↩</button>' +
        '<button class="ic" id="cpos-ide-fdown" title="Decrease font size">A−</button>' +
        '<button class="ic" id="cpos-ide-fup" title="Increase font size">A+</button>' +
        '<button class="ic" id="cpos-ide-zen" title="Maximize / Zen mode">⤢</button>' +
        '<button class="x" title="Close editor">✕</button>' +
      "</div>" +
      '<div class="cpos-ide-find" id="cpos-ide-findbar" hidden>' +
        '<input id="cpos-find-q" placeholder="Find" autocomplete="off" spellcheck="false">' +
        '<input id="cpos-find-r" placeholder="Replace" autocomplete="off" spellcheck="false">' +
        '<span class="fcount" id="cpos-find-count">0/0</span>' +
        '<button id="cpos-find-prev" title="Previous (Shift+Enter)">↑</button>' +
        '<button id="cpos-find-next" title="Next (Enter)">↓</button>' +
        '<button id="cpos-find-rep" title="Replace">Repl</button>' +
        '<button id="cpos-find-repall" title="Replace all">All</button>' +
        '<button id="cpos-find-x" title="Close (Esc)">✕</button>' +
      "</div>" +
      '<div class="cpos-ide-editor"><div class="cpos-ide-mount" id="cpos-ide-mount"></div></div>' +
      '<div class="cpos-ide-console" id="cpos-ide-console" hidden role="region" aria-label="Run results">' +
        '<div class="cpos-con-grip" title="Drag to resize results"></div>' +
        '<div class="cpos-con-bar">' +
          '<span class="cpos-con-label" id="cpos-con-label" aria-live="polite">Results</span>' +
          '<span class="grow"></span>' +
          '<button class="cic" id="cpos-con-jump" title="Jump to first failure" aria-label="Jump to first failure" hidden>↧</button>' +
          '<button class="cic" id="cpos-con-collapse" title="Collapse results" aria-label="Collapse results">▾</button>' +
          '<button class="cic" id="cpos-con-close" title="Close results (Esc)" aria-label="Close results">✕</button>' +
        "</div>" +
        '<div class="cpos-con-body" id="cpos-ide-console-body"></div>' +
      "</div>" +
      '<div class="cpos-ide-status"><span id="cpos-ide-pos">Ln 1, Col 1</span><span class="grow"></span><span id="cpos-ide-langtag">' + lang + "</span></div>" +
      '<div class="cpos-ide-foot">' +
        '<span class="msg"></span>' +
        '<button id="cpos-ide-custom" title="Toggle a custom stdin test">Custom</button>' +
        '<button id="cpos-ide-reset" title="Reset to starter template">Reset</button>' +
        '<button id="cpos-ide-copy">Copy</button>' +
        '<button id="cpos-ide-run" title="Run against sample tests (Ctrl/Cmd+Enter)">▷ Run</button>' +
        '<button class="primary" id="cpos-ide-submit" title="Submit (Ctrl/Cmd+Shift+Enter)">Submit ▸</button>' +
      "</div>";
    document.body.appendChild(panel);

    await applyChrome(panel);
    await applyChrome(launch);
    applyEditorTheme(panel, edThemeId);

    const langSel = panel.querySelector("#cpos-ide-lang");
    LANGS.forEach(([id, label]) => { const o = document.createElement("option"); o.value = id; o.textContent = label; langSel.appendChild(o); });
    langSel.value = lang;
    const themeSel = panel.querySelector("#cpos-ide-theme");
    EDITOR_THEME_IDS.forEach((id) => { const o = document.createElement("option"); o.value = id; o.textContent = EDITOR_THEMES[id].name; themeSel.appendChild(o); });
    themeSel.value = edThemeId;

    msgEl = panel.querySelector(".msg");
    consoleEl = panel.querySelector("#cpos-ide-console");
    conBodyEl = panel.querySelector("#cpos-ide-console-body");
    statusEl = panel.querySelector("#cpos-ide-pos");
    findBar = panel.querySelector("#cpos-ide-findbar");
    const langTag = panel.querySelector("#cpos-ide-langtag");

    // Restore the persisted console height, re-clamped to the current viewport.
    const savedConH = conf[CONSOLE_H_KEY];
    if (savedConH) conBodyEl.style.maxHeight = Math.max(120, Math.min(savedConH, Math.round(window.innerHeight * 0.7))) + "px";

    const initial = conf[codeKey()] != null ? conf[codeKey()] : (templates[lang] || STARTERS[lang] || "");
    let saveTimer = null;
    editor = mountEditor(
      panel.querySelector("#cpos-ide-mount"),
      initial,
      lang,
      (v) => { clearTimeout(saveTimer); saveTimer = setTimeout(() => sset({ [codeKey()]: v }), 250); if (findBar && !findBar.hidden) refreshFind(); },
      (ln, col) => { statusEl.textContent = "Ln " + ln + ", Col " + col; }
    );
    editor.setFontSize(fontSize);
    editor.setWrap(wrapOn);
    panel.querySelector("#cpos-ide-wrap").classList.toggle("active", wrapOn);

    let curFont = fontSize;

    langSel.onchange = async () => {
      editor.setLang(langSel.value);
      langTag.textContent = langSel.value;
      await sset({ "cpos.ide.lang": langSel.value });
      const starter = templates[langSel.value] || STARTERS[langSel.value] || "";
      if (!editor.getValue().trim() && starter) { editor.setValue(starter); await sset({ [codeKey()]: editor.getValue() }); }
    };
    themeSel.onchange = async () => { applyEditorTheme(panel, themeSel.value); await sset({ "cpos.ide.theme": themeSel.value }); };

    launch.onclick = () => openPanel(width);
    panel.querySelector(".x").onclick = closePanel;
    panel.querySelector("#cpos-ide-reset").onclick = async () => {
      editor.setValue(templates[langSel.value] || STARTERS[langSel.value] || "");
      await sset({ [codeKey()]: editor.getValue() });
      setMsg("Reset to starter.");
    };
    panel.querySelector("#cpos-ide-copy").onclick = async () => { try { await navigator.clipboard.writeText(editor.getValue()); setMsg("Copied."); } catch { setMsg("Copy failed."); } };
    panel.querySelector("#cpos-ide-run").onclick = runSamples;
    panel.querySelector("#cpos-ide-submit").onclick = submit;
    panel.querySelector("#cpos-ide-custom").onclick = toggleCustom;
    panel.querySelector("#cpos-con-collapse").onclick = collapseConsole;
    panel.querySelector("#cpos-con-close").onclick = closeConsole;
    panel.querySelector("#cpos-con-jump").onclick = () => jumpToFailure(true);
    setupConsoleResize(panel.querySelector(".cpos-con-grip"));

    // Font size controls.
    async function setFont(px) { curFont = Math.max(10, Math.min(px, 24)); editor.setFontSize(curFont); await sset({ [FONT_KEY]: curFont }); setMsg("Font " + curFont + "px"); }
    panel.querySelector("#cpos-ide-fup").onclick = () => setFont(curFont + 1);
    panel.querySelector("#cpos-ide-fdown").onclick = () => setFont(curFont - 1);

    // Line wrap toggle.
    panel.querySelector("#cpos-ide-wrap").onclick = async (e) => {
      const on = !e.currentTarget.classList.contains("active");
      e.currentTarget.classList.toggle("active", on);
      editor.setWrap(on);
      await sset({ [WRAP_KEY]: on });
    };

    // Maximize / Zen toggle (does not touch persisted width).
    panel.querySelector("#cpos-ide-zen").onclick = (e) => {
      const on = panel.classList.toggle("zen");
      e.currentTarget.classList.toggle("active", on);
      if (panel.classList.contains("open")) pushPage(on ? 0 : (parseInt(panel.style.width, 10) || width));
      editor.focus();
    };

    // Find & replace wiring.
    setupFind();

    // Run/submit shortcuts on capture phase. CodeMirror's defaultKeymap binds
    // Mod-Enter -> insertBlankLine, so a normal bubble listener would fire AFTER
    // CM and we'd both run AND insert a line. Capturing + stopPropagation wins.
    panel.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        const t = e.target;
        if (t && t.closest && t.closest(".cpos-ide-find")) return; // leave the find box alone
        e.preventDefault(); e.stopPropagation();
        if (e.shiftKey) submit();
        else if (runController) cancelRun();
        else if (t && t.closest && t.closest(".cpos-con-custom")) runCustom(); // run the custom stdin you're editing
        else runSamples();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        // Code already autosaves; just swallow the browser Save dialog.
        e.preventDefault(); e.stopPropagation(); setMsg("Saved.");
      }
    }, true);

    // Keyboard: Ctrl/Cmd+F opens find; Esc backs out one layer at a time:
    // find -> running run -> expanded console -> collapsed console -> zen.
    panel.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) { e.preventDefault(); openFind(); return; }
      if (e.key !== "Escape") return;
      if (!findBar.hidden) { closeFind(); }
      else if (runController) { cancelRun(); }
      else if (!consoleEl.hidden && !consoleEl.classList.contains("collapsed")) { collapseConsole(); }
      else if (!consoleEl.hidden) { closeConsole(); }
      else if (panel.classList.contains("zen")) { panel.classList.remove("zen"); panel.querySelector("#cpos-ide-zen").classList.remove("active"); if (panel.classList.contains("open")) pushPage(parseInt(panel.style.width, 10) || width); }
    });

    setupResize(panel.querySelector(".cpos-ide-grip"));
  }

  function setMsg(m) { if (msgEl) msgEl.textContent = m; }

  // ---- find & replace -----------------------------------------------------
  let findMatches = [], findIdx = -1;
  function findInputs() {
    return {
      q: panel.querySelector("#cpos-find-q"),
      r: panel.querySelector("#cpos-find-r"),
      count: panel.querySelector("#cpos-find-count")
    };
  }
  function computeMatches(query) {
    findMatches = [];
    if (!query) { findIdx = -1; return; }
    const hay = editor.getValue();
    let from = 0, i;
    while ((i = hay.indexOf(query, from)) !== -1) { findMatches.push(i); from = i + Math.max(1, query.length); }
  }
  function refreshFind() {
    const { q, count } = findInputs();
    const query = q.value;
    computeMatches(query);
    if (findIdx >= findMatches.length) findIdx = findMatches.length - 1;
    count.textContent = findMatches.length ? (findIdx + 1) + "/" + findMatches.length : (query ? "0/0" : "0/0");
  }
  function gotoMatch(dir) {
    const { q, count } = findInputs();
    if (!q.value) return;
    computeMatches(q.value);
    if (!findMatches.length) { findIdx = -1; count.textContent = "0/0"; return; }
    if (findIdx < 0) findIdx = 0;
    else findIdx = (findIdx + dir + findMatches.length) % findMatches.length;
    const pos = findMatches[findIdx];
    editor.select(pos, pos + q.value.length);
    count.textContent = (findIdx + 1) + "/" + findMatches.length;
  }
  function openFind() {
    findBar.hidden = false;
    const { q } = findInputs();
    const sel = editor.selectedText();
    if (sel && !sel.includes("\n")) q.value = sel;
    q.focus(); q.select();
    findIdx = -1;
    refreshFind();
    if (findMatches.length) gotoMatch(1);
  }
  function closeFind() { findBar.hidden = true; editor.focus(); }
  function setupFind() {
    const { q, r } = findInputs();
    panel.querySelector("#cpos-ide-find").onclick = openFind;
    panel.querySelector("#cpos-find-x").onclick = closeFind;
    panel.querySelector("#cpos-find-next").onclick = () => gotoMatch(1);
    panel.querySelector("#cpos-find-prev").onclick = () => gotoMatch(-1);
    panel.querySelector("#cpos-find-rep").onclick = replaceCurrent;
    panel.querySelector("#cpos-find-repall").onclick = replaceAll;
    q.addEventListener("input", () => { findIdx = -1; refreshFind(); if (findMatches.length) gotoMatch(1); });
    q.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); }
    });
    r.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); replaceCurrent(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); }
    });
  }
  function replaceCurrent() {
    const { q, r } = findInputs();
    if (!q.value || findIdx < 0 || findIdx >= findMatches.length) { gotoMatch(1); return; }
    const pos = findMatches[findIdx];
    editor.replaceRange(pos, pos + q.value.length, r.value, pos + r.value.length);
    refreshFind();
    gotoMatch(1);
  }
  function replaceAll() {
    const { q, r } = findInputs();
    if (!q.value) return;
    const before = editor.getValue();
    const after = before.split(q.value).join(r.value);
    if (after !== before) {
      const n = before.split(q.value).length - 1;
      editor.setValue(after);
      sset({ [codeKey()]: after });
      setMsg("Replaced " + n + " occurrence(s).");
    }
    refreshFind();
  }

  // ---- open/close + push the page so it never overlaps --------------------
  function pushPage(px) {
    const html = document.documentElement;
    html.style.transition = "margin-right 0.18s ease";
    html.style.marginRight = px ? px + "px" : "";
    html.style.overflowX = px ? "hidden" : "";
  }
  function openPanel(width) {
    panel.classList.add("open");
    pushPage(panel.classList.contains("zen") ? 0 : (parseInt(panel.style.width, 10) || width || 640));
    editor.focus();
  }
  function closePanel() {
    panel.classList.remove("open");
    pushPage(0);
  }

  function setupResize(grip) {
    let dragging = false;
    grip.addEventListener("mousedown", (e) => {
      if (panel.classList.contains("zen")) return;
      dragging = true; e.preventDefault();
      panel.style.transition = "none";
      document.documentElement.style.transition = "none";
      document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const w = Math.max(360, Math.min(window.innerWidth - e.clientX, Math.round(window.innerWidth * 0.85)));
      panel.style.width = w + "px";
      if (panel.classList.contains("open")) document.documentElement.style.marginRight = w + "px";
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      panel.style.transition = "";
      document.body.style.userSelect = "";
      sset({ "cpos.ide.width": parseInt(panel.style.width, 10) || 640 });
    });
  }

  // ---- console state: open / collapse / close -----------------------------
  function setConLabel(text) {
    const el = panel && panel.querySelector("#cpos-con-label");
    if (el) el.textContent = text;
  }
  function setCollapseGlyph(collapsed) {
    const c = panel && panel.querySelector("#cpos-con-collapse");
    if (!c) return;
    c.textContent = collapsed ? "▸" : "▾";
    c.title = collapsed ? "Expand results" : "Collapse results";
    c.setAttribute("aria-label", collapsed ? "Expand results" : "Collapse results");
  }
  function openConsole() {
    consoleEl.hidden = false;
    consoleEl.classList.remove("collapsed");
    setCollapseGlyph(false);
  }
  function collapseConsole() {
    const collapsed = consoleEl.classList.toggle("collapsed");
    setCollapseGlyph(collapsed);
  }
  function closeConsole() {
    if (runController) cancelRun();
    consoleEl.hidden = true;
    consoleEl.classList.remove("collapsed");
    conBodyEl.innerHTML = "";
    customWrap = null;
    setRunning(false);
    if (editor) editor.focus();
  }

  // ---- run state: spinner / cancel ----------------------------------------
  function setRunning(on, n) {
    if (consoleEl) {
      consoleEl.classList.toggle("running", !!on);
      consoleEl.setAttribute("aria-busy", on ? "true" : "false");
    }
    const btn = panel && panel.querySelector("#cpos-ide-run");
    if (!btn) return;
    btn.classList.toggle("running", !!on);
    btn.textContent = on ? "◼ Stop" : "▷ Run";
    btn.title = on ? "Cancel the running tests (Esc)" : "Run against sample tests (Ctrl/Cmd+Enter)";
    if (on && n != null) setConLabel("Running " + n + " sample" + (n === 1 ? "" : "s") + "…");
  }
  function cancelRun() {
    if (runController) { try { runController.abort(); } catch (_) { /* noop */ } }
  }
  function loadingHtml(n) {
    return '<div class="cpos-con-loading">' +
      '<div class="smeter indeterminate"><i></i></div>' +
      "<span>Compiling &amp; running " + n + " sample" + (n === 1 ? "" : "s") + " locally…</span>" +
      "</div>";
  }

  function setupConsoleResize(grip) {
    let dragging = false, startY = 0, startH = 0;
    grip.addEventListener("mousedown", (e) => {
      dragging = true; e.preventDefault();
      startY = e.clientY;
      startH = conBodyEl.getBoundingClientRect().height;
      conBodyEl.style.transition = "none";
      document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const h = Math.max(120, Math.min(startH + (startY - e.clientY), Math.round(window.innerHeight * 0.7)));
      conBodyEl.style.maxHeight = h + "px";
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      conBodyEl.style.transition = "";
      document.body.style.userSelect = "";
      const h = parseInt(conBodyEl.style.maxHeight, 10);
      if (h) sset({ [CONSOLE_H_KEY]: h });
    });
    grip.addEventListener("dblclick", () => { conBodyEl.style.maxHeight = ""; sdel(CONSOLE_H_KEY); });
  }

  // ---- custom stdin test --------------------------------------------------
  function toggleCustom() {
    if (customWrap && customWrap.isConnected) { customWrap.remove(); customWrap = null; return; }
    openConsole();
    setConLabel("Custom test");
    customWrap = document.createElement("div");
    customWrap.className = "cpos-con-custom";
    customWrap.innerHTML =
      '<div class="cpos-con-customhead"><b>Custom test</b>' +
        '<span class="grow"></span>' +
        '<button id="cpos-custom-run" title="Run against this stdin">▷ Run custom</button>' +
      "</div>" +
      '<label>stdin</label><textarea id="cpos-custom-in" spellcheck="false" placeholder="Type input here…"></textarea>' +
      '<label>expected (optional)</label><textarea id="cpos-custom-exp" spellcheck="false" placeholder="Leave blank to just see output"></textarea>' +
      '<div id="cpos-custom-out"></div>';
    conBodyEl.prepend(customWrap);
    customWrap.querySelector("#cpos-custom-run").onclick = runCustom;
    customWrap.querySelector("#cpos-custom-in").focus();
  }

  async function runCustom() {
    if (runController) { cancelRun(); return; }
    const input = customWrap.querySelector("#cpos-custom-in").value;
    const expRaw = customWrap.querySelector("#cpos-custom-exp").value;
    const expected = expRaw.trim();
    const out = customWrap.querySelector("#cpos-custom-out");
    out.innerHTML = loadingHtml(1);
    const test = { input };
    if (expected) test.expected = expected;
    setRunning(true, 1);
    let data;
    try { data = await callRunner([test]); }
    finally { setRunning(false); }
    // The custom panel may have been removed (console closed / panel torn down)
    // while the fetch was in flight — out would be detached; don't write to it.
    if (!out.isConnected) return;
    if (data === "aborted") { out.innerHTML = '<div class="cpos-con-empty">Run cancelled.</div>'; return; }
    if (data === null) { out.innerHTML = runnerDownHtml(); return; }
    const r = (data.results || [])[0] || {};
    out.innerHTML = renderTestCard(r, 0, { custom: true, hasExpected: !!expected });
  }

  // ---- run against samples via the local CPOS runner ----------------------
  function showConsole(html) {
    openConsole();
    // Preserve a mounted custom-test panel above the results.
    if (customWrap && customWrap.isConnected) {
      [...conBodyEl.children].forEach((c) => { if (c !== customWrap) c.remove(); });
      const holder = document.createElement("div");
      holder.innerHTML = html;
      conBodyEl.append(...holder.childNodes);
    } else {
      conBodyEl.innerHTML = html;
    }
  }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  // Set when a CPOS runner answered but doesn't have the /run endpoint yet
  // (older VS Code extension / terminal app) — distinct from "not running".
  let runnerStale = false;

  function runnerDownHtml() {
    if (runnerStale) {
      return '<div class="cpos-con-empty">Your CPOS is running but is too old to run code.<br>' +
        "Update the <b>CPOS VS Code extension</b> (0.3.31+) or the <b>CPOS terminal app</b> to enable Run.<br>" +
        '<span class="cpos-dim">(Capture and submit still work on the older version.)</span></div>';
    }
    return '<div class="cpos-con-empty">Couldn\'t reach the CPOS runner.<br>' +
      "Open <b>VS Code</b> with the CPOS extension or start the <b>CPOS terminal app</b> so it can compile & run locally.<br>" +
      '<span class="cpos-dim">(Browsers can\'t execute C++/Java directly — running uses your local compiler.)</span></div>';
  }

  async function callRunner(tests) {
    const payload = { code: editor.getValue(), language: panel.querySelector("#cpos-ide-lang").value, tests };
    runnerStale = false;
    runController = new AbortController();
    const signal = runController.signal;
    try {
      for (const base of RUNNERS) {
        if (signal.aborted) return "aborted";
        try {
          const res = await fetch(base + "/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal });
          if (res.ok) return await res.json();
          // Reached a CPOS server, but it doesn't serve /run (older version).
          runnerStale = true;
        } catch (e) {
          if (e && e.name === "AbortError") return "aborted";
          /* connection refused — try the next port */
        }
      }
      return null;
    } finally {
      runController = null;
    }
  }

  async function runSamples() {
    if (runController) { cancelRun(); return; }
    const tests = scrapeSamples();
    if (!tests.length) { showConsole('<div class="cpos-con-empty">No sample tests found on this page.</div>'); setConLabel("No samples"); return; }
    showConsole(loadingHtml(tests.length));
    setRunning(true, tests.length);
    let data;
    try { data = await callRunner(tests); }
    finally { setRunning(false); }
    if (data === "aborted") {
      if (consoleEl && !consoleEl.hidden) { showConsole('<div class="cpos-con-empty">Run cancelled.</div>'); setConLabel("Cancelled"); }
      return;
    }
    // The panel may have been closed (consoleEl.hidden) or torn down (null) while
    // the fetch was in flight — never resurrect a dismissed/destroyed console.
    if (!consoleEl || consoleEl.hidden) return;
    if (data === null) { showConsole(runnerDownHtml()); setConLabel("Runner offline"); return; }
    renderRunResults(data, tests);
  }

  // Normalise a verdict: trust explicit verdict, else derive from pass/output.
  function verdictOf(r) {
    if (r.verdict) return String(r.verdict).toUpperCase();
    if (r.passed === true) return "AC";
    if (r.tle || r.timedOut) return "TLE";
    if (r.error || r.stderr) return "RE";
    return "WA";
  }
  function verdictClass(v) {
    if (v === "AC" || v === "OK") return "ok";
    if (v === "TLE") return "tle";
    if (v === "RE" || v === "MLE" || v === "CE" || v === "ERR") return "err";
    return "bad";
  }
  function meta(r) {
    const bits = [];
    const t = r.timeMs != null ? r.timeMs : (r.time != null ? r.time : null);
    if (t != null) bits.push(t + " ms");
    const mem = r.memoryKb != null ? (Math.round(r.memoryKb / 1024) + " MB") : (r.memory != null ? r.memory : null);
    if (mem != null) bits.push(mem);
    return bits.length ? " · " + bits.join(" · ") : "";
  }

  // Line-level diff between got and expected, marking the first differing token.
  function diffBlock(got, exp) {
    const g = String(got == null ? "" : got).replace(/\s+$/g, "");
    const e = String(exp == null ? "" : exp).replace(/\s+$/g, "");
    const gl = g.split("\n"), el = e.split("\n");
    const n = Math.max(gl.length, el.length);
    let gotHtml = "", expHtml = "";
    for (let i = 0; i < n; i++) {
      const a = gl[i], b = el[i];
      const same = a === b;
      const cls = same ? "" : ' class="dl"';
      if (a != null) gotHtml += "<span" + cls + ">" + esc(a) + "</span>\n";
      else gotHtml += '<span class="dl dm">(missing line)</span>\n';
      if (b != null) expHtml += "<span" + cls + ">" + esc(b) + "</span>\n";
      else expHtml += '<span class="dl dm">(extra line)</span>\n';
    }
    return { gotHtml, expHtml };
  }

  function renderTestCard(r, i, opts) {
    opts = opts || {};
    const v = verdictOf(r);
    const cls = verdictClass(v);
    const got = r.actual != null ? r.actual : (r.stdout != null ? r.stdout : (r.output != null ? r.output : ""));
    const exp = r.expected != null ? r.expected : "";
    const showDiff = (cls === "bad") && (opts.hasExpected !== false) && (exp !== "" || got !== "");
    const title = opts.custom ? "Custom" : "Test " + (i + 1);
    let body = "";
    if (cls === "ok") {
      // On AC for custom runs we still show the produced output.
      if (opts.custom) body = '<div class="cpos-con-io"><label>output</label><pre>' + esc(got) + "</pre></div>";
    } else if (showDiff) {
      const d = diffBlock(got, exp);
      body =
        '<div class="cpos-con-diff">' +
          '<div class="cpos-con-io"><label>got</label><pre>' + d.gotHtml + "</pre></div>" +
          '<div class="cpos-con-io"><label>expected</label><pre>' + d.expHtml + "</pre></div>" +
        "</div>";
    } else {
      body = '<div class="cpos-con-io"><label>output</label><pre>' + esc(got) + "</pre></div>";
    }
    if (r.stderr) body += '<div class="cpos-con-io"><label>stderr</label><pre>' + esc(r.stderr) + "</pre></div>";
    if (opts.input != null) body = '<div class="cpos-con-io"><label>input</label><pre>' + esc(opts.input) + "</pre></div>" + body;
    // AC samples collapse to a quiet one-line summary; failures (and custom
    // runs) open so the diff/output is on screen with no extra clicks.
    const open = cls !== "ok" || !!opts.custom;
    const m = meta(r).replace(/^ · /, "");
    const inner = body ? '<div class="cpos-con-cardbody">' + body + "</div>" : "";
    return (
      '<details class="cpos-con-test ' + cls + '"' + (open ? " open" : "") + ">" +
        '<summary class="cpos-con-head"><b>' + esc(title) + '</b><span class="grow"></span>' +
          '<span class="vd vp">' + esc(v) + "</span>" + (m ? '<span class="vm">' + m + "</span>" : "") +
        "</summary>" +
        inner +
      "</details>"
    );
  }

  function renderRunResults(data, tests) {
    lastRunData = data;
    const results = (data && data.results) || [];
    if (!results.length) { showConsole('<div class="cpos-con-empty">Runner returned no results.</div>'); setConLabel("No results"); return; }

    // Compile error: the runner copies the same message into every test. Show
    // it once as a banner instead of N identical failing cards.
    if (results.length > 1 && results.every((r) => verdictOf(r) === "CE")) {
      const msg = results[0].actual || results[0].stderr || results[0].error || "Compilation error.";
      showConsole(
        '<div class="cpos-con-summary bad"><div class="sline"><span class="sv">✗ Compilation error</span></div></div>' +
        '<div class="cpos-con-ce">' + esc(msg) + "</div>"
      );
      setConLabel("Compilation error");
      updateJumpVisibility();
      return;
    }

    const cards = results.map((r, i) => renderTestCard(r, i, { input: tests && tests[i] ? tests[i].input : null, hasExpected: true })).join("");
    const passed = results.filter((r) => verdictClass(verdictOf(r)) === "ok").length;
    const allOk = passed === results.length;
    const pct = Math.round((passed / results.length) * 100);
    const verdictText = allOk ? "Accepted" : passed + " of " + results.length + " passed";
    const summary =
      '<div class="cpos-con-summary ' + (allOk ? "ok" : "bad") + '">' +
        '<div class="sline">' +
          '<span class="sv">' + (allOk ? "✓ Accepted" : "✗ " + verdictText) + "</span>" +
          '<span class="grow"></span>' +
          '<button class="cpos-con-copy" id="cpos-con-copy" title="Copy a result summary to the clipboard">Copy result</button>' +
          '<span class="sc">' + passed + " / " + results.length + "</span>" +
        "</div>" +
        '<div class="smeter"><i style="width:0"></i></div>' +
      "</div>";
    showConsole(summary + cards);
    setConLabel(verdictText);
    // Animate the pass-ratio meter on the next frame (instant under reduced-motion).
    const meter = conBodyEl.querySelector(".cpos-con-summary .smeter i");
    if (meter) requestAnimationFrame(() => { meter.style.width = pct + "%"; });
    const copyBtn = conBodyEl.querySelector("#cpos-con-copy");
    if (copyBtn) copyBtn.onclick = () => copyResult(results, passed, tests);
    updateJumpVisibility();
    jumpToFailure(false);
  }

  function updateJumpVisibility() {
    const jump = panel && panel.querySelector("#cpos-con-jump");
    if (!jump || !conBodyEl) return;
    jump.hidden = !conBodyEl.querySelector(".cpos-con-test:not(.ok)");
  }
  function jumpToFailure(flash) {
    if (!conBodyEl) return;
    const el = conBodyEl.querySelector(".cpos-con-test:not(.ok)");
    if (!el) return;
    if (el.tagName === "DETAILS") el.open = true;
    el.scrollIntoView({ block: "nearest" });
    if (flash) {
      el.classList.remove("flash");
      void el.offsetWidth; // reflow so the animation restarts
      el.classList.add("flash");
    }
  }

  async function copyResult(results, passed, tests) {
    const lang = panel.querySelector("#cpos-ide-lang").value;
    const lines = [problemLabel() + " — " + lang, passed + "/" + results.length + " passed"];
    const firstFail = results.findIndex((r) => verdictClass(verdictOf(r)) !== "ok");
    if (firstFail !== -1) {
      const r = results[firstFail];
      const got = r.actual != null ? r.actual : (r.stdout != null ? r.stdout : (r.output != null ? r.output : ""));
      lines.push("", "First failure — Test " + (firstFail + 1) + " (" + verdictOf(r) + ")");
      const input = tests && tests[firstFail] ? tests[firstFail].input : null;
      if (input != null) lines.push("input:", String(input));
      lines.push("got:", String(got));
      if (r.expected != null && r.expected !== "") lines.push("expected:", String(r.expected));
    }
    try { await navigator.clipboard.writeText(lines.join("\n")); setMsg("Result copied."); }
    catch { setMsg("Copy failed."); }
  }

  // ---- submit (reuses existing background injector) -----------------------
  async function submit() {
    const code = editor.getValue();
    const lang = panel.querySelector("#cpos-ide-lang").value;
    if (!code.trim()) { setMsg("Editor is empty."); return; }
    if (!isCf) {
      try { await navigator.clipboard.writeText(code); } catch { /* ignore */ }
      setMsg("Code copied — opening CSES submit…");
      setTimeout(() => { window.location.href = ctx ? ctx.submitUrl : "/problemset"; }, 350);
      return;
    }
    if (!ctx) { setMsg("Could not detect the problem."); return; }
    await sset({
      [SUBMIT_KEY]: {
        key: problemKey(), contest: ctx.contest, index: ctx.index,
        submitByIndex: ctx.kind === "contest" || ctx.kind === "gym",
        problemCode: ctx.contest + ctx.index, code, language: lang, ts: Date.now()
      }
    });
    setMsg("Opening submit page…");
    setTimeout(() => { window.location.href = ctx.submitUrl; }, 250);
  }

  async function maybeCompleteSubmit() {
    const raw = await sget([SUBMIT_KEY]);
    const pending = raw[SUBMIT_KEY];
    if (!pending || Date.now() - pending.ts > 60000) return;
    if (!/\/submit/.test(location.pathname)) return;
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: "cpos-cf-submit", code: pending.code, language: pending.language,
        problemIndex: pending.submitByIndex ? pending.index : null,
        submitByIndex: pending.submitByIndex, problemCode: pending.submitByIndex ? null : pending.problemCode
      }, () => void chrome.runtime.lastError);
    }, 600);
    await sdel(SUBMIT_KEY);
  }

  // ---- lifecycle ----------------------------------------------------------
  function teardown() {
    pushPage(0);
    cancelRun();
    try { editor?.destroy?.(); } catch {}
    document.getElementById("cpos-ide-panel")?.remove();
    document.getElementById("cpos-ide-launch")?.remove();
    panel = editor = msgEl = launch = consoleEl = conBodyEl = statusEl = findBar = customWrap = null;
  }
  async function sync() {
    if (!C) return;
    const on = await C.feature("ide");
    if (on && onProblemPage) buildPanel().catch((e) => console.debug("CPOS ide:", e));
    else teardown();
  }

  if (C) {
    C.onChange((changes) => {
      const repaint = () => {
        if (panel) applyChrome(panel);
        if (launch) applyChrome(launch);
      };
      if (changes[C.KEYS.FEATURES]) sync().then(repaint);
      else repaint();
    });
  }
  if (onSubmitPage) maybeCompleteSubmit();
  if (onProblemPage) sync();
})();
