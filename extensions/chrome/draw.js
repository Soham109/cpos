// CPOS freehand drawing — a pen + marker you can scribble onto the whole
// supported page (Codeforces problem / CF blog / CSES task). The ink is painted
// on a page-sized <canvas>, so it scrolls WITH the document and stays glued to
// the spot you drew on. The canvas is pointer-events:none whenever no tool is
// armed, so links/buttons on the page stay fully clickable; arming a tool flips
// it to capture strokes.
//
// One floating launcher (#cpos-draw-bar, bottom-right) starts collapsed as a
// single pen icon; clicking it expands a tray with three tools: a freehand Pen,
// an Eraser, and a Marker that auto-highlights any text you SELECT in the
// page, in the current colour (driven by the annotate engine,
// self.CPOS_ANNOTATE). Strokes persist per-problem in
// chrome.storage.local keyed by URL path. Gated on feature "draw"; everything
// injected is removed when off. Additive only — never touches capture/submit.
(function () {
  const C = self.CPOS;
  const T = self.CPOS_THEMES;
  if (!C || !T) return;

  const LAYER_ID = "cpos-draw-layer";
  const BAR_ID = "cpos-draw-bar";
  const STORE_PREFIX = "cpos.draw.page.";
  const UI_STORE_KEY = "cpos.draw.ui";

  // Ink colours — flat, few, derived from the active theme so the default ink is
  // always legible (never near-black on a dark page) and the set tracks whatever
  // palette is on. Each slot names a theme token; the concrete hex is resolved
  // from the theme object at render/stroke time. The text marker (annotate.js)
  // uses these SAME five tokens, just translucent.
  const COLORS = [
    { id: "ink", token: "--fg" },  // default ink — the readable foreground colour
    { id: "r", token: "--bad" },   // red
    { id: "b", token: "--cf" },    // blue
    { id: "g", token: "--ok" },    // green
    { id: "y", token: "--warn" }   // amber
  ];
  const colorById = (id) => COLORS.find((c) => c.id === id) || COLORS[0];
  // Resolve a colour slot to a concrete hex from the active theme; fall back to a
  // mid-grey if the theme isn't loaded yet so a swatch is never invisible.
  const colorHex = (c) => (theme && theme[c.token]) || "#8a86a3";

  // Freehand pen nib. The "Marker" tool isn't a canvas nib — it highlights
  // selected page text through the annotate engine (self.CPOS_ANNOTATE).
  const TOOLS = { pen: { width: 3, alpha: 1 } };
  const ERASE_RADIUS = 14;

  // Inline 16px line-icons, same grid/stroke as the popup set for consistency.
  const ICONS = {
    pen: '<path d="m2.8 13.2 1-3.1 6.7-6.7a1.45 1.45 0 0 1 2.05 2.05L5.85 12.2 2.8 13.2Z"/><path d="m9.6 4.4 2 2"/>',
    marker: '<path d="M4 13.4h5.2"/><path d="M6.4 11.2 11 6.6l1.6 1.6-4.6 4.6H6.4v-1.6Z"/><path d="m10.4 7.2 1.3-1.3a1 1 0 0 1 1.4 0l.2.2a1 1 0 0 1 0 1.4l-1.3 1.3Z"/>',
    eraser: '<path d="m4.4 12.4 6.1-6.1a1.3 1.3 0 0 1 1.85 0l1.1 1.1a1.3 1.3 0 0 1 0 1.85l-4 4H6.4l-2-2Z"/><path d="M6.4 13.2h7"/>',
    undo: '<path d="M6.2 5.1H3.4V2.3"/><path d="M3.7 5.1a5 5 0 1 1-.2 5.5"/>',
    move: '<path d="M8 2.4v11.2"/><path d="m5.8 4.6 2.2-2.2 2.2 2.2"/><path d="m5.8 11.4 2.2 2.2 2.2-2.2"/><path d="M2.4 8h11.2"/><path d="m4.6 5.8-2.2 2.2 2.2 2.2"/><path d="m11.4 5.8 2.2 2.2-2.2 2.2"/>',
    done: '<path d="m3.4 8.4 3 3 6.2-7"/>'
  };
  function svg(name) {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + "</svg>";
  }

  // ---- page scope ---------------------------------------------------------
  // Mirror annotate.js: only build on supported problem/blog pages. The drawing
  // surface itself is page-wide, not scoped to the statement element.
  function pageScope() {
    const host = location.hostname;
    const path = location.pathname;
    if (host.endsWith("codeforces.com")) {
      if (/\/problem\//.test(path)) {
        return { container: document.body };
      }
      if (/\/blog\/entry\//.test(path)) {
        return { container: document.body };
      }
    }
    if (host.endsWith("cses.fi") && /\/problemset\/task\//.test(path)) {
      return { container: document.body };
    }
    return null;
  }

  let scope = null;
  let theme = null;
  let built = false;
  let strokes = [];        // [{ tool, color, size, points: [[x,y], ...] }]
  let activeTool = null;   // null = idle; "pen" | "marker" | "eraser"
  let activeColor = COLORS[0].id;
  let penSize = TOOLS.pen.width;
  let expanded = false;
  let drawing = false;
  let cur = null;          // stroke being drawn
  let canvas = null, ctx = null, bar = null, dpr = 1;
  let barPos = null;
  let suppressLaunchClick = false;
  let resizeObserver = null;

  function storeKey() {
    return STORE_PREFIX + location.hostname + location.pathname;
  }

  // ---- storage ------------------------------------------------------------
  function loadStrokes() {
    return new Promise((res) => {
      try {
        chrome.storage.local.get([storeKey()], (v) => {
          const arr = (v && v[storeKey()]) || [];
          res(Array.isArray(arr) ? arr : []);
        });
      } catch (e) { res([]); }
    });
  }
  function saveStrokes() {
    try {
      const data = strokes.map((s) => ({ tool: s.tool, color: s.color, size: s.size, points: s.points }));
      chrome.storage.local.set({ [storeKey()]: data });
    } catch (e) { /* ignore */ }
  }

  function loadUiPrefs() {
    return new Promise((res) => {
      try {
        chrome.storage.local.get([UI_STORE_KEY], (v) => {
          const pref = (v && v[UI_STORE_KEY]) || {};
          if (pref && Number.isFinite(pref.penSize)) penSize = clampPenSize(pref.penSize);
          if (pref && pref.bar &&
              (pref.bar.ax === "left" || pref.bar.ax === "right") &&
              (pref.bar.ay === "top" || pref.bar.ay === "bottom") &&
              Number.isFinite(pref.bar.dx) && Number.isFinite(pref.bar.dy)) {
            barPos = { ax: pref.bar.ax, ay: pref.bar.ay, dx: pref.bar.dx, dy: pref.bar.dy };
          }
          res();
        });
      } catch (e) { res(); }
    });
  }
  function saveUiPrefs() {
    try {
      chrome.storage.local.set({
        [UI_STORE_KEY]: {
          penSize,
          bar: barPos
        }
      });
    } catch (e) { /* ignore */ }
  }

  // ---- canvas geometry ----------------------------------------------------
  function pageSize() {
    const de = document.documentElement;
    const body = document.body;
    return {
      width: Math.max(1, window.innerWidth, de?.clientWidth || 0, de?.scrollWidth || 0, body?.scrollWidth || 0),
      height: Math.max(1, window.innerHeight, de?.clientHeight || 0, de?.scrollHeight || 0, body?.scrollHeight || 0)
    };
  }

  // Sit the canvas over the entire document. Stroke points are document px.
  function layoutCanvas() {
    if (!canvas) return;
    const { width: cssW, height: cssH } = pageSize();
    dpr = window.devicePixelRatio || 1;
    canvas.style.left = "0px";
    canvas.style.top = "0px";
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    redraw();
  }

  function pointFor(e) {
    return [e.clientX + window.scrollX, e.clientY + window.scrollY];
  }

  // ---- rendering ----------------------------------------------------------
  function drawStroke(s) {
    if (!s.points.length) return;
    const t = TOOLS[s.tool] || TOOLS.pen;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.globalAlpha = t.alpha;
    ctx.strokeStyle = colorHex(colorById(s.color));
    ctx.lineWidth = s.size || t.width;
    ctx.beginPath();
    ctx.moveTo(s.points[0][0], s.points[0][1]);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i][0], s.points[i][1]);
    if (s.points.length === 1) ctx.lineTo(s.points[0][0] + 0.01, s.points[0][1] + 0.01); // a tap = a dot
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // Full clear+repaint each frame. Required for the translucent marker (drawing
  // a half-finished stroke incrementally would compound its alpha); also the
  // simplest correct thing. ponytail: O(strokes) per move — fine at annotation
  // scale; redraw only a dirty rect if a page ever accrues thousands of strokes.
  function redraw() {
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokes) drawStroke(s);
    if (cur) drawStroke(cur);
  }

  // ---- pointer drawing ----------------------------------------------------
  function eraseAt(p) {
    const before = strokes.length;
    const radius = Math.max(ERASE_RADIUS, penSize * 4);
    strokes = strokes.filter((s) =>
      !s.points.some(([x, y]) => Math.hypot(x - p[0], y - p[1]) <= radius + (s.size || 2) / 2));
    if (strokes.length !== before) redraw();
  }
  // ponytail: stroke-level erase (removes a whole stroke if the eraser touches
  // it) — predictable and one filter; swap for destination-out if partial
  // rub-out is ever asked for.

  function onDown(e) {
    if (activeTool !== "pen" && activeTool !== "eraser") return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (x) { /* ok */ }
    drawing = true;
    const p = pointFor(e);
    if (activeTool === "eraser") { eraseAt(p); return; }
    cur = { tool: "pen", color: activeColor, size: penSize, points: [p] };
    redraw();
  }
  function onMove(e) {
    if (!drawing) return;
    const p = pointFor(e);
    if (activeTool === "eraser") { eraseAt(p); return; }
    if (!cur) return;
    cur.points.push(p);
    redraw();
  }
  function onUp() {
    if (!drawing) return;
    drawing = false;
    if (activeTool === "eraser") { saveStrokes(); return; }
    if (cur && cur.points.length) strokes.push(cur);
    cur = null;
    redraw();
    saveStrokes();
  }
  function cancelStroke() {
    if (!drawing && !cur) return;
    drawing = false;
    cur = null;
    redraw();
  }

  // ---- toolbar ------------------------------------------------------------
  function iconBtn(name, title) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cpos-dr-btn";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.innerHTML = svg(name);
    return b;
  }
  function sep() {
    const s = document.createElement("span");
    s.className = "cpos-dr-sep";
    return s;
  }

  function clampPenSize(n) {
    return Math.max(1, Math.min(18, Math.round(Number(n) || TOOLS.pen.width)));
  }
  function setPenSize(n) {
    penSize = clampPenSize(n);
    saveUiPrefs();
    renderBar();
  }

  function sizeControls() {
    const wrap = document.createElement("span");
    wrap.className = "cpos-dr-size";

    const dec = document.createElement("button");
    dec.type = "button";
    dec.className = "cpos-dr-size-btn";
    dec.title = "Smaller stroke";
    dec.textContent = "-";
    dec.addEventListener("click", () => setPenSize(penSize - 1));

    const value = document.createElement("button");
    value.type = "button";
    value.className = "cpos-dr-size-value";
    value.title = activeTool === "eraser" ? "Eraser size" : "Pen size";
    value.textContent = penSize + "px";
    value.addEventListener("click", () => setPenSize(penSize >= 12 ? 2 : penSize + 2));

    const inc = document.createElement("button");
    inc.type = "button";
    inc.className = "cpos-dr-size-btn";
    inc.title = "Larger stroke";
    inc.textContent = "+";
    inc.addEventListener("click", () => setPenSize(penSize + 1));

    wrap.appendChild(dec);
    wrap.appendChild(value);
    wrap.appendChild(inc);
    return wrap;
  }

  // Position model: anchor the bar to the viewport CORNER nearest where it was
  // dropped, storing the offset from that corner's two edges —
  // barPos = { ax:"left"|"right", ay:"top"|"bottom", dx, dy } (null = default
  // bottom-right). Anchoring (not a fixed top-left) is what makes the collapsed
  // icon and the much wider expanded toolbar stay glued to the SAME corner and
  // grow toward the screen centre: the toolbar opens right where you left the
  // icon / last dragged it, and neither runs off-screen on resize.
  function clampBarPosition() {
    if (!bar || !barPos) return;
    const pad = 8;
    const w = bar.offsetWidth || 50;
    const h = bar.offsetHeight || 50;
    barPos.dx = Math.max(pad, Math.min(barPos.dx, Math.max(pad, window.innerWidth - w - pad)));
    barPos.dy = Math.max(pad, Math.min(barPos.dy, Math.max(pad, window.innerHeight - h - pad)));
  }
  function applyBarPosition() {
    if (!bar) return;
    // Neutralise draw.css's default `right:18px; bottom:18px` with "auto" — NOT
    // "" — before re-positioning. Clearing the inline value to "" lets the
    // stylesheet rule reassert, which would leave BOTH left and right (or top and
    // bottom) applied and stretch the fixed bar across the whole page.
    bar.style.left = "auto";
    bar.style.right = "auto";
    bar.style.top = "auto";
    bar.style.bottom = "auto";
    if (!barPos) {
      bar.style.right = "18px";
      bar.style.bottom = "18px";
      return;
    }
    clampBarPosition();
    bar.style[barPos.ax] = barPos.dx + "px";
    bar.style[barPos.ay] = barPos.dy + "px";
  }
  // Snap the bar's current rect to the nearest viewport corner anchor.
  function anchorFromRect(rect) {
    const pad = 8;
    const ax = (rect.left + rect.width / 2) < window.innerWidth / 2 ? "left" : "right";
    const ay = (rect.top + rect.height / 2) < window.innerHeight / 2 ? "top" : "bottom";
    const dx = ax === "left" ? rect.left : (window.innerWidth - rect.right);
    const dy = ay === "top" ? rect.top : (window.innerHeight - rect.bottom);
    barPos = { ax, ay, dx: Math.max(pad, dx), dy: Math.max(pad, dy) };
  }
  function dragIgnored(target) {
    return !!(target && target.closest && target.closest("button,input,textarea,select,a"));
  }
  function startBarDrag(e, options = {}) {
    if (!bar) return;
    e.preventDefault();
    const r = bar.getBoundingClientRect();
    const grabX = e.clientX - r.left;
    const grabY = e.clientY - r.top;
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    // While dragging, position live via left/top so the bar tracks the pointer
    // 1:1; on drop we convert to a corner anchor (anchorFromRect) and persist.
    const setLive = (left, top) => {
      const pad = 8;
      const w = bar.offsetWidth || 50;
      const h = bar.offsetHeight || 50;
      left = Math.max(pad, Math.min(left, Math.max(pad, window.innerWidth - w - pad)));
      top = Math.max(pad, Math.min(top, Math.max(pad, window.innerHeight - h - pad)));
      // "auto" (not "") so the stylesheet's right/bottom can't reassert and
      // stretch the bar while dragging — see applyBarPosition.
      bar.style.right = "auto";
      bar.style.bottom = "auto";
      bar.style.left = left + "px";
      bar.style.top = top + "px";
    };
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      moved = true;
      if (options.launch) suppressLaunchClick = true;
      setLive(ev.clientX - grabX, ev.clientY - grabY);
    };
    const up = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      if (moved) {
        anchorFromRect(bar.getBoundingClientRect());
        applyBarPosition();
        saveUiPrefs();
      }
      setTimeout(() => { suppressLaunchClick = false; }, 0);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
  }
  function onBarPointerDown(e) {
    if (!expanded || dragIgnored(e.target)) return;
    startBarDrag(e);
  }

  function setTool(t) {
    activeTool = t;
    // Only the freehand tools capture the canvas; "marker" must leave the page
    // selectable so the user can highlight the text underneath it.
    const armed = t === "pen" || t === "eraser";
    if (canvas) {
      canvas.style.pointerEvents = armed ? "auto" : "none";
      canvas.classList.toggle("cpos-dr-drawing", armed);
    }
    renderBar();
  }

  // Ink swatches for the freehand pen.
  function penSwatches() {
    COLORS.forEach((c) => {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "cpos-dr-swatch";
      sw.title = "Ink colour";
      // !important so the fill survives the page-wide `button { background … }`
      // that Modernize / site themes inject (see draw.css shield).
      sw.style.setProperty("background-color", colorHex(c), "important");
      sw.setAttribute("aria-pressed", c.id === activeColor ? "true" : "false");
      sw.addEventListener("click", () => {
        activeColor = c.id;
        if (activeTool !== "pen") setTool("pen"); // picking a colour arms the pen
        else renderBar();
      });
      bar.appendChild(sw);
    });
  }

  // Marker swatches highlight the SELECTED page text via the annotate
  // engine — pick a colour and it paints whatever is selected.
  function markerSwatches() {
    const AN = self.CPOS_ANNOTATE;
    if (!AN || !AN.isReady()) {
      const note = document.createElement("span");
      note.className = "cpos-dr-hint";
      note.textContent = "highlighter loading…";
      bar.appendChild(note);
      return;
    }
    AN.COLORS.forEach((c) => {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "cpos-dr-swatch";
      sw.title = "Highlight selected text";
      sw.style.setProperty("background-color", AN.colorFill(c), "important");
      sw.setAttribute("aria-pressed", c.id === AN.getActiveColor() ? "true" : "false");
      sw.addEventListener("click", () => {
        AN.setActiveColor(c.id); // just sets the colour — selecting text auto-applies it
        renderBar();
      });
      bar.appendChild(sw);
    });
  }

  // With the Marker tool armed, finishing a text selection on the page
  // immediately highlights it in the current colour — no extra click. Only fires
  // on a live, non-collapsed selection (never on a plain click), and ignores
  // mouseups inside our own toolbar. applySelection itself rejects selections
  // outside the page body, so we don't need the scope check here.
  function onDocMouseUp(e) {
    if (activeTool !== "marker") return;
    if (bar && bar.contains(e.target)) return;
    setTimeout(() => {
      if (activeTool !== "marker") return;
      const AN = self.CPOS_ANNOTATE;
      if (!AN || !AN.isReady()) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      AN.applySelection();
    }, 0); // let the selection settle (double-click word-select, etc.)
  }

  function clearAll() {
    if (!strokes.length) return;
    if (!window.confirm("Clear all drawings on this problem?")) return;
    strokes = [];
    redraw();
    saveStrokes();
    renderBar();
  }
  function undoLast() {
    if (!strokes.length) return;
    strokes.pop();
    redraw();
    saveStrokes();
    renderBar();
  }

  function onKeyDown(e) {
    if (!built) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
      if (activeTool === "pen" || activeTool === "eraser") {
        e.preventDefault();
        undoLast();
      }
      return;
    }
    if (e.key === "Escape") {
      cancelStroke();
      setTool(null);
      expanded = false;
      renderBar();
    }
  }

  function renderBar() {
    if (!bar) return;
    bar.innerHTML = "";
    bar.classList.toggle("cpos-dr-open", expanded);

    if (!expanded) {
      const launch = iconBtn("pen", "Draw on this page");
      launch.classList.add("cpos-dr-launch");
      launch.addEventListener("pointerdown", (e) => startBarDrag(e, { launch: true }));
      launch.addEventListener("click", () => {
        if (suppressLaunchClick) return;
        expanded = true;
        renderBar();
      });
      bar.appendChild(launch);
      applyBarPosition();
      return;
    }

    const dragDot = document.createElement("span");
    dragDot.className = "cpos-dr-drag-dot";
    dragDot.title = "Drag toolbar";
    bar.appendChild(dragDot);

    [["pen", "Pen"], ["marker", "Marker"], ["eraser", "Eraser"]].forEach(([id, label]) => {
      const b = iconBtn(id, label);
      b.classList.toggle("cpos-dr-on", activeTool === id);
      b.addEventListener("click", () => setTool(activeTool === id ? null : id));
      bar.appendChild(b);
    });

    bar.appendChild(sep());

    // Colours mean different things per tool: ink for the pen, highlight for the
    // text marker.
    if (activeTool === "marker") markerSwatches();
    else penSwatches();

    bar.appendChild(sep());

    // Clear only makes sense for freehand ink (highlights are removed per-mark
    // via their own click popover), so hide it in marker mode.
    if (activeTool !== "marker") {
      bar.appendChild(sizeControls());
      bar.appendChild(sep());

      const undo = iconBtn("undo", "Undo last stroke");
      undo.disabled = !strokes.length;
      undo.classList.toggle("cpos-dr-disabled", !strokes.length);
      undo.addEventListener("click", undoLast);
      bar.appendChild(undo);

      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "cpos-dr-btn cpos-dr-danger";
      clear.title = "Erase all freehand drawings";
      clear.textContent = "Clear";
      clear.addEventListener("click", clearAll);
      bar.appendChild(clear);
    }

    const done = iconBtn("done", "Done");
    done.addEventListener("click", () => { setTool(null); expanded = false; renderBar(); });
    bar.appendChild(done);
    applyBarPosition();
  }

  // ---- theme --------------------------------------------------------------
  async function ensureTheme() {
    theme = T.get(await C.activeThemeId());
  }
  function restyle() {
    if (!bar || !theme) return;
    bar.style.setProperty("--cpos-dr-panel", theme["--panel"]);
    bar.style.setProperty("--cpos-dr-bg", theme["--bg"]);
    bar.style.setProperty("--cpos-dr-fg", theme["--fg"]);
    bar.style.setProperty("--cpos-dr-dim", theme["--dim"]);
    bar.style.setProperty("--cpos-dr-border", theme["--border"]);
    bar.style.setProperty("--cpos-dr-accent", theme["--accent"]);
    bar.style.setProperty("--cpos-dr-bad", theme["--bad"]);
    // The ink palette is theme-derived, so a theme switch must repaint strokes
    // and re-render the swatches with their new concrete hex.
    redraw();
    renderBar();
  }

  // ---- resize -------------------------------------------------------------
  let resizeRAF = 0;
  function onResize() {
    if (resizeRAF) return;
    resizeRAF = requestAnimationFrame(() => {
      resizeRAF = 0;
      layoutCanvas();
      applyBarPosition();
    });
  }

  // ---- build / teardown ---------------------------------------------------
  function buildLayer() {
    canvas = document.createElement("canvas");
    canvas.id = LAYER_ID;
    document.body.appendChild(canvas);
    ctx = canvas.getContext("2d");
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("lostpointercapture", onUp);
  }
  function buildBar() {
    bar = document.createElement("div");
    bar.id = BAR_ID;
    document.body.appendChild(bar);
    bar.addEventListener("pointerdown", onBarPointerDown);
    renderBar();
  }

  async function build() {
    if (built) return;
    scope = pageScope();
    if (!scope || !scope.container) return;
    built = true;
    await ensureTheme();
    await loadUiPrefs();
    const stored = await loadStrokes();
    strokes = stored.map((s) => ({
      tool: s.tool || "pen",
      color: s.color || "ink",
      size: s.size,
      points: Array.isArray(s.points) ? s.points : []
    }));
    buildLayer();
    buildBar();
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", cancelStroke);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mouseup", onDocMouseUp);
    if ("ResizeObserver" in window) {
      resizeObserver = new ResizeObserver(onResize);
      resizeObserver.observe(document.documentElement);
      if (document.body) resizeObserver.observe(document.body);
    }
    layoutCanvas();
    restyle();
  }

  function teardown() {
    if (!built) return;
    built = false;
    window.removeEventListener("resize", onResize);
    window.removeEventListener("blur", cancelStroke);
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("mouseup", onDocMouseUp);
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    if (resizeRAF) { cancelAnimationFrame(resizeRAF); resizeRAF = 0; }
    bar?.removeEventListener("pointerdown", onBarPointerDown);
    canvas?.remove(); canvas = null; ctx = null;
    bar?.remove(); bar = null;
    strokes = []; activeTool = null; expanded = false; drawing = false; cur = null;
  }

  // ---- lifecycle ----------------------------------------------------------
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
