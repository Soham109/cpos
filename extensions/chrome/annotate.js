// CPOS marker-pen + notes — a lightweight text markup-highlighter for supported
// problem/blog pages (Codeforces problem pages, CF blog entries, CSES task pages). The
// user selects text and applies one of a few marker colours; clicking an
// existing highlight lets them recolour it, remove it, or attach a short note
// (shown as a tooltip; a small dot marks notes). Highlights persist per-problem
// in chrome.storage.local keyed by URL path and are re-anchored on reload using
// character offsets within a stable container (tolerant: a mark that can't be
// resolved is skipped, never throws). The markable text scope is page-wide, but
// form controls and CPOS's own UI are ignored.
//
// This is the highlight ENGINE only — it has no toolbar of its own. The single
// "Marker" tool inside the unified draw launcher (draw.js) drives it through
// self.CPOS_ANNOTATE. Gated on feature "draw" so it mounts/teardowns alongside
// the pen. Additive only — never touches capture/submit, never breaks selection.
(function () {
  const C = self.CPOS;
  const T = self.CPOS_THEMES;
  if (!C || !T) return;

  const MARK_CLASS = "cpos-annotate";
  const NOTE_FLAG = "cpos-annotate-hasnote";
  const BAR_ID = "cpos-annotate-bar";
  const POP_ID = "cpos-annotate-pop";
  const TIP_ID = "cpos-annotate-tip";
  const STORE_PREFIX = "cpos.annotate.page.";

  // Marker colours — the SAME five theme tokens the pen uses (draw.js), drawn as
  // a translucent highlight so underlying text stays readable. Each slot names a
  // theme token; the concrete fill is resolved from the active theme at paint /
  // swatch-render time. Keeping these in lockstep with the pen means one coherent
  // palette across both tools instead of a separate hardcoded rainbow.
  const COLORS = [
    { id: "ink", token: "--fg" },  // foreground highlight
    { id: "r", token: "--bad" },   // red
    { id: "b", token: "--cf" },    // blue
    { id: "g", token: "--ok" },    // green
    { id: "y", token: "--warn" }   // amber
  ];
  const colorById = (id) => COLORS.find((c) => c.id === id) || COLORS[0];
  // Resolve a colour slot to a translucent highlight fill from the active theme.
  // ~32% alpha keeps text legible; falls back to a neutral tint pre-theme.
  function colorFill(c) {
    const hex = (theme && theme[c.token]) || "#8a86a3";
    return "color-mix(in srgb, " + hex + " 32%, transparent)";
  }

  // ---- page scope ---------------------------------------------------------
  // Only build on supported page kinds. Offsets are anchored against the whole
  // document body so marker highlights are not trapped inside the problem area.
  function pageScope() {
    const host = location.hostname;
    const path = location.pathname;
    if (host.endsWith("codeforces.com")) {
      if (/\/problem\//.test(path)) {
        return { kind: "cf-problem", container: document.body };
      }
      if (/\/blog\/entry\//.test(path)) {
        return { kind: "cf-blog", container: document.body };
      }
    }
    if (host.endsWith("cses.fi") && /\/problemset\/task\//.test(path)) {
      return { kind: "cses-task", container: document.body };
    }
    return null;
  }

  let scope = null;
  let theme = null;
  let marks = [];        // [{ id, color, note, start, end }]
  let nextId = 1;
  let built = false;
  let lastRange = null;

  function storeKey() {
    return STORE_PREFIX + location.hostname + location.pathname;
  }

  // ---- storage ------------------------------------------------------------
  function loadMarks() {
    return new Promise((res) => {
      try {
        chrome.storage.local.get([storeKey()], (v) => {
          const arr = (v && v[storeKey()]) || [];
          res(Array.isArray(arr) ? arr : []);
        });
      } catch (e) { res([]); }
    });
  }
  function saveMarks() {
    try {
      const data = marks.map((m) => ({ id: m.id, color: m.color, note: m.note || "", start: m.start, end: m.end }));
      chrome.storage.local.set({ [storeKey()]: data });
    } catch (e) { /* ignore */ }
  }

  // ---- offset <-> DOM mapping --------------------------------------------
  // We measure character offsets over the visible page text by walking text
  // nodes in document order, skipping our own toolbar/popover, form controls,
  // and non-content elements. This is tolerant: minor DOM changes shift offsets
  // a little, and unresolved ranges are simply skipped.
  function isSkippable(node) {
    let el = node.parentElement;
    while (el) {
      if (el.id === BAR_ID || el.id === POP_ID || el.id === TIP_ID ||
          el.id === "cpos-draw-bar" || el.id === "cpos-draw-layer") return true;
      if (el.id && el.id.startsWith("cpos-")) return true;
      const tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" ||
          tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" ||
          tag === "OPTION" || tag === "BUTTON") return true;
      if (el.isContentEditable) return true;
      el = el.parentElement;
    }
    return false;
  }

  function textNodes() {
    const out = [];
    if (!scope || !scope.container) return out;
    const walker = document.createTreeWalker(scope.container, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        if (isSkippable(n)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  // Map a [start,end) char offset to a DOM Range over container text nodes.
  function offsetsToRange(start, end) {
    if (end <= start) return null;
    const nodes = textNodes();
    let pos = 0, range = null, startNode = null, startOff = 0;
    for (const node of nodes) {
      const len = node.nodeValue.length;
      const nodeStart = pos, nodeEnd = pos + len;
      if (startNode === null && start < nodeEnd) {
        startNode = node;
        startOff = start - nodeStart;
      }
      if (startNode !== null && end <= nodeEnd) {
        range = document.createRange();
        try {
          range.setStart(startNode, Math.max(0, startOff));
          range.setEnd(node, Math.max(0, end - nodeStart));
        } catch (e) { return null; }
        break;
      }
      pos = nodeEnd;
    }
    return range;
  }

  // Map a live selection Range to char offsets within the container. We measure
  // the length of the (skippable-filtered) text from the container start up to
  // each selection boundary by reusing the same text-node walk, so offsets are
  // consistent with offsetsToRange/paintMark. Boundaries that fall on element
  // nodes are resolved to the text length preceding the boundary's child index.
  function boundaryOffset(nodes, boundaryNode, boundaryOffset) {
    // Returns the cumulative skippable-filtered text length at the boundary, or
    // -1 if the boundary isn't covered by our walked text nodes.
    if (boundaryNode.nodeType === Node.TEXT_NODE) {
      let pos = 0;
      for (const node of nodes) {
        if (node === boundaryNode) return pos + Math.min(boundaryOffset, node.nodeValue.length);
        pos += node.nodeValue.length;
      }
      return -1;
    }
    // Element boundary: it sits before child at index `boundaryOffset`. Find the
    // first walked text node at/after that DOM point and return text length up to
    // it; if none, it's at the end → total length.
    const refNode = boundaryNode.childNodes[boundaryOffset] || null;
    let pos = 0;
    for (const node of nodes) {
      if (refNode && (node === refNode || refNode.contains(node) ||
          (node.compareDocumentPosition(refNode) & Node.DOCUMENT_POSITION_FOLLOWING))) {
        return pos;
      }
      pos += node.nodeValue.length;
    }
    return pos;
  }

  function rangeToOffsets(range) {
    if (!scope || !scope.container) return null;
    if (!scope.container.contains(range.commonAncestorContainer)) return null;
    const nodes = textNodes();
    const start = boundaryOffset(nodes, range.startContainer, range.startOffset);
    const end = boundaryOffset(nodes, range.endContainer, range.endOffset);
    if (start < 0 || end < 0 || end <= start) return null;
    return { start, end };
  }

  // ---- applying marks to the DOM -----------------------------------------
  // Wrap each text node that intersects [start,end) in a .cpos-annotate span.
  // Returns the list of created spans (so we can restyle / unwrap later).
  function paintMark(mark) {
    const nodes = textNodes();
    let pos = 0;
    const created = [];
    for (const node of nodes) {
      const len = node.nodeValue.length;
      const nodeStart = pos, nodeEnd = pos + len;
      pos = nodeEnd;
      if (nodeEnd <= mark.start || nodeStart >= mark.end) continue;
      const from = Math.max(0, mark.start - nodeStart);
      const to = Math.min(len, mark.end - nodeStart);
      if (to <= from) continue;
      let target = node;
      // Split so the span wraps exactly the intersecting slice.
      if (from > 0) target = target.splitText(from);
      if (to - from < target.nodeValue.length) target.splitText(to - from);
      const span = document.createElement("span");
      span.className = MARK_CLASS;
      span.setAttribute("data-cpos-an-id", String(mark.id));
      span.style.backgroundColor = colorFill(colorById(mark.color));
      if (mark.note) span.classList.add(NOTE_FLAG);
      target.parentNode.insertBefore(span, target);
      span.appendChild(target);
      created.push(span);
    }
    return created;
  }

  function spansFor(id) {
    return [...document.querySelectorAll('.' + MARK_CLASS + '[data-cpos-an-id="' + id + '"]')];
  }

  function unwrapSpan(span) {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  }

  function removeAllSpans() {
    [...document.querySelectorAll('.' + MARK_CLASS)].forEach(unwrapSpan);
  }

  // Re-anchor every stored mark. Painting one mark splits text nodes and shifts
  // later offsets, so we paint in descending start order to keep offsets valid.
  function repaintAll() {
    removeAllSpans();
    const ordered = [...marks].sort((a, b) => b.start - a.start);
    for (const m of ordered) {
      try { paintMark(m); } catch (e) { /* skip unresolved */ }
    }
  }

  // ---- theme --------------------------------------------------------------
  async function ensureTheme() {
    theme = T.get(await C.activeThemeId());
  }
  function applyThemeVars(el) {
    if (!el || !theme) return;
    el.style.setProperty("--cpos-an-bg", theme["--bg"]);
    el.style.setProperty("--cpos-an-panel", theme["--panel"]);
    el.style.setProperty("--cpos-an-fg", theme["--fg"]);
    el.style.setProperty("--cpos-an-dim", theme["--dim"]);
    el.style.setProperty("--cpos-an-border", theme["--border"]);
    el.style.setProperty("--cpos-an-accent", theme["--accent"]);
    el.style.setProperty("--cpos-an-bad", theme["--bad"]);
  }
  function restyle() {
    [BAR_ID, POP_ID, TIP_ID].forEach((id) => {
      const el = document.getElementById(id);
      if (el) applyThemeVars(el);
    });
    // note-dot colour rides on --cpos-an-accent set on the span's container; set
    // it on each span too for correctness when site-theme strips inheritance.
    document.querySelectorAll('.' + MARK_CLASS).forEach((s) => {
      if (theme) {
        s.style.setProperty("--cpos-an-accent", theme["--accent"]);
        s.style.setProperty("--cpos-an-bg", theme["--bg"]);
        // Highlight fills are theme-derived; refresh them so marks track the
        // active theme on a switch (the id rides on data-cpos-an-id).
        const id = parseInt(s.getAttribute("data-cpos-an-id"), 10);
        const mark = marks.find((m) => m.id === id);
        if (mark) s.style.backgroundColor = colorFill(colorById(mark.color));
      }
    });
  }

  // ---- selection state (the toolbar lives in the unified draw launcher) ----
  let activeColor = COLORS[0].id;

  // Is there something we could highlight right now — a live page selection, or
  // a remembered one from just before the user clicked the bar?
  function hasSelection() {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      if (scope && scope.container && scope.container.contains(range.commonAncestorContainer)) return true;
    }
    return !!lastRange;
  }

  // ---- create a highlight from the current selection ----------------------
  function applySelection() {
    const sel = window.getSelection();
    const range = sel && !sel.isCollapsed && sel.rangeCount > 0 ? sel.getRangeAt(0) : lastRange;
    if (!range) return;
    if (range.collapsed) return;
    const off = rangeToOffsets(range);
    if (!off) return;
    // Avoid duplicate exact overlaps: if a mark already covers this exact span,
    // just recolour it.
    const existing = marks.find((m) => m.start === off.start && m.end === off.end);
    if (existing) {
      existing.color = activeColor;
    } else {
      marks.push({ id: nextId++, color: activeColor, note: "", start: off.start, end: off.end });
    }
    sel.removeAllRanges();
    repaintAll();
    restyle();
    saveMarks();
  }

  function rememberSelection() {
    if (!built) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!scope || !scope.container || !scope.container.contains(range.commonAncestorContainer)) return;
    lastRange = range.cloneRange();
  }

  // ---- popover (recolour / note / remove) ---------------------------------
  let popMarkId = null;
  function closePopover() {
    document.getElementById(POP_ID)?.remove();
    popMarkId = null;
  }

  function openPopover(id, x, y) {
    closePopover();
    const mark = marks.find((m) => m.id === id);
    if (!mark) return;
    popMarkId = id;

    const pop = document.createElement("div");
    pop.id = POP_ID;

    // colour row
    const row = document.createElement("div");
    row.className = "cpos-an-row";
    COLORS.forEach((c) => {
      const sw = document.createElement("button");
      sw.className = "cpos-an-swatch";
      sw.type = "button";
      // !important so the fill survives the page-wide `button { background … }`
      // that Modernize / site themes inject (see annotate.css shield).
      sw.style.setProperty("background-color", colorFill(c), "important");
      sw.setAttribute("aria-pressed", c.id === mark.color ? "true" : "false");
      sw.addEventListener("click", () => {
        mark.color = c.id;
        row.querySelectorAll(".cpos-an-swatch").forEach((b) =>
          b.setAttribute("aria-pressed", b === sw ? "true" : "false"));
        repaintAll();
        restyle();
        saveMarks();
      });
      row.appendChild(sw);
    });
    pop.appendChild(row);

    // note textarea
    const ta = document.createElement("textarea");
    ta.placeholder = "Add a note…";
    ta.value = mark.note || "";
    pop.appendChild(ta);

    // actions
    const actions = document.createElement("div");
    actions.className = "cpos-an-actions";

    const del = document.createElement("button");
    del.className = "cpos-an-btn cpos-an-danger";
    del.type = "button";
    del.textContent = "Remove";
    del.addEventListener("click", () => {
      marks = marks.filter((m) => m.id !== id);
      closePopover();
      repaintAll();
      restyle();
      saveMarks();
    });

    const save = document.createElement("button");
    save.className = "cpos-an-btn cpos-an-primary";
    save.type = "button";
    save.textContent = "Save";
    save.addEventListener("click", () => {
      mark.note = ta.value.trim();
      spansFor(id).forEach((s) => s.classList.toggle(NOTE_FLAG, !!mark.note));
      closePopover();
      restyle();
      saveMarks();
    });

    actions.appendChild(del);
    actions.appendChild(save);
    pop.appendChild(actions);

    applyThemeVars(pop);
    document.body.appendChild(pop);

    // position within viewport
    const w = 240, h = pop.offsetHeight || 160;
    let px = Math.min(x, window.innerWidth - w - 12);
    let py = Math.min(y + 8, window.innerHeight - h - 12);
    px = Math.max(8, px); py = Math.max(8, py);
    pop.style.left = px + "px";
    pop.style.top = py + "px";
    ta.focus();
  }

  // ---- note tooltip on hover ----------------------------------------------
  function showTip(text, x, y) {
    hideTip();
    if (!text) return;
    const tip = document.createElement("div");
    tip.id = TIP_ID;
    tip.textContent = text;
    applyThemeVars(tip);
    document.body.appendChild(tip);
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let px = Math.min(x + 10, window.innerWidth - w - 10);
    let py = y - h - 10;
    if (py < 8) py = y + 16;
    tip.style.left = Math.max(8, px) + "px";
    tip.style.top = py + "px";
  }
  function hideTip() {
    document.getElementById(TIP_ID)?.remove();
  }

  // ---- delegated events ---------------------------------------------------
  function onClick(e) {
    const span = e.target.closest && e.target.closest('.' + MARK_CLASS);
    if (span) {
      e.preventDefault();
      e.stopPropagation();
      const id = parseInt(span.getAttribute("data-cpos-an-id"), 10);
      openPopover(id, e.clientX, e.clientY);
      return;
    }
    // click outside popover closes it
    if (popMarkId != null && !e.target.closest('#' + POP_ID)) closePopover();
  }
  function onMouseOver(e) {
    const span = e.target.closest && e.target.closest('.' + MARK_CLASS);
    if (!span) return;
    const id = parseInt(span.getAttribute("data-cpos-an-id"), 10);
    const mark = marks.find((m) => m.id === id);
    if (mark && mark.note) showTip(mark.note, e.clientX, e.clientY);
  }
  function onMouseOut(e) {
    const span = e.target.closest && e.target.closest('.' + MARK_CLASS);
    if (span) hideTip();
  }

  function bindEvents() {
    document.addEventListener("click", onClick, true);
    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("mouseout", onMouseOut, true);
    document.addEventListener("selectionchange", rememberSelection);
  }
  function unbindEvents() {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("mouseover", onMouseOver, true);
    document.removeEventListener("mouseout", onMouseOut, true);
    document.removeEventListener("selectionchange", rememberSelection);
  }

  // ---- build / teardown ---------------------------------------------------
  async function build() {
    if (built) return;
    scope = pageScope();
    if (!scope || !scope.container) return;
    built = true;
    await ensureTheme();
    const stored = await loadMarks();
    marks = stored.map((m) => ({ id: m.id, color: m.color || "y", note: m.note || "", start: m.start, end: m.end }));
    nextId = marks.reduce((mx, m) => Math.max(mx, m.id + 1), 1);
    bindEvents();
    repaintAll();
    restyle();
  }

  function teardown() {
    if (!built) return;
    built = false;
    closePopover();
    hideTip();
    unbindEvents();
    removeAllSpans();
    marks = [];
    lastRange = null;
  }

  // ---- public API (driven by the unified draw launcher) -------------------
  // The "Marker" tool in draw.js calls these; everything else stays private.
  self.CPOS_ANNOTATE = {
    COLORS,
    colorFill,                      // resolve a colour slot → translucent fill
    getActiveColor: () => activeColor,
    setActiveColor: (id) => { if (COLORS.some((c) => c.id === id)) activeColor = id; },
    applySelection,                 // highlight the current/remembered selection
    hasSelection,
    isReady: () => built            // engine mounted on this page?
  };

  // ---- lifecycle ----------------------------------------------------------
  // Gated on "draw" so the highlight engine mounts/teardowns together with the
  // pen — they share one launcher and one popup toggle now.
  async function sync() {
    const on = await C.feature("draw");
    if (on) await build();
    else teardown();
  }

  C.onChange((changes) => {
    if (changes[C.KEYS.FEATURES]) sync();
    else { ensureTheme().then(restyle); }
  });

  if (document.body) sync();
  else document.addEventListener("DOMContentLoaded", () => sync());
})();
