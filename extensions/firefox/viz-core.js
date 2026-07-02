// CPOS structure visualizer core — parses a sample test input and draws it as
// the structure it actually is: graph, tree, parent-array tree, grid, matrix,
// array, permutation (with cycle arcs), intervals or 2D points. Includes
// multi-testcase segmentation ("t on the first line"), pan/zoom, node drag,
// tree re-rooting, heatmaps, directed/weighted toggles and SVG/DOT export.
// No dependencies; renders into any container. Theme comes from --cpos-* CSS
// variables on the container (with dark fallbacks).
//
// CANONICAL COPY: extensions/chrome/viz-core.js. Keep the copies at
// extensions/firefox/viz-core.js and extensions/vscode/media/viz-core.js
// byte-identical (they are synced verbatim).
(function (root) {
  "use strict";

  // ---- text utils -----------------------------------------------------------
  const INT_RE = /^[+-]?\d+$/;
  const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

  function splitLines(text) {
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    return lines;
  }
  const toks = (line) => line.trim().split(/\s+/).filter(Boolean);
  const isInt = (s) => INT_RE.test(s);
  const isNum = (s) => NUM_RE.test(s);
  const allInts = (ts) => ts.length > 0 && ts.every(isInt);
  const allNums = (ts) => ts.length > 0 && ts.every(isNum);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---- structure detection ---------------------------------------------------
  // Each parser inspects an array of raw lines and returns a candidate
  // { type, score, note, data } or null. Scores are heuristic confidence in
  // [0,1]; statement-text hints nudge them. "tokens" always succeeds so the
  // panel never renders nothing.

  function detectBase(ids, n) {
    // 0- vs 1-indexed: any zero → 0-indexed; ids reaching n with no zero → 1.
    let sawZero = false;
    for (const id of ids) if (id === 0) { sawZero = true; break; }
    return sawZero ? 0 : 1;
  }

  function edgeLines(lines, from, count) {
    // Read up to `count` lines of 2-3 integer tokens starting at `from`.
    const edges = [];
    let weighted = false;
    for (let i = 0; i < count; i++) {
      const t = toks(lines[from + i] || "");
      if ((t.length !== 2 && t.length !== 3) || !allInts(t)) return null;
      const e = t.map(Number);
      if (t.length === 3) weighted = true;
      edges.push(e);
    }
    return { edges, weighted };
  }

  function graphInfo(n, edges, base) {
    // Adjacency + connectivity + acyclicity over ids [base, base+n).
    const adj = Array.from({ length: n }, () => []);
    let inRange = true;
    for (const e of edges) {
      const u = e[0] - base, v = e[1] - base;
      if (u < 0 || u >= n || v < 0 || v >= n) { inRange = false; continue; }
      adj[u].push(v);
      adj[v].push(u);
    }
    let seen = 0, acyclic = true;
    if (n > 0 && inRange) {
      const vis = new Array(n).fill(false);
      const stack = [[0, -1]];
      vis[0] = true;
      // Iterative DFS; parent-edge skip is approximate for multigraphs, fine
      // for classification.
      while (stack.length) {
        const [u, p] = stack.pop();
        seen++;
        let skippedParent = false;
        for (const v of adj[u]) {
          if (!vis[v]) { vis[v] = true; stack.push([v, u]); }
          else if (v === p && !skippedParent) skippedParent = true;
          else acyclic = false;
        }
      }
    }
    return { inRange, connected: inRange && seen === n, acyclic };
  }

  // Graph/tree shapes, including the ubiquitous CF layout with auxiliary node
  // values between the header and the edges ("n m" / "a1..an" / n-1 edges),
  // and inputs where extra query/parameter lines trail the edge block.
  function parseGraphish(lines) {
    const out = [];
    if (lines.length < 2) return out;
    const h = toks(lines[0]);
    if (!allInts(h) || h.length < 1 || h.length > 4) return out;
    const n = Number(h[0]);
    if (!(n >= 2 && n <= 500000)) return out;
    const mHeader = h.length >= 2 ? Number(h[1]) : null;

    // Paths: edges start right after the header, or after 1-2 full-width
    // value lines (colors, weights, cat markers…).
    const paths = [{ start: 1, values: null }];
    const v1 = toks(lines[1] || "");
    if (v1.length === n && allNums(v1)) {
      paths.push({ start: 2, values: v1 });
      const v2 = toks(lines[2] || "");
      if (v2.length === n && allNums(v2)) paths.push({ start: 3, values: v1 });
    }

    for (const p of paths) {
      const rest = lines.length - p.start;
      const counts = new Set();
      if (mHeader != null && mHeader >= 1) counts.add(mHeader);
      if (n - 1 >= 1) counts.add(n - 1);
      counts.add(rest);
      let best = null;
      for (const m of counts) {
        if (m < 1 || m > rest) continue;
        const parsed = edgeLines(lines, p.start, m);
        if (!parsed) continue;
        const ids = [];
        for (const e of parsed.edges) ids.push(e[0], e[1]);
        const base = detectBase(ids, n);
        const info = graphInfo(n, parsed.edges, base);
        if (!info.inRange) continue;
        const leftover = rest - m;
        const isTree = m === n - 1 && info.connected && info.acyclic;
        let score = isTree ? 0.93 : (mHeader === m ? 0.88 : 0.62);
        // A header that declares the exact edge count and consumes the input
        // exactly beats a reading that reinterprets edge columns as values.
        if (mHeader === m && leftover === 0) score += 0.08;
        if (leftover > 0) score -= 0.18;
        if (p.values) score += 0.02;
        // "n q / a1..an / q queries" looks identical to a disconnected graph
        // with node values whose edges are all l<=r ranges — and the range-
        // query reading is far more common, so demote the graph one.
        if (p.values && !isTree && !info.connected && parsed.edges.every((e) => e[0] <= e[1])) score -= 0.45;
        score = Math.min(0.97, score);
        const bits = [(isTree ? "tree" : "graph"), "n=" + n, m + " edges"];
        if (parsed.weighted) bits.push("weighted");
        if (p.values) bits.push("node values from line 2");
        if (!isTree && !info.connected) bits.push("disconnected");
        if (leftover > 0) bits.push("+" + leftover + " trailing lines ignored");
        const cand = {
          type: isTree ? "tree" : "graph", score,
          note: bits.join(" · "),
          data: { n, edges: parsed.edges, weighted: parsed.weighted, base, values: p.values || undefined }
        };
        if (!best || cand.score > best.score) best = cand;
      }
      if (best) out.push(best);
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 2);
  }

  function parseParentArray(lines) {
    // "n" then one line of n-1 parents (p2..pn), the classic CF tree input.
    if (lines.length < 2) return null;
    const h = toks(lines[0]);
    if (h.length !== 1 || !isInt(h[0])) return null;
    const n = Number(h[0]);
    if (!(n >= 2 && n <= 500000)) return null;
    const t = toks(lines[1]);
    if (lines.length !== 2 || t.length !== n - 1 || !allInts(t)) return null;
    const ps = t.map(Number);
    if (!ps.every((p) => p >= 1 && p <= n)) return null;
    const edges = ps.map((p, i) => [p, i + 2]);
    return {
      type: "tree", score: 0.8,
      note: "tree from parent array p2..p" + n + " · n=" + n,
      data: { n, edges, weighted: false, base: 1, root: 1 }
    };
  }

  function looksCharGrid(rows, width) {
    if (!rows.length) return false;
    for (const r of rows) {
      if (r.length !== width || r.length === 0 || /\s/.test(r)) return false;
    }
    // Grids are made of a small alphabet, typically punctuation/letters.
    const alphabet = new Set();
    for (const r of rows) for (const ch of r) alphabet.add(ch);
    return alphabet.size <= Math.max(8, Math.ceil(Math.sqrt(width * rows.length)));
  }

  function parseGrid(lines) {
    if (!lines.length) return null;
    const h = toks(lines[0]);
    // Headered: "n" or "n m" then n rows of equal width; trailing lines after
    // the n rows (queries etc.) are tolerated at reduced confidence.
    if (allInts(h) && (h.length === 1 || h.length === 2) && lines.length >= 2) {
      const n = Number(h[0]);
      if (n >= 1 && lines.length - 1 >= n) {
        const rows = lines.slice(1, 1 + n).map((l) => l.trim());
        const leftover = lines.length - 1 - n;
        const width = h.length === 2 ? Number(h[1]) : rows[0].length;
        if (rows[0] && width === rows[0].length && looksCharGrid(rows, width) && !(width === 1 && n === 1)) {
          // All-digit single-token rows could equally be a matrix column; keep
          // grid but at reduced confidence when fully numeric.
          const numeric = rows.every((r) => isInt(r));
          let score = numeric ? 0.7 : 0.94;
          if (leftover > 0) score -= 0.2;
          return {
            type: "grid", score,
            note: "grid · " + n + "×" + width + (leftover > 0 ? " · +" + leftover + " trailing lines ignored" : ""),
            data: { rows, R: n, C: width }
          };
        }
      }
    }
    // Headerless: every line an equal-width token run of chars.
    const rows = lines.map((l) => l.trim());
    if (rows.length >= 2 && rows[0].length >= 2 && looksCharGrid(rows, rows[0].length)) {
      const numeric = rows.every((r) => isInt(r));
      if (!numeric) {
        return {
          type: "grid", score: 0.6,
          note: "grid · " + rows.length + "×" + rows[0].length + " (no header)",
          data: { rows, R: rows.length, C: rows[0].length }
        };
      }
    }
    return null;
  }

  function parseMatrix(lines) {
    if (lines.length < 2) return null;
    const h = toks(lines[0]);
    let start = 0, R = 0, C = 0, score = 0.5;
    if (allInts(h) && h.length === 2 && lines.length === Number(h[0]) + 1) {
      start = 1; R = Number(h[0]); C = Number(h[1]); score = 0.86;
    } else {
      R = lines.length;
      C = toks(lines[0]).length;
      if (C < 2) return null;
    }
    const rows = [];
    for (let i = 0; i < R; i++) {
      const t = toks(lines[start + i] || "");
      if (t.length !== C || !allNums(t)) return null;
      rows.push(t);
    }
    return {
      type: "matrix", score,
      note: "matrix · " + R + "×" + C,
      data: { rows, R, C }
    };
  }

  function permCycles(values, base) {
    const n = values.length;
    const seen = new Array(n).fill(false);
    const cycleOf = new Array(n).fill(0);
    let cycles = 0;
    for (let i = 0; i < n; i++) {
      if (seen[i]) continue;
      let j = i;
      while (!seen[j]) {
        seen[j] = true;
        cycleOf[j] = cycles;
        j = values[j] - base;
        if (j < 0 || j >= n) return null;
      }
      cycles++;
    }
    return { cycleOf, cycles };
  }

  function parseArray(lines) {
    if (!lines.length) return null;
    const h = toks(lines[0]);
    let values = null, score = 0, extraNote = "";
    if (allInts(h) && h.length === 1 && lines.length >= 2) {
      // "n" then n numbers on one or more lines.
      const n = Number(h[0]);
      const flat = [];
      for (let i = 1; i < lines.length; i++) {
        const t = toks(lines[i]);
        if (!allNums(t)) { flat.length = 0; break; }
        flat.push(...t);
      }
      if (flat.length === n && n >= 1) { values = flat; score = 0.78; }
    }
    if (!values && allInts(h) && (h.length === 1 || h.length === 2) && lines.length >= 2) {
      // "n [k]" then one line of exactly n numbers; anything after it (second
      // arrays, queries) is ignored rather than sinking the detection.
      const n = Number(h[0]);
      const t = toks(lines[1]);
      if (n >= 2 && t.length === n && allNums(t)) {
        values = t;
        const leftover = lines.length - 2;
        score = leftover > 0 ? 0.55 : 0.72;
        if (leftover > 0) extraNote = " · +" + leftover + " trailing lines ignored";
      }
    }
    if (!values && lines.length === 1 && allNums(h) && h.length >= 2) {
      values = h;
      score = 0.5;
    }
    if (!values && lines.length >= 2) {
      // Headerless column of numbers — one answer per line (typical multi-test
      // output). Low confidence so any structured reading wins over it.
      const col = lines.map(toks);
      if (col.every((t) => t.length === 1 && isNum(t[0]))) {
        values = col.map((t) => t[0]);
        score = 0.35;
      }
    }
    if (!values) return null;
    const out = [];
    // Values that all point inside [base, base+n) form a functional graph
    // (i → a[i]) — successor/teleport problems; offered as an alternate view.
    const addFunctional = (nums, base) => {
      const n = nums.length;
      if (n < 2 || n > 100000) return;
      for (const v of nums) if (v < base || v >= base + n) return;
      out.push({
        type: "graph", score: 0.5,
        note: "functional graph · edges i → a[i] · n=" + n,
        data: { n, edges: nums.map((v, i) => [i + base, v]), weighted: false, base, directed: true }
      });
    };
    // Permutation of 1..n (or 0..n-1)?
    if (values.every(isInt)) {
      const nums = values.map(Number);
      const base = nums.includes(0) ? 0 : 1;
      addFunctional(nums, base);
      const want = new Set(nums);
      let isPerm = want.size === nums.length && nums.length >= 2;
      if (isPerm) for (const v of nums) if (v < base || v > nums.length - 1 + base) { isPerm = false; break; }
      if (isPerm) {
        const cyc = permCycles(nums, base);
        if (cyc) {
          out.unshift({
            type: "perm", score: Math.min(0.97, score + 0.12),
            note: "permutation · n=" + nums.length + " · " + cyc.cycles + (cyc.cycles === 1 ? " cycle" : " cycles") + extraNote,
            data: { values, nums, base, cycleOf: cyc.cycleOf, cycles: cyc.cycles }
          });
          return out;
        }
      }
    }
    out.unshift({
      type: "array", score,
      note: "array · n=" + values.length + extraNote,
      data: { values }
    });
    return out;
  }

  // Maximal run of "x y" pair lines starting at `start`, plus how many lines
  // were left after the run. Headered inputs may carry trailing query lines.
  function pairRun(lines, headered) {
    const start = headered ? 1 : 0;
    const rows = [];
    let i = start;
    for (; i < lines.length; i++) {
      const t = toks(lines[i]);
      if (t.length !== 2 || !allNums(t)) break;
      rows.push([Number(t[0]), Number(t[1])]);
    }
    return { rows, leftover: lines.length - i };
  }

  function parsePairs(lines, kind) {
    if (lines.length < 2) return null;
    const h = toks(lines[0]);
    const headered = allInts(h) && (h.length === 1 || h.length === 2) && Number(h[0]) >= 2;
    const n = headered ? Number(h[0]) : 0;
    let { rows, leftover } = pairRun(lines, headered);
    if (headered) {
      if (rows.length < n) return null;
      leftover += rows.length - n;
      rows = rows.slice(0, n);
    } else if (leftover > 0 || rows.length < 2) {
      return null; // headerless pair lists must consume the whole input
    }
    if (rows.length < 2) return null;
    if (kind === "intervals") {
      let ordered = 0;
      for (const [l, r] of rows) if (l <= r) ordered++;
      if (ordered / rows.length < 0.85) return null;
    }
    let score = kind === "intervals" ? (headered ? 0.58 : 0.4) : (headered ? 0.42 : 0.3);
    if (leftover > 0) score -= 0.15;
    const note = kind + " · " + rows.length + (leftover > 0 ? " · +" + leftover + " trailing lines ignored" : "");
    return kind === "intervals"
      ? { type: "intervals", score, note, data: { list: rows } }
      : { type: "points", score, note, data: { pts: rows } };
  }

  const parseIntervals = (lines) => parsePairs(lines, "intervals");
  const parsePoints = (lines) => parsePairs(lines, "points");

  // Character strings — "n [k]" + one long token (bracket sequences, DNA-style
  // strings, binary strings…), or a whole input that is a single token.
  function parseString(lines) {
    if (!lines.length) return null;
    const h = toks(lines[0]);
    const singleTok = (i) => {
      const t = toks(lines[i] || "");
      return t.length === 1 ? t[0] : null;
    };
    const isStr = (s) => !!s && s.length >= 2 && !isNum(s);
    let str = null, score = 0, extra = "";
    if (allInts(h) && h.length >= 1 && h.length <= 3 && lines.length >= 2) {
      const n = Number(h[0]);
      const s = singleTok(1);
      // A digit run whose length equals the declared n is a binary/digit
      // string ("5 1" + "11010"), not a scalar — length match disambiguates.
      if (s && s.length === n && (isStr(s) || (n >= 2 && /^\d+$/.test(s)))) {
        str = s;
        const leftover = lines.length - 2;
        score = leftover > 0 ? 0.6 : 0.9;
        if (leftover > 0) extra = " · +" + leftover + " trailing lines ignored";
      }
    }
    if (!str && lines.length === 1 && isStr(singleTok(0))) {
      str = singleTok(0);
      score = 0.65;
    }
    if (!str) return null;
    const chars = [...str];
    const bracketish = chars.filter((c) => "()[]{}".includes(c)).length;
    const isBracket = bracketish / chars.length >= 0.9;
    return {
      type: "string",
      score: isBracket ? Math.min(0.95, score + 0.05) : score,
      note: (isBracket ? "bracket string" : "string") + " · n=" + chars.length + extra,
      data: { chars, isBracket }
    };
  }

  // Several strings, one per line (LCS pairs, word lists, k binary masks —
  // the classic multi-test OUTPUT shape), with or without a count header.
  // Digit runs count as strings when they carry string signals: leading
  // zeros ("00", "00010") or a pure 0/1 alphabet. Char grids win when they
  // truly look like grids; ragged or wide-alphabet line sets land here.
  function parseStrings(lines) {
    if (lines.length < 2) return null;
    const leadZero = (s) => s.length > 1 && s[0] === "0";
    const h = toks(lines[0]);
    // A count header never has leading zeros; "00" opening the input is data.
    const headered = allInts(h) && (h.length === 1 || h.length === 2)
      && !h.some(leadZero) && Number(h[0]) >= 1 && Number(h[0]) <= 200000;
    const start = headered ? 1 : 0;
    const raw = [];
    for (let i = start; i < lines.length; i++) {
      const t = toks(lines[i]);
      if (t.length !== 1) return null;
      raw.push(t[0]);
    }
    if (raw.length < 2 || !raw.some((s) => s.length >= 2)) return null;
    const someNonNum = raw.some((s) => !isNum(s));
    if (someNonNum && raw.some((s) => isNum(s) && !leadZero(s) && !/^[01]+$/.test(s))) return null; // mixed words+numbers: not a string list
    let score;
    if (someNonNum) {
      score = headered && Number(h[0]) === raw.length ? 0.75 : headered ? 0.45 : 0.6;
    } else {
      // all-numeric lines: only string-like if leading zeros or binary alphabet
      const binary = raw.every((s) => /^[01]+$/.test(s));
      const zeros = raw.some(leadZero);
      if (!binary && !zeros) return null;
      score = binary ? 0.55 : 0.5;
    }
    const list = raw.map((s) => [...s]);
    return {
      type: "strings", score,
      note: list.length + " strings · longest " + Math.max(...list.map((s) => s.length)),
      data: { list }
    };
  }

  function parseTokens(lines) {
    return {
      type: "tokens", score: 0.05,
      note: lines.length + (lines.length === 1 ? " line" : " lines"),
      data: { lines: lines.map(toks), raw: lines }
    };
  }

  const HINTS = [
    [/permutation/, { perm: 0.2, array: 0.05 }],
    [/bracket|parenthes/, { string: 0.25 }],
    [/\bstring\b|substring|\bword\b|\btext\b|palindrom/, { string: 0.15, strings: 0.1 }],
    [/successor|functional graph|teleport/, { graph: 0.2 }],
    [/\btree\b|vertices.*tree|rooted/, { tree: 0.15 }],
    [/\bgraph\b|\bedges?\b|vertices|undirected|directed/, { graph: 0.12, tree: 0.06 }],
    [/\bgrid\b|\bmaze\b|\bcells?\b|\brows?\b.*\bcolumns?\b/, { grid: 0.15, matrix: 0.06 }],
    [/\bmatrix\b|\btable\b/, { matrix: 0.15 }],
    [/segments?|intervals?|\branges?\b/, { intervals: 0.22 }],
    [/points?|coordinates?|plane/, { points: 0.2 }],
    [/\barray\b|sequence/, { array: 0.08, perm: 0.04 }]
  ];

  function hintBoosts(statementText) {
    const boosts = {};
    const text = String(statementText || "").toLowerCase().slice(0, 20000);
    if (!text) return boosts;
    for (const [re, add] of HINTS) {
      if (!re.test(text)) continue;
      for (const [k, v] of Object.entries(add)) boosts[k] = Math.max(boosts[k] || 0, v);
    }
    return boosts;
  }

  function candidatesFor(lines, boosts) {
    const found = [];
    for (const p of [parseGrid, parseGraphish, parseParentArray, parseMatrix, parseString, parseStrings, parseArray, parseIntervals, parsePoints]) {
      try {
        const c = p(lines);
        if (Array.isArray(c)) found.push(...c);
        else if (c) found.push(c);
      } catch (_) { /* a parser must never take the panel down */ }
    }
    found.push(parseTokens(lines));
    for (const c of found) c.score = Math.min(0.99, c.score + ((boosts && boosts[c.type]) || 0));
    found.sort((a, b) => b.score - a.score);
    return found;
  }

  // Forced (lenient) parses for when the user overrides the detected type.
  function forceParse(type, lines) {
    const salvagePairs = () => {
      const rows = [];
      for (const l of lines) {
        const t = toks(l);
        if (t.length === 2 && allNums(t)) rows.push([Number(t[0]), Number(t[1])]);
      }
      return rows;
    };
    if (type === "graph" || type === "tree") {
      const edges = [];
      let weighted = false, maxId = 1;
      for (const l of lines) {
        const t = toks(l);
        if ((t.length === 2 || t.length === 3) && allInts(t)) {
          const e = t.map(Number);
          if (t.length === 3) weighted = true;
          edges.push(e);
          maxId = Math.max(maxId, e[0], e[1]);
        }
      }
      if (!edges.length) return null;
      const ids = [];
      for (const e of edges) ids.push(e[0], e[1]);
      const base = detectBase(ids, maxId);
      const n = maxId - base + 1;
      return { type, score: 0, note: type + " (forced) · " + edges.length + " edge lines", data: { n, edges, weighted, base } };
    }
    if (type === "grid") {
      const rows = lines.map((l) => l.trim()).filter((l) => l && !/\s/.test(l));
      const body = rows.length > 1 && allInts(toks(rows[0])) && rows[0].length < rows[1].length ? rows.slice(1) : rows;
      if (!body.length) return null;
      const C = Math.max(...body.map((r) => r.length));
      return { type: "grid", score: 0, note: "grid (forced) · " + body.length + "×" + C, data: { rows: body.map((r) => r.padEnd(C, " ")), R: body.length, C } };
    }
    if (type === "matrix") {
      const rows = lines.map(toks).filter((t) => t.length && allNums(t));
      if (rows.length < 1) return null;
      const C = Math.max(...rows.map((r) => r.length));
      return { type: "matrix", score: 0, note: "matrix (forced) · " + rows.length + "×" + C, data: { rows: rows.map((r) => r.concat(Array(C - r.length).fill(""))), R: rows.length, C } };
    }
    if (type === "array" || type === "perm") {
      const values = [];
      for (const l of lines) for (const t of toks(l)) if (isNum(t)) values.push(t);
      if (!values.length) return null;
      if (type === "perm" && values.every(isInt)) {
        const nums = values.map(Number);
        const base = nums.includes(0) ? 0 : 1;
        const cyc = permCycles(nums, base);
        if (cyc) return { type: "perm", score: 0, note: "permutation (forced) · n=" + nums.length, data: { values, nums, base, cycleOf: cyc.cycleOf, cycles: cyc.cycles } };
      }
      return { type: "array", score: 0, note: "array (forced) · n=" + values.length, data: { values } };
    }
    if (type === "strings") {
      const list = [];
      for (const l of lines) {
        const t = toks(l);
        if (t.length === 1) list.push([...t[0]]);
      }
      if (list.length < 1) return null;
      return { type: "strings", score: 0, note: "strings (forced) · " + list.length, data: { list } };
    }
    if (type === "string") {
      // Take the longest single-token line; fall back to all lines glued.
      let best = "";
      for (const l of lines) {
        const t = toks(l);
        if (t.length === 1 && t[0].length > best.length) best = t[0];
      }
      if (!best) best = lines.map((l) => l.trim()).join("");
      if (!best) return null;
      const chars = [...best];
      const bracketish = chars.filter((c) => "()[]{}".includes(c)).length;
      return { type: "string", score: 0, note: "string (forced) · n=" + chars.length, data: { chars, isBracket: bracketish / chars.length >= 0.9 } };
    }
    if (type === "intervals") {
      const rows = salvagePairs();
      return rows.length ? { type: "intervals", score: 0, note: "intervals (forced) · " + rows.length, data: { list: rows } } : null;
    }
    if (type === "points") {
      const rows = salvagePairs();
      return rows.length ? { type: "points", score: 0, note: "points (forced) · " + rows.length, data: { pts: rows } } : null;
    }
    return parseTokens(lines);
  }

  // ---- multi-testcase segmentation -------------------------------------------
  // CF-style inputs open with a single integer t followed by t cases. Try, in
  // order: capture-provided block sizes, header-driven consumption, fixed
  // 2-lines-per-case, 1-line-per-case.
  function segmentCases(lines, blockSizes) {
    if (lines.length < 3) return null;
    const h = toks(lines[0]);
    if (h.length !== 1 || !isInt(h[0])) return null;
    const t = Number(h[0]);
    if (!(t >= 2 && t <= 100000)) return null;
    const body = lines.length - 1;

    if (Array.isArray(blockSizes) && blockSizes.length >= 2 && blockSizes[0] === 1) {
      const blocks = blockSizes.slice(1);
      const total = blocks.reduce((a, b) => a + b, 0);
      if (total === body && blocks.length % t === 0) {
        const per = blocks.length / t;
        const cases = [];
        let at = 1;
        for (let i = 0; i < t; i++) {
          let len = 0;
          for (let j = 0; j < per; j++) len += blocks[i * per + j];
          cases.push({ from: at, to: at + len });
          at += len;
        }
        return { t, cases };
      }
    }

    // Header-driven: each case starts with an int header describing its size.
    // A rule can be ambiguous ("n m + m edges" vs "n m + n matrix rows"), so
    // collect every plausible consumption and backtrack until exactly t cases
    // land exactly on the end of the input.
    const consumeOptions = (pos) => {
      const head = toks(lines[pos] || "");
      if (!allInts(head) || head.length < 1 || head.length > 4) return [];
      const n = Number(head[0]);
      const m = head.length >= 2 ? Number(head[1]) : -1;
      if (n < 0 || n > 2000000) return [];
      const fits = (k) => pos + 1 + k <= lines.length;
      const lineHas = (i, pred) => pred(toks(lines[pos + 1 + i] || ""));
      const rowIsGrid = (i, w) => {
        const r = (lines[pos + 1 + i] || "").trim();
        return r.length === w && !/\s/.test(r) && r.length > 0;
      };
      const outs = new Set();
      // n m + n grid rows of width m
      if (m > 0 && n > 0 && fits(n)) {
        let ok = true;
        for (let i = 0; i < n && ok; i++) ok = rowIsGrid(i, m);
        if (ok) outs.add(pos + 1 + n);
      }
      // n m + m edge lines (tried before the matrix reading: far more common in
      // CP inputs, and the DFS backtracks into the matrix option when needed)
      if (m > 0 && fits(m)) {
        let ok = true;
        for (let i = 0; i < m && ok; i++) ok = lineHas(i, (tk) => (tk.length === 2 || tk.length === 3) && allInts(tk));
        if (ok) outs.add(pos + 1 + m);
      }
      // n m + n rows of m numbers
      if (m > 0 && n > 0 && fits(n)) {
        let ok = true;
        for (let i = 0; i < n && ok; i++) ok = lineHas(i, (tk) => tk.length === m && allNums(tk));
        if (ok) outs.add(pos + 1 + n);
      }
      // n + one line of n values
      if (head.length === 1 && fits(1) && lineHas(0, (tk) => tk.length === n && allNums(tk))) outs.add(pos + 2);
      // header + one single-token string line of length n ("n k" + bracket/char string)
      if (fits(1)) {
        const st = toks(lines[pos + 1] || "");
        if (st.length === 1 && st[0].length === n && !isNum(st[0])) outs.add(pos + 2);
      }
      // header + 1-2 value lines of n numbers + (n-1 or m) edge lines — the
      // classic tree/graph-with-node-values case body
      if (n >= 2) {
        for (let j = 1; j <= 2; j++) {
          let vok = true;
          for (let a = 0; a < j && vok; a++) vok = lineHas(a, (tk) => tk.length === n && allNums(tk));
          if (!vok) break;
          const eCounts = m > 0 ? [n - 1, m] : [n - 1];
          for (const ec of eCounts) {
            if (ec < 1 || !fits(j + ec)) continue;
            let eok = true;
            for (let i = 0; i < ec && eok; i++) eok = lineHas(j + i, (tk) => (tk.length === 2 || tk.length === 3) && allInts(tk));
            if (eok) outs.add(pos + 1 + j + ec);
          }
        }
      }
      // n + n-1 edge lines (tree)
      if (head.length === 1 && n >= 2 && fits(n - 1)) {
        let ok = true;
        for (let i = 0; i < n - 1 && ok; i++) ok = lineHas(i, (tk) => (tk.length === 2 || tk.length === 3) && allInts(tk));
        if (ok) outs.add(pos + n);
      }
      // n + n pair lines (intervals/points) or n grid rows
      if (head.length === 1 && n >= 1 && fits(n)) {
        let ok = true;
        for (let i = 0; i < n && ok; i++) ok = lineHas(i, (tk) => tk.length === 2 && allNums(tk));
        if (ok) outs.add(pos + 1 + n);
        ok = true;
        const w = (lines[pos + 1] || "").trim().length;
        for (let i = 0; i < n && ok; i++) ok = rowIsGrid(i, w);
        if (ok && w > 0) outs.add(pos + 1 + n);
      }
      // header-only case (e.g. "n k" with the answer derived from it alone)
      if (head.length >= 2) outs.add(pos + 1);
      return [...outs].filter((p) => p <= lines.length);
    };
    const strategies = [
      () => {
        const dead = new Set(); // "pos:left" states that cannot reach the end
        const path = [];
        const dfs = (pos, left) => {
          if (left === 0) return pos === lines.length;
          if (pos >= lines.length) return false;
          if (lines.length - pos < left) return false;
          const key = pos + ":" + left;
          if (dead.has(key)) return false;
          for (const next of consumeOptions(pos)) {
            path.push({ from: pos, to: next });
            if (dfs(next, left - 1)) return true;
            path.pop();
          }
          dead.add(key);
          return false;
        };
        return dfs(1, t) ? path.slice() : null;
      },
      () => {
        if (body !== 2 * t) return null;
        const cases = [];
        for (let i = 0; i < t; i++) cases.push({ from: 1 + i * 2, to: 1 + i * 2 + 2 });
        return cases;
      },
      () => {
        if (body !== t) return null;
        const cases = [];
        for (let i = 0; i < t; i++) cases.push({ from: 1 + i, to: 2 + i });
        return cases;
      }
    ];
    for (const s of strategies) {
      const cases = s();
      if (cases) return { t, cases };
    }
    return null;
  }

  // Segmentation is only worth surfacing when the per-case reading is more
  // coherent than reading the whole input as one structure ("n then n pairs"
  // must stay intervals, not n one-line cases). Capture-provided block sizes
  // are authoritative and skip the check.
  function chooseSegmentation(lines, blockSizes, boosts) {
    const seg = segmentCases(lines, blockSizes);
    if (!seg) return null;
    if (Array.isArray(blockSizes) && blockSizes.length >= 2 && blockSizes[0] === 1) return seg;
    const whole = candidatesFor(lines, boosts)[0];
    const c0 = seg.cases[0];
    const first = candidatesFor(lines.slice(c0.from, c0.to), boosts)[0];
    if (whole.score >= 0.35 && whole.score >= first.score - 0.05) return null;
    return seg;
  }

  // ---- layouts ----------------------------------------------------------------
  function layoutForce(n, edges, base) {
    // Deterministic spring-electrical layout in the unit square. Seeded on a
    // golden-angle circle so the same input always draws the same picture.
    const px = new Float64Array(n), py = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = i * 2.39996322972865332;
      const r = 0.16 + 0.28 * Math.sqrt((i + 1) / n);
      px[i] = 0.5 + r * Math.cos(a);
      py[i] = 0.5 + r * Math.sin(a);
    }
    const es = [];
    for (const e of edges) {
      const u = e[0] - base, v = e[1] - base;
      if (u >= 0 && u < n && v >= 0 && v < n && u !== v) es.push([u, v]);
    }
    const K = 0.9 / Math.sqrt(Math.max(n, 1));
    const iters = n <= 80 ? 260 : n <= 200 ? 150 : 90;
    let temp = 0.11;
    const dx = new Float64Array(n), dy = new Float64Array(n);
    for (let it = 0; it < iters; it++) {
      dx.fill(0); dy.fill(0);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let ex = px[i] - px[j], ey = py[i] - py[j];
          let d2 = ex * ex + ey * ey;
          if (d2 < 1e-8) { ex = (((i * 31 + j) % 13) - 6) * 1e-4; ey = (((i * 17 + j) % 11) - 5) * 1e-4; d2 = ex * ex + ey * ey; }
          const f = (K * K) / d2;
          dx[i] += ex * f; dy[i] += ey * f;
          dx[j] -= ex * f; dy[j] -= ey * f;
        }
      }
      for (const [u, v] of es) {
        const ex = px[u] - px[v], ey = py[u] - py[v];
        const d = Math.sqrt(ex * ex + ey * ey) || 1e-6;
        const f = (d * d) / K / d;
        dx[u] -= ex * f; dy[u] -= ey * f;
        dx[v] += ex * f; dy[v] += ey * f;
      }
      for (let i = 0; i < n; i++) {
        // slight gravity keeps disconnected components in frame
        dx[i] += (0.5 - px[i]) * 0.02;
        dy[i] += (0.5 - py[i]) * 0.02;
        const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1e-9;
        const cap = Math.min(d, temp);
        px[i] += (dx[i] / d) * cap;
        py[i] += (dy[i] / d) * cap;
      }
      temp *= 0.965;
    }
    return { px, py };
  }

  function layoutTree(n, edges, base, rootId) {
    const adj = Array.from({ length: n }, () => []);
    const treeEdges = [], extraEdges = [];
    const seenPair = new Set();
    for (const e of edges) {
      const u = e[0] - base, v = e[1] - base;
      if (u < 0 || u >= n || v < 0 || v >= n) continue;
      adj[u].push(v); adj[v].push(u);
    }
    const root = clamp((rootId != null ? rootId : base) - base, 0, n - 1);
    const parent = new Array(n).fill(-2);
    const depth = new Array(n).fill(0);
    const order = [];
    const roots = [];
    const bfs = (r) => {
      parent[r] = -1;
      roots.push(r);
      const q = [r];
      for (let qi = 0; qi < q.length; qi++) {
        const u = q[qi];
        order.push(u);
        for (const v of adj[u]) if (parent[v] === -2) { parent[v] = u; depth[v] = depth[u] + 1; q.push(v); }
      }
    };
    bfs(root);
    for (let i = 0; i < n; i++) if (parent[i] === -2) bfs(i); // forest fallback
    const children = Array.from({ length: n }, () => []);
    for (const u of order) if (parent[u] >= 0) children[parent[u]].push(u);
    for (const e of edges) {
      const u = e[0] - base, v = e[1] - base;
      if (u < 0 || u >= n || v < 0 || v >= n) continue;
      const isTreeEdge = parent[v] === u || parent[u] === v;
      const key = Math.min(u, v) + ":" + Math.max(u, v);
      if (isTreeEdge && !seenPair.has(key)) { seenPair.add(key); treeEdges.push(e); }
      else extraEdges.push(e);
    }
    // Post-order x: leaves take slots, parents sit at their children's middle.
    const x = new Float64Array(n);
    const size = new Array(n).fill(1);
    let slot = 0;
    for (let i = order.length - 1; i >= 0; i--) {
      const u = order[i];
      for (const c of children[u]) size[u] += size[c];
    }
    const assign = (u) => {
      const stack = [[u, 0]];
      while (stack.length) {
        const top = stack[stack.length - 1];
        const [node, idx] = top;
        if (children[node].length === 0) { x[node] = slot++; stack.pop(); continue; }
        if (idx < children[node].length) { top[1]++; stack.push([children[node][idx], 0]); continue; }
        let lo = Infinity, hi = -Infinity;
        for (const c of children[node]) { lo = Math.min(lo, x[c]); hi = Math.max(hi, x[c]); }
        x[node] = (lo + hi) / 2;
        stack.pop();
      }
    };
    for (const r of roots) assign(r);
    let maxDepth = 0;
    for (let i = 0; i < n; i++) maxDepth = Math.max(maxDepth, depth[i]);
    return { x, depth, maxDepth, leaves: slot, parent, children, size, root, extraEdges, treeEdges };
  }

  // ---- colors ------------------------------------------------------------------
  const cycHue = (i) => "hsl(" + Math.round((i * 137.508 + 210) % 360) + " 62% 62%)";
  function charColor(ch, pal) {
    if (ch === "#" || ch === "*") return pal.fg;
    if (ch === "." || ch === "_" || ch === " " || ch === "0") return null; // empty cell
    const code = ch.charCodeAt(0);
    return "hsl(" + Math.round((code * 47.5) % 360) + " 58% 58%)";
  }
  function heatColor(t) {
    // cold slate → hot rose, readable on dark and light panels
    const h = 215 - 195 * clamp(t, 0, 1);
    return "hsl(" + Math.round(h) + " 70% " + Math.round(62 - 10 * t) + "%)";
  }

  // ---- DOM/SVG helpers -----------------------------------------------------------
  const SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }
  function domEl(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }
  function resolvePalette(container) {
    const cs = getComputedStyle(container);
    const v = (name, fb) => {
      const raw = (cs.getPropertyValue(name) || "").trim();
      return raw || fb;
    };
    return {
      bg: v("--cpos-bg", "#14141f"),
      panel: v("--cpos-panel", "#1b1b2b"),
      panel2: v("--cpos-panel-2", "#232334"),
      fg: v("--cpos-fg", "#e8e6f0"),
      dim: v("--cpos-dim", "#8b88a0"),
      border: v("--cpos-border", "#2a2a3e"),
      accent: v("--cpos-accent", "#b794ff"),
      ok: v("--cpos-ok", "#7ee787"),
      bad: v("--cpos-bad", "#ff7a93"),
      warn: v("--cpos-warn", "#f0c060")
    };
  }

  // ---- styles ----------------------------------------------------------------------
  const STYLE_ID = "cpos-viz-style";
  const CSS = `
.cpos-viz { display: flex; flex-direction: column; height: 100%; min-height: 0; font: 12px/1.45 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--cpos-fg, #e8e6f0); }
.cpos-viz * { box-sizing: border-box; }
.cvz-bar { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; padding: 7px 9px; flex: 0 0 auto; background: var(--cpos-panel, #1b1b2b); border-bottom: 1px solid var(--cpos-border, #2a2a3e); }
.cvz-bar select { background: var(--cpos-panel-2, #232334); color: var(--cpos-fg, #e8e6f0); border: 1px solid var(--cpos-border, #2a2a3e); border-radius: 6px; padding: 3px 5px; font: inherit; font-size: 11.5px; max-width: 140px; }
.cvz-bar .cvz-ic { background: var(--cpos-panel-2, #232334); color: var(--cpos-fg, #e8e6f0); border: 1px solid var(--cpos-border, #2a2a3e); border-radius: 6px; padding: 3px 7px; font: inherit; font-size: 11.5px; cursor: pointer; line-height: 1.2; }
.cvz-bar .cvz-ic:hover { border-color: var(--cpos-accent, #b794ff); }
.cvz-bar .cvz-ic.on { background: var(--cpos-accent, #b794ff); color: var(--cpos-bg, #14141f); border-color: var(--cpos-accent, #b794ff); }
.cvz-bar .cvz-primary { background: var(--cpos-accent, #b794ff); color: var(--cpos-bg, #14141f); border-color: var(--cpos-accent, #b794ff); font-weight: 700; }
.cvz-bar .cvz-primary:hover:not(:disabled) { filter: brightness(1.12); }
.cvz-bar .cvz-primary:disabled { opacity: 0.6; cursor: default; }
.cvz-ink { display: none; align-items: center; gap: 4px; }
.cvz-ink.open { display: inline-flex; }
.cvz-ink .cvz-dot { width: 16px; height: 16px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
.cvz-ink .cvz-dot.on { border-color: var(--cpos-fg, #e8e6f0); }
.cpos-viz .cvz-stage svg.inking { cursor: crosshair; }
.cvz-flash { position: absolute; top: 10px; left: 50%; transform: translateX(-50%) translateY(-6px); z-index: 8; max-width: min(92%, 560px); background: var(--cpos-panel, #1b1b2b); color: var(--cpos-fg, #e8e6f0); border: 1px solid var(--cpos-accent, #b794ff); border-radius: 8px; padding: 8px 14px; font-size: 12px; line-height: 1.5; box-shadow: 0 6px 22px rgba(0,0,0,0.45); opacity: 0; pointer-events: none; transition: opacity 0.15s ease, transform 0.15s ease; cursor: pointer; }
.cvz-flash.open { opacity: 1; transform: translateX(-50%) translateY(0); pointer-events: auto; }
.cvz-flash.err { border-color: var(--cpos-bad, #ff7a93); color: var(--cpos-bad, #ff7a93); }
.cvz-vars { position: absolute; left: 8px; bottom: 8px; z-index: 4; max-width: 46%; max-height: 55%; overflow: auto; background: color-mix(in srgb, var(--cpos-panel, #1b1b2b) 88%, transparent); border: 1px solid var(--cpos-border, #2a2a3e); border-radius: 8px; padding: 7px 10px; font: 11px/1.6 ui-monospace, Menlo, Consolas, monospace; display: none; }
.cvz-vars.open { display: block; }
.cvz-vars .cvz-vh { color: var(--cpos-dim, #8b88a0); font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 2px; }
.cvz-vars .cvz-vrow b { color: var(--cpos-accent, #b794ff); font-weight: 600; }
.cvz-vars .cvz-vrow span { color: var(--cpos-fg, #e8e6f0); }
.cvz-vars .cvz-vrow.fresh span { color: var(--cpos-warn, #f0c060); }
.cvz-grow { flex: 1 1 auto; }
.cvz-stage { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; background: var(--cpos-bg, #14141f); }
.cvz-stage svg { display: block; width: 100%; height: 100%; cursor: grab; }
.cvz-stage svg.panning { cursor: grabbing; }
.cvz-stage svg text { user-select: none; }
.cvz-node { cursor: pointer; }
.cvz-dim .cvz-e:not(.on) { opacity: 0.13; }
.cvz-dim .cvz-node:not(.on) { opacity: 0.25; }
.cvz-dim .cvz-elab:not(.on) { opacity: 0.1; }
.cvz-tip { position: absolute; pointer-events: none; z-index: 5; background: var(--cpos-panel, #1b1b2b); color: var(--cpos-fg, #e8e6f0); border: 1px solid var(--cpos-border, #2a2a3e); border-radius: 6px; padding: 3px 7px; font-size: 11px; font-family: ui-monospace, Menlo, Consolas, monospace; white-space: pre; display: none; box-shadow: 0 3px 10px rgba(0,0,0,0.35); }
.cvz-status { flex: 0 0 auto; display: flex; gap: 8px; align-items: baseline; padding: 5px 10px; font-size: 11px; font-family: ui-monospace, Menlo, Consolas, monospace; color: var(--cpos-dim, #8b88a0); background: var(--cpos-panel, #1b1b2b); border-top: 1px solid var(--cpos-border, #2a2a3e); min-height: 24px; overflow: hidden; white-space: nowrap; }
.cvz-status b { color: var(--cpos-fg, #e8e6f0); font-weight: 600; }
.cvz-status .cvz-warn { color: var(--cpos-warn, #f0c060); }
.cvz-edit { display: none; flex: 0 0 auto; border-bottom: 1px solid var(--cpos-border, #2a2a3e); }
.cvz-edit.open { display: block; }
.cvz-edit textarea { display: block; width: 100%; height: 110px; resize: vertical; background: var(--cpos-bg, #14141f); color: var(--cpos-fg, #e8e6f0); border: none; outline: none; padding: 8px 10px; font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace; }
.cvz-opts { position: absolute; top: 6px; right: 8px; z-index: 6; background: var(--cpos-panel, #1b1b2b); border: 1px solid var(--cpos-border, #2a2a3e); border-radius: 8px; padding: 9px 11px; display: none; flex-direction: column; gap: 6px; box-shadow: 0 6px 20px rgba(0,0,0,0.4); font-size: 11.5px; min-width: 170px; }
.cvz-opts.open { display: flex; }
.cvz-opts label { display: flex; align-items: center; gap: 7px; cursor: pointer; }
.cvz-opts input[type="number"] { width: 52px; background: var(--cpos-panel-2, #232334); color: var(--cpos-fg, #e8e6f0); border: 1px solid var(--cpos-border, #2a2a3e); border-radius: 5px; padding: 2px 4px; font: inherit; }
.cvz-opts select { background: var(--cpos-panel-2, #232334); color: var(--cpos-fg, #e8e6f0); border: 1px solid var(--cpos-border, #2a2a3e); border-radius: 5px; padding: 2px 4px; font: inherit; }
.cvz-opts .cvz-sec { color: var(--cpos-dim, #8b88a0); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 2px; }
.cvz-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; color: var(--cpos-dim, #8b88a0); padding: 20px; font-size: 12.5px; line-height: 1.7; }
.cvz-trace { display: none; align-items: center; gap: 6px; padding: 6px 9px; flex: 0 0 auto; background: var(--cpos-panel, #1b1b2b); border-bottom: 1px solid var(--cpos-border, #2a2a3e); }
.cvz-trace.open { display: flex; }
.cvz-trace input[type="range"] { flex: 1 1 auto; min-width: 60px; accent-color: var(--cpos-accent, #b794ff); }
.cvz-trace .cvz-tlabel { font: 11px ui-monospace, Menlo, Consolas, monospace; color: var(--cpos-dim, #8b88a0); min-width: 64px; text-align: right; }
.cvz-trace select { background: var(--cpos-panel-2, #232334); color: var(--cpos-fg, #e8e6f0); border: 1px solid var(--cpos-border, #2a2a3e); border-radius: 6px; padding: 2px 4px; font-size: 11px; }
.cvz-help { position: absolute; top: 6px; left: 8px; right: 8px; z-index: 7; background: var(--cpos-panel, #1b1b2b); border: 1px solid var(--cpos-border, #2a2a3e); border-radius: 8px; padding: 12px 14px; display: none; flex-direction: column; gap: 8px; box-shadow: 0 6px 20px rgba(0,0,0,0.45); max-height: calc(100% - 16px); overflow: auto; }
.cvz-help.open { display: flex; }
.cvz-help pre { margin: 0; padding: 8px 10px; background: var(--cpos-bg, #14141f); border: 1px solid var(--cpos-border, #2a2a3e); border-radius: 6px; font: 11px/1.5 ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap; }
.cvz-help .cvz-hrow { display: flex; align-items: center; gap: 8px; }
.cvz-help .cvz-hrow b { font-size: 11.5px; }
.cvz-help button { background: var(--cpos-panel-2, #232334); color: var(--cpos-fg, #e8e6f0); border: 1px solid var(--cpos-border, #2a2a3e); border-radius: 5px; padding: 2px 8px; font-size: 10.5px; cursor: pointer; }
.cvz-help button:hover { border-color: var(--cpos-accent, #b794ff); }
`;

  function injectStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const st = doc.createElement("style");
    st.id = STYLE_ID;
    st.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(st);
  }

  // ---- renderers --------------------------------------------------------------------
  // Each renderer fills `scene` (an SVG <g>) and returns { w, h, status } where
  // w/h are world-coordinate bounds used to fit the viewBox.

  function edgeKey(u, v) { return Math.min(u, v) + ":" + Math.max(u, v); }

  function renderNodeLink(scene, cand, pal, o, ui) {
    const { n, edges, weighted, base } = cand.data;
    if (n > 1500) return tooLarge(scene, pal, "graph with n=" + n + " (cap 1500)");
    const isTree = cand.type === "tree" && !o.forceLayout;
    let extraSet = null, treeInfo = null;
    const W = Math.max(460, Math.sqrt(n) * 130);
    const H = W;
    const pad = 46;
    const r = clamp(Math.round(150 / Math.sqrt(n + 4)), 6, 20);
    const xs = new Float64Array(n), ys = new Float64Array(n);
    let worldW = W, worldH = H;
    if (isTree) {
      treeInfo = layoutTree(n, edges, base, o.root != null ? o.root : cand.data.root);
      const cols = Math.max(treeInfo.leaves - 1, 1);
      const rows = Math.max(treeInfo.maxDepth, 1);
      const w = Math.max(460, treeInfo.leaves * (r * 2.6));
      const h = Math.max(320, (treeInfo.maxDepth + 1) * (r * 4.6));
      for (let i = 0; i < n; i++) {
        xs[i] = pad + (treeInfo.x[i] / cols) * (w - 2 * pad);
        ys[i] = pad + (treeInfo.depth[i] / rows) * (h - 2 * pad);
      }
      if (treeInfo.maxDepth === 0) for (let i = 0; i < n; i++) ys[i] = h / 2;
      extraSet = new Set(treeInfo.extraEdges.map((e) => edgeKey(e[0] - base, e[1] - base)));
      worldW = w; worldH = h;
    } else {
      const pos = layoutForce(n, edges, base);
      for (let i = 0; i < n; i++) {
        xs[i] = pad + pos.px[i] * (W - 2 * pad);
        ys[i] = pad + pos.py[i] * (H - 2 * pad);
      }
    }

    const defs = svgEl("defs");
    const marker = svgEl("marker", { id: "cvz-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    marker.appendChild(svgEl("path", { d: "M 0 1 L 9 5 L 0 9 z", fill: pal.dim }));
    defs.appendChild(marker);
    scene.appendChild(defs);

    const gEdges = svgEl("g"), gLabels = svgEl("g"), gNodes = svgEl("g");
    scene.appendChild(gEdges); scene.appendChild(gLabels); scene.appendChild(gNodes);

    const incident = Array.from({ length: n }, () => []);
    const neighbors = Array.from({ length: n }, () => []);
    const pairCount = new Map();
    const edgeEls = [];

    const fs = clamp(r * 0.95, 7, 13);
    const wfs = clamp(r * 0.8, 7, 11);

    function edgePath(u, v, curve) {
      const x1 = xs[u], y1 = ys[u], x2 = xs[v], y2 = ys[v];
      let ex1 = x1, ey1 = y1, ex2 = x2, ey2 = y2;
      if (o.directed) {
        const d = Math.hypot(x2 - x1, y2 - y1) || 1;
        ex1 = x1 + ((x2 - x1) / d) * r; ey1 = y1 + ((y2 - y1) / d) * r;
        ex2 = x2 - ((x2 - x1) / d) * (r + 2.5); ey2 = y2 - ((y2 - y1) / d) * (r + 2.5);
      }
      if (!curve) return "M " + ex1 + " " + ey1 + " L " + ex2 + " " + ey2;
      const mx = (ex1 + ex2) / 2, my = (ey1 + ey2) / 2;
      const nx = -(ey2 - ey1), ny = ex2 - ex1;
      const nd = Math.hypot(nx, ny) || 1;
      const off = curve * clamp(r * 1.6, 10, 26);
      return "M " + ex1 + " " + ey1 + " Q " + (mx + (nx / nd) * off) + " " + (my + (ny / nd) * off) + " " + ex2 + " " + ey2;
    }

    edges.forEach((e, ei) => {
      const u = e[0] - base, v = e[1] - base;
      if (u < 0 || u >= n || v < 0 || v >= n) return;
      const key = edgeKey(u, v);
      const dup = pairCount.get(key) || 0;
      pairCount.set(key, dup + 1);
      let p;
      if (u === v) {
        const lr = r * 1.25;
        p = svgEl("path", { d: "M " + (xs[u] - r * 0.5) + " " + (ys[u] - r * 0.85) + " a " + lr + " " + lr + " 0 1 1 " + r + " 0", fill: "none" });
      } else {
        const curve = dup === 0 ? 0 : (dup % 2 === 1 ? 1 : -1) * Math.ceil(dup / 2);
        p = svgEl("path", { d: edgePath(u, v, curve), fill: "none" });
      }
      const isExtra = extraSet && extraSet.has(key) && dup === 0 && !(treeInfo && (treeInfo.parent[v] === u || treeInfo.parent[u] === v));
      p.setAttribute("class", "cvz-e");
      p.setAttribute("stroke", isExtra ? pal.warn : pal.dim);
      p.setAttribute("stroke-width", isExtra ? 1.2 : 1.5);
      if (isExtra) p.setAttribute("stroke-dasharray", "5 4");
      if (o.directed && u !== v) p.setAttribute("marker-end", "url(#cvz-arrow)");
      p.setAttribute("stroke-opacity", 0.8);
      gEdges.appendChild(p);
      edgeEls.push({ el: p, u, v, ei });
      incident[u].push(p); incident[v].push(p);
      if (u !== v) { neighbors[u].push(v); neighbors[v].push(u); }
      if (weighted && o.weights && e.length === 3 && u !== v) {
        const t = svgEl("text", {
          x: (xs[u] + xs[v]) / 2, y: (ys[u] + ys[v]) / 2 - 3,
          "text-anchor": "middle", "font-size": wfs,
          fill: pal.warn, stroke: pal.bg, "stroke-width": 3, "paint-order": "stroke",
          "font-family": "ui-monospace, Menlo, Consolas, monospace", class: "cvz-elab"
        });
        t.textContent = String(e[2]);
        gLabels.appendChild(t);
        edgeEls[edgeEls.length - 1].label = t;
      }
    });

    const degree = new Array(n).fill(0);
    for (const { u, v } of edgeEls) { degree[u]++; if (u !== v) degree[v]++; }

    // Node value fills: binary 0/1 marks (red = 1), a few distinct values get
    // categorical hues, a wide numeric range gets a heat ramp.
    const values = cand.data.values && cand.data.values.length === n ? cand.data.values : null;
    let valFill = null;
    if (values) {
      const distinct = [...new Set(values)];
      const nums = values.map(Number);
      if (distinct.length === 2 && distinct.every((v) => v === "0" || v === "1")) {
        valFill = (i) => (values[i] === "1" ? pal.bad : null);
      } else if (distinct.length >= 2 && distinct.length <= 8) {
        const idx = new Map(distinct.map((v, k) => [v, k]));
        valFill = (i) => cycHue(idx.get(values[i]));
      } else if (distinct.length > 1 && nums.every(Number.isFinite)) {
        const lo = Math.min(...nums), hi = Math.max(...nums), span = hi - lo || 1;
        valFill = (i) => heatColor((nums[i] - lo) / span);
      }
    }

    const nodeEls = [];
    const handles = { nodes: new Map(), edges: new Map() };
    for (const ee of edgeEls) {
      const k = edgeKey(ee.u + base, ee.v + base);
      if (!handles.edges.has(k)) handles.edges.set(k, { el: ee.el });
    }
    for (let i = 0; i < n; i++) {
      const g = svgEl("g", { class: "cvz-node" });
      const vfill = valFill ? valFill(i) : null;
      const c = svgEl("circle", {
        cx: xs[i], cy: ys[i], r,
        fill: vfill || pal.panel2, "fill-opacity": vfill ? 0.85 : 1,
        stroke: treeInfo && i === treeInfo.root ? pal.accent : pal.border,
        "stroke-width": treeInfo && i === treeInfo.root ? 2.4 : 1.4
      });
      g.appendChild(c);
      let labelEl = null;
      if (r >= 8) {
        const t = svgEl("text", { x: xs[i], y: ys[i], dy: "0.34em", "text-anchor": "middle", "font-size": fs, fill: vfill ? pal.bg : pal.fg, "font-weight": vfill ? 700 : 400, "font-family": "ui-monospace, Menlo, Consolas, monospace" });
        t.textContent = String(i + base);
        g.appendChild(t);
        labelEl = t;
      }
      handles.nodes.set(String(i + base), { el: c, textEl: labelEl });
      gNodes.appendChild(g);
      nodeEls.push(g);

      g.addEventListener("pointerenter", () => {
        ui.svg.classList.add("cvz-dim");
        g.classList.add("on");
        for (const p of incident[i]) p.classList.add("on");
        for (const nb of neighbors[i]) nodeEls[nb].classList.add("on");
        for (const ee of edgeEls) if (ee.label && (ee.u === i || ee.v === i)) ee.label.classList.add("on");
        let tip = "node " + (i + base) + "\ndeg " + degree[i];
        if (values) tip += "\na[" + (i + base) + "] = " + values[i];
        if (treeInfo) tip += "\ndepth " + treeInfo.depth[i] + " · subtree " + treeInfo.size[i];
        ui.tip(tip);
      });
      g.addEventListener("pointerleave", () => {
        ui.svg.classList.remove("cvz-dim");
        g.classList.remove("on");
        for (const p of incident[i]) p.classList.remove("on");
        for (const nb of neighbors[i]) nodeEls[nb].classList.remove("on");
        for (const ee of edgeEls) if (ee.label) ee.label.classList.remove("on");
        ui.tip(null);
      });

      // Drag to reposition (force view); click to re-root (tree view). In
      // marker mode the event falls through so you can draw over nodes.
      let dragMoved = false;
      g.addEventListener("pointerdown", (ev) => {
        if (ui.isMarking && ui.isMarking()) return;
        ev.stopPropagation();
        ev.preventDefault();
        dragMoved = false;
        const move = (mv) => {
          const pt = ui.toWorld(mv.clientX, mv.clientY);
          dragMoved = true;
          xs[i] = pt.x; ys[i] = pt.y;
          c.setAttribute("cx", pt.x); c.setAttribute("cy", pt.y);
          const label = g.querySelector("text");
          if (label) { label.setAttribute("x", pt.x); label.setAttribute("y", pt.y); }
          for (const ee of edgeEls) {
            if (ee.u !== i && ee.v !== i) continue;
            if (ee.u === ee.v) {
              ee.el.setAttribute("d", "M " + (xs[i] - r * 0.5) + " " + (ys[i] - r * 0.85) + " a " + (r * 1.25) + " " + (r * 1.25) + " 0 1 1 " + r + " 0");
            } else {
              ee.el.setAttribute("d", edgePath(ee.u, ee.v, 0));
            }
            if (ee.label) {
              ee.label.setAttribute("x", (xs[ee.u] + xs[ee.v]) / 2);
              ee.label.setAttribute("y", (ys[ee.u] + ys[ee.v]) / 2 - 3);
            }
          }
        };
        const up = (uv) => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          if (!dragMoved && isTree) { o.root = i + base; ui.rerender(); }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      });
    }

    let status = "<b>" + (isTree ? "tree" : "graph") + "</b> n=" + n + " edges=" + edges.length;
    if (values && valFill) status += " · node values colored";
    if (treeInfo) status += " depth=" + treeInfo.maxDepth + " root=<b>" + (treeInfo.root + base) + "</b> (click a node to re-root)";
    if (extraSet && treeInfo && treeInfo.extraEdges.length) status += " · <span class=\"cvz-warn\">" + treeInfo.extraEdges.length + " non-tree edges dashed</span>";
    return { w: worldW, h: worldH, status, handles };
  }

  function renderGrid(scene, cand, pal, o, ui) {
    const { rows, R, C } = cand.data;
    if (R * C > 250000) return tooLarge(scene, pal, "grid " + R + "×" + C);
    const cs = clamp(Math.floor(720 / Math.max(R, C)), 4, 30);
    const ox = 30, oy = 30;
    const showText = cs >= 12;
    const gap = cs >= 8 ? 1 : 0;
    const handles = { cells: new Map() };
    for (let i = 0; i < R; i++) {
      for (let j = 0; j < C; j++) {
        const ch = rows[i][j];
        const fill = charColor(ch, pal);
        const rect = svgEl("rect", {
          x: ox + j * cs, y: oy + i * cs, width: cs - gap, height: cs - gap,
          fill: fill || pal.panel2, "fill-opacity": fill ? 0.85 : 0.5, rx: cs >= 10 ? 2 : 0
        });
        scene.appendChild(rect);
        let textEl = null;
        if (showText) {
          const t = svgEl("text", {
            x: ox + j * cs + cs / 2, y: oy + i * cs + cs / 2, dy: "0.34em", "text-anchor": "middle",
            "font-size": Math.floor(cs * 0.55), fill: fill ? pal.bg : pal.dim,
            "font-family": "ui-monospace, Menlo, Consolas, monospace"
          });
          t.textContent = ch;
          scene.appendChild(t);
          textEl = t;
        }
        handles.cells.set((i + 1) + ":" + (j + 1), { el: rect, textEl });
        rect.addEventListener("pointerenter", () => ui.tip("(" + (i + 1) + "," + (j + 1) + ") = '" + ch + "'"));
        rect.addEventListener("pointerleave", () => ui.tip(null));
      }
    }
    // index labels, thinned so they never clutter
    const stepI = Math.max(1, Math.ceil(R / 25)), stepJ = Math.max(1, Math.ceil(C / 25));
    for (let i = 0; i < R; i += stepI) {
      const t = svgEl("text", { x: ox - 7, y: oy + i * cs + cs / 2, dy: "0.34em", "text-anchor": "end", "font-size": Math.min(11, cs), fill: pal.dim, "font-family": "ui-monospace, Menlo, Consolas, monospace" });
      t.textContent = String(i + 1);
      scene.appendChild(t);
    }
    for (let j = 0; j < C; j += stepJ) {
      const t = svgEl("text", { x: ox + j * cs + cs / 2, y: oy - 8, "text-anchor": "middle", "font-size": Math.min(11, cs), fill: pal.dim, "font-family": "ui-monospace, Menlo, Consolas, monospace" });
      t.textContent = String(j + 1);
      scene.appendChild(t);
    }
    return { w: ox * 2 + C * cs, h: oy * 2 + R * cs, status: "<b>grid</b> " + R + "×" + C, handles };
  }

  function renderMatrix(scene, cand, pal, o, ui) {
    const { rows, R, C } = cand.data;
    if (R * C > 100000) return tooLarge(scene, pal, "matrix " + R + "×" + C);
    let lo = Infinity, hi = -Infinity, maxLen = 1;
    for (const r of rows) for (const t of r) {
      if (t === "") continue;
      const v = Number(t);
      if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      maxLen = Math.max(maxLen, String(t).length);
    }
    const span = hi - lo || 1;
    const cs = clamp(Math.max(22, maxLen * 9 + 8), 22, 64);
    const ox = 34, oy = 30;
    const handles = { cells: new Map() };
    for (let i = 0; i < R; i++) {
      for (let j = 0; j < C; j++) {
        const tok = rows[i][j];
        const v = Number(tok);
        const t01 = tok === "" || !Number.isFinite(v) ? 0 : (v - lo) / span;
        const rect = svgEl("rect", {
          x: ox + j * cs, y: oy + i * cs, width: cs - 1.5, height: cs - 1.5, rx: 3,
          fill: o.heat && tok !== "" ? heatColor(t01) : pal.panel2,
          "fill-opacity": o.heat ? 0.28 + 0.62 * t01 : 0.75,
          stroke: pal.border, "stroke-width": 0.6
        });
        scene.appendChild(rect);
        let textEl = null;
        if (cs >= 20 && tok !== "") {
          const txt = svgEl("text", {
            x: ox + j * cs + (cs - 1.5) / 2, y: oy + i * cs + (cs - 1.5) / 2, dy: "0.34em", "text-anchor": "middle",
            "font-size": clamp(Math.floor((cs - 6) / Math.max(1, String(tok).length) * 1.6), 8, 14),
            fill: pal.fg, "font-family": "ui-monospace, Menlo, Consolas, monospace"
          });
          txt.textContent = String(tok);
          scene.appendChild(txt);
          textEl = txt;
        }
        handles.cells.set((i + 1) + ":" + (j + 1), { el: rect, textEl });
        rect.addEventListener("pointerenter", () => ui.tip("a[" + (i + 1) + "][" + (j + 1) + "] = " + tok));
        rect.addEventListener("pointerleave", () => ui.tip(null));
      }
    }
    return { w: ox * 2 + C * cs, h: oy * 2 + R * cs, status: "<b>matrix</b> " + R + "×" + C + " · min " + lo + " · max " + hi, handles };
  }

  function renderArray(scene, cand, pal, o, ui) {
    const isPerm = cand.type === "perm";
    const values = cand.data.values;
    const N = values.length;
    if (N > 5000) return tooLarge(scene, pal, "array of " + N);
    const nums = values.map(Number);
    const finite = nums.filter(Number.isFinite);
    let lo = Math.min(...finite), hi = Math.max(...finite);
    if (!finite.length) { lo = 0; hi = 1; }
    const span = hi - lo || 1;

    const handles = { cells: new Map() };
    const dispIdx = (i) => i + (o.base === 0 ? 0 : 1);
    if (o.bars && finite.length === N) {
      // bar chart strip
      const bw = clamp(Math.floor(900 / N), 3, 26);
      const bh = 220, oy = 30, ox = 30;
      const zero = clamp((0 - lo) / span, 0, 1);
      const zeroY = oy + bh * (1 - zero);
      for (let i = 0; i < N; i++) {
        const t01 = (nums[i] - lo) / span;
        const y = oy + bh * (1 - t01);
        const rect = svgEl("rect", {
          x: ox + i * bw, y: Math.min(y, zeroY), width: Math.max(1, bw - 1), height: Math.max(1.5, Math.abs(zeroY - y)),
          fill: o.heat ? heatColor(t01) : pal.accent, "fill-opacity": 0.8, rx: 1
        });
        scene.appendChild(rect);
        handles.cells.set(String(dispIdx(i)), { el: rect, textEl: null });
        rect.addEventListener("pointerenter", () => ui.tip("a[" + (i + 1) + "] = " + values[i]));
        rect.addEventListener("pointerleave", () => ui.tip(null));
      }
      scene.appendChild(svgEl("line", { x1: ox, y1: zeroY, x2: ox + N * bw, y2: zeroY, stroke: pal.dim, "stroke-width": 1, "stroke-opacity": 0.6 }));
      return { w: ox * 2 + N * bw, h: oy * 2 + bh, status: "<b>array</b> n=" + N + " · min " + lo + " · max " + hi, handles };
    }

    const strip = isPerm && N <= 300;
    const maxLen = Math.max(...values.map((v) => String(v).length), 1);
    const cs = clamp(Math.max(24, maxLen * 8.5 + 10), 24, 60);
    const perRow = strip ? N : Math.max(1, Math.min(Math.ceil(Math.sqrt(N * 2.6)), Math.floor(880 / cs)));
    const rowsCount = Math.ceil(N / perRow);
    const ox = 30;
    const arcRoom = strip ? clamp(N * cs * 0.16, 40, 190) : 0;
    const oy = 34 + arcRoom;
    for (let i = 0; i < N; i++) {
      const ri = Math.floor(i / perRow), ci = i % perRow;
      const x = ox + ci * cs, y = oy + ri * (cs + 16);
      const t01 = Number.isFinite(nums[i]) ? (nums[i] - lo) / span : 0;
      const color = isPerm ? cycHue(cand.data.cycleOf[i]) : (o.heat ? heatColor(t01) : pal.panel2);
      const rect = svgEl("rect", { x, y, width: cs - 2, height: cs - 2, rx: 4, fill: color, "fill-opacity": isPerm ? 0.55 : (o.heat ? 0.3 + 0.6 * t01 : 0.8), stroke: pal.border, "stroke-width": 0.8 });
      scene.appendChild(rect);
      const val = svgEl("text", { x: x + (cs - 2) / 2, y: y + (cs - 2) / 2, dy: "0.34em", "text-anchor": "middle", "font-size": clamp(Math.floor((cs - 8) / Math.max(1, String(values[i]).length) * 1.55), 8, 15), fill: pal.fg, "font-family": "ui-monospace, Menlo, Consolas, monospace" });
      val.textContent = String(values[i]);
      scene.appendChild(val);
      handles.cells.set(String(dispIdx(i)), { el: rect, textEl: val });
      const stepIdx = Math.max(1, Math.ceil(perRow / 30));
      if (ci % stepIdx === 0) {
        const idx = svgEl("text", { x: x + (cs - 2) / 2, y: y - 5, "text-anchor": "middle", "font-size": 9.5, fill: pal.dim, "font-family": "ui-monospace, Menlo, Consolas, monospace" });
        idx.textContent = String(i + (o.base === 0 ? 0 : 1));
        scene.appendChild(idx);
      }
      rect.addEventListener("pointerenter", () => ui.tip("a[" + (i + (o.base === 0 ? 0 : 1)) + "] = " + values[i] + (isPerm ? "\ncycle #" + (cand.data.cycleOf[i] + 1) : "")));
      rect.addEventListener("pointerleave", () => ui.tip(null));
    }
    if (strip) {
      // permutation arcs i -> p[i], colored per cycle
      for (let i = 0; i < N; i++) {
        const target = cand.data.nums[i] - cand.data.base;
        if (target === i || target < 0 || target >= N) continue;
        const x1 = ox + i * cs + (cs - 2) / 2, x2 = ox + target * cs + (cs - 2) / 2;
        const y0 = oy - 12;
        const lift = clamp(Math.abs(x2 - x1) * 0.35, 14, arcRoom - 6);
        const p = svgEl("path", { d: "M " + x1 + " " + y0 + " Q " + ((x1 + x2) / 2) + " " + (y0 - lift) + " " + x2 + " " + y0, fill: "none", stroke: cycHue(cand.data.cycleOf[i]), "stroke-width": 1.5, "stroke-opacity": 0.8, "marker-end": "url(#cvz-arrow2)" });
        scene.appendChild(p);
      }
      const defs = svgEl("defs");
      const marker = svgEl("marker", { id: "cvz-arrow2", viewBox: "0 0 10 10", refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto" });
      marker.appendChild(svgEl("path", { d: "M 0 1 L 9 5 L 0 9 z", fill: pal.dim }));
      defs.appendChild(marker);
      scene.appendChild(defs);
    }
    const status = isPerm
      ? "<b>permutation</b> n=" + N + " · <b>" + cand.data.cycles + "</b>" + (cand.data.cycles === 1 ? " cycle" : " cycles") + " (arcs show i → p[i])"
      : "<b>array</b> n=" + N + (finite.length === N ? " · min " + lo + " · max " + hi : "");
    return { w: ox * 2 + Math.min(N, perRow) * cs, h: oy + rowsCount * (cs + 16) + 20, status, handles };
  }

  function niceTicks(lo, hi, count) {
    const span = hi - lo || 1;
    const step = Math.pow(10, Math.floor(Math.log10(span / count)));
    const err = (span / count) / step;
    const mult = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
    const s = step * mult;
    const ticks = [];
    for (let v = Math.ceil(lo / s) * s; v <= hi + 1e-9; v += s) ticks.push(v);
    return ticks;
  }

  function renderIntervals(scene, cand, pal, o, ui) {
    const list = cand.data.list;
    if (list.length > 3000) return tooLarge(scene, pal, list.length + " intervals");
    let lo = Infinity, hi = -Infinity;
    for (const [l, r] of list) { lo = Math.min(lo, l, r); hi = Math.max(hi, l, r); }
    const span = hi - lo || 1;
    const W = 860, ox = 36, bh = 15, gap = 6;
    const X = (v) => ox + ((v - lo) / span) * (W - 2 * ox);
    // greedy row packing preserving input order for tooltips
    const rowEnds = [];
    const rowOf = list.map(([l, r]) => {
      for (let i = 0; i < rowEnds.length; i++) {
        if (l > rowEnds[i]) { rowEnds[i] = Math.max(l, r); return i; }
      }
      rowEnds.push(Math.max(l, r));
      return rowEnds.length - 1;
    });
    const oy = 26;
    list.forEach(([l, r], i) => {
      const y = oy + rowOf[i] * (bh + gap);
      const x1 = X(Math.min(l, r)), x2 = X(Math.max(l, r));
      const rect = svgEl("rect", { x: x1, y, width: Math.max(2.5, x2 - x1), height: bh, rx: 3, fill: cycHue(i), "fill-opacity": 0.62, stroke: pal.border, "stroke-width": 0.5 });
      scene.appendChild(rect);
      if (x2 - x1 > 58) {
        const t = svgEl("text", { x: (x1 + x2) / 2, y: y + bh / 2, dy: "0.34em", "text-anchor": "middle", "font-size": 9.5, fill: pal.bg, "font-family": "ui-monospace, Menlo, Consolas, monospace" });
        t.textContent = "[" + l + "," + r + "]";
        scene.appendChild(t);
      }
      rect.addEventListener("pointerenter", () => ui.tip("#" + (i + 1) + "  [" + l + ", " + r + "]\nlen " + (Math.abs(r - l))));
      rect.addEventListener("pointerleave", () => ui.tip(null));
    });
    const axisY = oy + rowEnds.length * (bh + gap) + 14;
    scene.appendChild(svgEl("line", { x1: ox, y1: axisY, x2: W - ox, y2: axisY, stroke: pal.dim, "stroke-width": 1 }));
    for (const v of niceTicks(lo, hi, 8)) {
      const x = X(v);
      scene.appendChild(svgEl("line", { x1: x, y1: axisY - 3, x2: x, y2: axisY + 3, stroke: pal.dim, "stroke-width": 1 }));
      const t = svgEl("text", { x, y: axisY + 15, "text-anchor": "middle", "font-size": 10, fill: pal.dim, "font-family": "ui-monospace, Menlo, Consolas, monospace" });
      t.textContent = String(Math.round(v * 1000) / 1000);
      scene.appendChild(t);
    }
    return { w: W, h: axisY + 30, status: "<b>intervals</b> " + list.length + " · range [" + lo + ", " + hi + "] · " + rowEnds.length + " packed rows" };
  }

  function renderPoints(scene, cand, pal, o, ui) {
    const pts = cand.data.pts;
    if (pts.length > 20000) return tooLarge(scene, pal, pts.length + " points");
    let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
    for (const [x, y] of pts) { xlo = Math.min(xlo, x); xhi = Math.max(xhi, x); ylo = Math.min(ylo, y); yhi = Math.max(yhi, y); }
    const xs = xhi - xlo || 1, ysp = yhi - ylo || 1;
    const W = 760, H = 560, pad = 52;
    const X = (v) => pad + ((v - xlo) / xs) * (W - 2 * pad);
    const Y = (v) => H - pad - ((v - ylo) / ysp) * (H - 2 * pad); // math orientation
    // axes at 0 when in range, else at the low edge
    const ax = xlo <= 0 && 0 <= xhi ? X(0) : pad;
    const ay = ylo <= 0 && 0 <= yhi ? Y(0) : H - pad;
    scene.appendChild(svgEl("line", { x1: pad - 12, y1: ay, x2: W - pad + 12, y2: ay, stroke: pal.dim, "stroke-width": 1, "stroke-opacity": 0.7 }));
    scene.appendChild(svgEl("line", { x1: ax, y1: pad - 12, x2: ax, y2: H - pad + 12, stroke: pal.dim, "stroke-width": 1, "stroke-opacity": 0.7 }));
    for (const v of niceTicks(xlo, xhi, 7)) {
      const t = svgEl("text", { x: X(v), y: ay + 15, "text-anchor": "middle", "font-size": 10, fill: pal.dim, "font-family": "ui-monospace, Menlo, Consolas, monospace" });
      t.textContent = String(Math.round(v * 1000) / 1000);
      scene.appendChild(t);
    }
    for (const v of niceTicks(ylo, yhi, 7)) {
      const t = svgEl("text", { x: ax - 7, y: Y(v), dy: "0.34em", "text-anchor": "end", "font-size": 10, fill: pal.dim, "font-family": "ui-monospace, Menlo, Consolas, monospace" });
      t.textContent = String(Math.round(v * 1000) / 1000);
      scene.appendChild(t);
    }
    pts.forEach(([x, y], i) => {
      const c = svgEl("circle", { cx: X(x), cy: Y(y), r: pts.length > 500 ? 2 : 3.6, fill: pal.accent, "fill-opacity": 0.85, stroke: pal.bg, "stroke-width": 0.8 });
      scene.appendChild(c);
      c.addEventListener("pointerenter", () => ui.tip("#" + (i + 1) + "  (" + x + ", " + y + ")"));
      c.addEventListener("pointerleave", () => ui.tip(null));
    });
    return { w: W, h: H, status: "<b>points</b> " + pts.length + " · x [" + xlo + ", " + xhi + "] · y [" + ylo + ", " + yhi + "]" };
  }

  function renderString(scene, cand, pal, o, ui) {
    const chars = cand.data.chars;
    const N = chars.length;
    if (N > 20000) return tooLarge(scene, pal, "string of length " + N);
    const isBracket = cand.data.isBracket;
    const dispIdx = (i) => i + (o.base === 0 ? 0 : 1);

    // bracket matching: pair positions, nesting depth, unmatched marks
    const OPEN = { "(": ")", "[": "]", "{": "}" };
    const CLOSE = { ")": "(", "]": "[", "}": "{" };
    let match = null, depth = null, pairs = 0, maxDepth = 0, unmatched = 0;
    if (isBracket) {
      match = new Array(N).fill(-1);
      depth = new Array(N).fill(0);
      const stack = [];
      for (let i = 0; i < N; i++) {
        const ch = chars[i];
        if (OPEN[ch]) {
          stack.push(i);
          depth[i] = stack.length;
          maxDepth = Math.max(maxDepth, stack.length);
        } else if (CLOSE[ch] && stack.length && chars[stack[stack.length - 1]] === CLOSE[ch]) {
          const j = stack.pop();
          match[i] = j;
          match[j] = i;
          depth[i] = depth[j];
          pairs++;
        }
      }
      for (let i = 0; i < N; i++) if ("()[]{}".includes(chars[i]) && match[i] === -1) unmatched++;
    }

    const strip = N <= 400;
    const cs = strip ? clamp(Math.floor(920 / N), 12, 30) : 16;
    const perRow = strip ? N : Math.max(1, Math.floor(920 / cs));
    const rowsCount = Math.ceil(N / perRow);
    const drawArcs = isBracket && strip && N <= 240;
    const arcRoom = drawArcs ? clamp(N * cs * 0.14, 36, 170) : 0;
    const ox = 30, oy = 32 + arcRoom;
    const handles = { cells: new Map() };
    for (let i = 0; i < N; i++) {
      const ri = Math.floor(i / perRow), ci = i % perRow;
      const x = ox + ci * cs, y = oy + ri * (cs + 14);
      const ch = chars[i];
      let fill, unmatchedHere = false;
      if (isBracket) {
        if ("()[]{}".includes(ch) && match[i] === -1) { fill = pal.bad; unmatchedHere = true; }
        else if (depth[i] > 0) fill = cycHue((depth[i] - 1) * 2);
        else fill = null;
      } else {
        fill = charColor(ch, pal);
      }
      const rect = svgEl("rect", { x, y, width: cs - 2, height: cs - 2, rx: 3, fill: fill || pal.panel2, "fill-opacity": fill ? (unmatchedHere ? 0.9 : 0.55) : 0.7, stroke: pal.border, "stroke-width": 0.7 });
      scene.appendChild(rect);
      let textEl = null;
      if (cs >= 11) {
        textEl = svgEl("text", { x: x + (cs - 2) / 2, y: y + (cs - 2) / 2, dy: "0.34em", "text-anchor": "middle", "font-size": Math.floor(cs * 0.62), fill: pal.fg, "font-weight": 600, "font-family": "ui-monospace, Menlo, Consolas, monospace" });
        textEl.textContent = ch;
        scene.appendChild(textEl);
      }
      const stepIdx = Math.max(1, Math.ceil(perRow / 30));
      if (ci % stepIdx === 0) {
        const idx = svgEl("text", { x: x + (cs - 2) / 2, y: y - 4, "text-anchor": "middle", "font-size": 9, fill: pal.dim, "font-family": "ui-monospace, Menlo, Consolas, monospace" });
        idx.textContent = String(dispIdx(i));
        scene.appendChild(idx);
      }
      handles.cells.set(String(dispIdx(i)), { el: rect, textEl });
      rect.addEventListener("pointerenter", () => {
        let tip = "s[" + dispIdx(i) + "] = '" + ch + "'";
        if (isBracket) {
          if (match && match[i] >= 0) tip += "\nmatches s[" + dispIdx(match[i]) + "] · depth " + depth[i];
          else if ("()[]{}".includes(ch)) tip += "\nunmatched";
        }
        ui.tip(tip);
      });
      rect.addEventListener("pointerleave", () => ui.tip(null));
    }
    if (drawArcs) {
      for (let i = 0; i < N; i++) {
        if (match[i] <= i) continue; // draw once per pair, from the open bracket
        const j = match[i];
        const x1 = ox + i * cs + (cs - 2) / 2, x2 = ox + j * cs + (cs - 2) / 2;
        const y0 = oy - 12;
        const lift = clamp((x2 - x1) * 0.3, 10, arcRoom - 6);
        scene.appendChild(svgEl("path", {
          d: "M " + x1 + " " + y0 + " Q " + ((x1 + x2) / 2) + " " + (y0 - lift) + " " + x2 + " " + y0,
          fill: "none", stroke: cycHue((depth[i] - 1) * 2), "stroke-width": 1.6, "stroke-opacity": 0.85
        }));
      }
    }
    const status = isBracket
      ? "<b>bracket string</b> n=" + N + " · <b>" + pairs + "</b> matched pairs · " + (unmatched ? "<span class=\"cvz-warn\">" + unmatched + " unmatched</span>" : "0 unmatched") + " · depth " + maxDepth
      : "<b>string</b> n=" + N;
    return { w: ox * 2 + Math.min(N, perRow) * cs, h: oy + rowsCount * (cs + 14) + 16, status, handles };
  }

  function renderStrings(scene, cand, pal, o, ui) {
    const list = cand.data.list;
    const total = list.reduce((a, s) => a + s.length, 0);
    if (total > 40000) return tooLarge(scene, pal, list.length + " strings, " + total + " chars");
    const maxLen = Math.max(...list.map((s) => s.length), 1);
    const cs = clamp(Math.floor(880 / maxLen), 8, 26);
    const ox = 52, oy = 30;
    const rowH = cs + 12;
    const handles = { cells: new Map() };
    const stepIdx = Math.max(1, Math.ceil(maxLen / 30));
    for (let j = 0; j < maxLen; j += stepIdx) {
      const idx = svgEl("text", { x: ox + j * cs + (cs - 2) / 2, y: oy - 8, "text-anchor": "middle", "font-size": 9, fill: pal.dim, "font-family": "ui-monospace, Menlo, Consolas, monospace" });
      idx.textContent = String(j + 1);
      scene.appendChild(idx);
    }
    list.forEach((chars, r) => {
      const y = oy + r * rowH;
      const lab = svgEl("text", { x: ox - 10, y: y + (cs - 2) / 2, dy: "0.34em", "text-anchor": "end", "font-size": Math.min(11, cs), fill: pal.dim, "font-family": "ui-monospace, Menlo, Consolas, monospace" });
      lab.textContent = "s" + (r + 1);
      scene.appendChild(lab);
      chars.forEach((ch, j) => {
        const x = ox + j * cs;
        const fill = charColor(ch, pal);
        const rect = svgEl("rect", { x, y, width: cs - 2, height: cs - 2, rx: 3, fill: fill || pal.panel2, "fill-opacity": fill ? 0.55 : 0.7, stroke: pal.border, "stroke-width": 0.7 });
        scene.appendChild(rect);
        let textEl = null;
        if (cs >= 11) {
          textEl = svgEl("text", { x: x + (cs - 2) / 2, y: y + (cs - 2) / 2, dy: "0.34em", "text-anchor": "middle", "font-size": Math.floor(cs * 0.62), fill: pal.fg, "font-weight": 600, "font-family": "ui-monospace, Menlo, Consolas, monospace" });
          textEl.textContent = ch;
          scene.appendChild(textEl);
        }
        handles.cells.set((r + 1) + ":" + (j + 1), { el: rect, textEl });
        rect.addEventListener("pointerenter", () => ui.tip("s" + (r + 1) + "[" + (j + 1) + "] = '" + ch + "'"));
        rect.addEventListener("pointerleave", () => ui.tip(null));
      });
    });
    return {
      w: ox + maxLen * cs + 30, h: oy + list.length * rowH + 16,
      status: "<b>" + list.length + " strings</b> · lengths " + list.map((s) => s.length).join(", ").slice(0, 60),
      handles
    };
  }

  function renderTokens(scene, cand, pal, o, ui) {
    const rows = cand.data.lines.slice(0, 400);
    const raw = cand.data.raw;
    const lh = 24, ox = 46;
    let maxW = 200;
    rows.forEach((tks, i) => {
      const y = 22 + i * lh;
      const ln = svgEl("text", { x: ox - 10, y, "text-anchor": "end", "font-size": 10, fill: pal.dim, "font-family": "ui-monospace, Menlo, Consolas, monospace" });
      ln.textContent = String(i + 1);
      scene.appendChild(ln);
      let x = ox;
      for (const tk of tks.length ? tks : [raw[i] || ""]) {
        const w = tk.length * 7.4 + 12;
        const rect = svgEl("rect", { x, y: y - 13, width: w, height: 18, rx: 4, fill: isNum(tk) ? pal.accent : pal.panel2, "fill-opacity": isNum(tk) ? 0.28 : 0.7, stroke: pal.border, "stroke-width": 0.6 });
        scene.appendChild(rect);
        const t = svgEl("text", { x: x + w / 2, y: y - 13 + 9, dy: "0.34em", "text-anchor": "middle", "font-size": 11, fill: pal.fg, "font-family": "ui-monospace, Menlo, Consolas, monospace" });
        t.textContent = tk;
        scene.appendChild(t);
        x += w + 5;
      }
      maxW = Math.max(maxW, x);
    });
    const truncated = cand.data.lines.length > 400;
    return {
      w: maxW + 20, h: 30 + rows.length * lh,
      status: "<b>tokens</b> · " + cand.data.lines.length + " lines" + (truncated ? " · <span class=\"cvz-warn\">showing first 400</span>" : "")
    };
  }

  function tooLarge(scene, pal, what) {
    const t = svgEl("text", { x: 20, y: 40, "font-size": 14, fill: pal.warn, "font-family": "ui-monospace, Menlo, Consolas, monospace" });
    t.textContent = "Too large to draw: " + what;
    scene.appendChild(t);
    const s = svgEl("text", { x: 20, y: 64, "font-size": 12, fill: pal.dim });
    s.textContent = "Switch the type to “tokens” for a raw view, or edit the input down.";
    scene.appendChild(s);
    return { w: 560, h: 100, status: "<span class=\"cvz-warn\">too large to draw — " + what + "</span>" };
  }

  const RENDERERS = {
    graph: renderNodeLink,
    tree: renderNodeLink,
    grid: renderGrid,
    matrix: renderMatrix,
    array: renderArray,
    perm: renderArray,
    string: renderString,
    strings: renderStrings,
    intervals: renderIntervals,
    points: renderPoints,
    tokens: renderTokens
  };

  const TYPE_LABELS = {
    auto: "Auto", graph: "Graph", tree: "Tree", grid: "Grid", matrix: "Matrix",
    array: "Array", perm: "Permutation", string: "String", strings: "Strings", intervals: "Intervals", points: "Points", tokens: "Tokens"
  };

  // ---- execution trace (#cpos stderr bus) -------------------------------------------
  // The local runner captures your program's stderr; any line starting with
  // "#cpos" is a trace event the player animates onto the drawn structure:
  //   #cpos visit u        highlight node u (graph/tree) or index u (array)
  //   #cpos visit r c      highlight grid/matrix cell (1-based row col)
  //   #cpos unvisit u [c]  restore it
  //   #cpos set i v        write value v into array cell i (and highlight)
  //   #cpos cell r c [v]   write/highlight a grid or matrix cell
  //   #cpos edge u v       highlight the edge u-v
  //   #cpos frame          end the current animation frame
  //   #cpos clear          reset all highlights
  // Everything else on stderr is ignored, so ordinary debug spam is harmless.
  const TRACE_EVENT_CAP = 20000;
  const TRACE_FRAME_CAP = 5000;
  function parseTrace(text) {
    const events = [];
    for (const ln of String(text || "").split(/\r?\n/)) {
      const m = ln.match(/^\s*#cpos\s+(.+)$/);
      if (!m) continue;
      const parts = m[1].trim().split(/\s+/);
      if (!parts[0]) continue;
      events.push({ op: parts[0].toLowerCase(), args: parts.slice(1) });
      if (events.length >= TRACE_EVENT_CAP) break;
    }
    const hasFrames = events.some((e) => e.op === "frame");
    const frames = [];
    let cur = [];
    for (const e of events) {
      if (e.op === "frame") { frames.push(cur); cur = []; continue; }
      cur.push(e);
      if (!hasFrames) { frames.push(cur); cur = []; }
      if (frames.length >= TRACE_FRAME_CAP) break;
    }
    if (cur.length && frames.length < TRACE_FRAME_CAP) frames.push(cur);
    return frames;
  }

  const TRACE_HELP =
    "▶ RUN executes your code on this sample and AUTO-TRACES it — no setup:\n" +
    "· Python/PyPy: every new variable, changed value and list/matrix\n" +
    "  mutation is captured line by line and replayed here.\n" +
    "· C/C++: array and matrix assignments (dp[i]=…, g[r][c]=…) and new\n" +
    "  scalar declarations are instrumented automatically before compiling.\n" +
    "Variables appear in a live watch panel; array/grid writes paint cells.\n\n" +
    "Want manual control instead? Print your own trace lines to stderr\n" +
    "(they override auto-tracing; judges never see stderr):\n" +
    "#cpos visit u        highlight node / array index / string position u\n" +
    "#cpos visit r c      highlight grid cell (row col, 1-based)\n" +
    "#cpos set i v        write v into array/string cell i\n" +
    "#cpos cell r c v     write v into a grid/matrix cell\n" +
    "#cpos edge u v       highlight edge u-v\n" +
    "#cpos var name v     upsert a row in the variables panel\n" +
    "#cpos frame          end an animation frame\n" +
    "#cpos clear          reset highlights\n\n" +
    "Keyboard (click the drawing first):\n" +
    "← → or { }  prev/next case    ↑ ↓ or [ ]  prev/next sample\n" +
    "space  play/pause trace   , .  step trace   r  run   f  re-fit   m  marker";
  const TRACE_MACRO_CPP = '#define VIZ(...) do{fprintf(stderr,"#cpos " __VA_ARGS__);fputc(\'\\n\',stderr);}while(0)\n// VIZ("visit %d",u); VIZ("cell %d %d %lld",r,c,dp[r][c]); VIZ("frame");';
  const TRACE_MACRO_PY = 'import sys\nviz = lambda *a: print("#cpos", *a, file=sys.stderr)\n# viz("visit", u); viz("set", i, dp[i]); viz("frame")';

  // ---- DOT export ------------------------------------------------------------------
  function toDot(cand, directed) {
    const { edges, base, n, weighted } = cand.data;
    const arrow = directed ? " -> " : " -- ";
    const head = directed ? "digraph G {" : "graph G {";
    const lines = [head];
    const used = new Set();
    for (const e of edges) {
      used.add(e[0]); used.add(e[1]);
      lines.push("  " + e[0] + arrow + e[1] + (e.length === 3 && weighted ? " [label=\"" + e[2] + "\"]" : "") + ";");
    }
    for (let i = base; i < base + n; i++) if (!used.has(i)) lines.push("  " + i + ";");
    lines.push("}");
    return lines.join("\n");
  }

  // ---- mount ----------------------------------------------------------------------
  function mount(container, opts) {
    opts = opts || {};
    injectStyle(container.ownerDocument || document);
    container.classList.add("cpos-viz");

    const state = {
      tests: [],
      si: 0,
      source: "input",           // input | expected
      caseIdx: 0,                // 0 = whole input; >=1 = case number
      seg: null,
      custom: null,              // text of the Custom pseudo-sample
      type: "auto",
      directed: false,
      weights: true,
      heat: true,
      bars: false,
      base: null,                // null = auto
      skip: 0,
      root: null,
      statementText: opts.statementText || "",
      label: opts.problemLabel || ""
    };

    // -- chrome
    const bar = domEl("div", "cvz-bar");
    const sampleSel = document.createElement("select");
    sampleSel.title = "Which sample test to draw";
    const srcBtn = domEl("button", "cvz-ic", "IN");
    srcBtn.title = "Visualize the input or the expected output";
    const casePrev = domEl("button", "cvz-ic", "‹");
    casePrev.title = "Previous case (also: { or ← after clicking the drawing)";
    casePrev.style.display = "none";
    const caseSel = document.createElement("select");
    caseSel.title = "Multi-testcase input: which case to draw ({ } or ← → to cycle)";
    caseSel.style.display = "none";
    const caseNext = domEl("button", "cvz-ic", "›");
    caseNext.title = "Next case (also: } or → after clicking the drawing)";
    caseNext.style.display = "none";
    const typeSel = document.createElement("select");
    typeSel.title = "Structure type (Auto infers it)";
    const runBtn = domEl("button", "cvz-ic cvz-primary", "▶ RUN");
    runBtn.title = "Run your code on this sample and animate its #cpos stderr trace (press ? for the grammar)";
    if (!opts.runTrace) runBtn.style.display = "none";
    const helpBtn = domEl("button", "cvz-ic", "?");
    helpBtn.title = "How to animate your own algorithm on this drawing";
    const markBtn = domEl("button", "cvz-ic", "✏");
    markBtn.title = "Marker — draw freehand on the visualization (m). Drawings survive pan/zoom and export, and clear when the structure changes.";
    const inkTools = domEl("span", "cvz-ink");
    const inkDots = [];
    ["accent", "bad", "ok"].forEach((key, i) => {
      const dot = domEl("button", "cvz-dot" + (i === 0 ? " on" : ""));
      dot.dataset.ink = key;
      dot.title = "Marker color";
      inkTools.appendChild(dot);
      inkDots.push(dot);
    });
    const inkClear = domEl("button", "cvz-ic", "✕");
    inkClear.title = "Erase all marker drawings";
    inkTools.appendChild(inkClear);
    const editBtn = domEl("button", "cvz-ic", "✎");
    editBtn.title = "Edit / paste input";
    const optsBtn = domEl("button", "cvz-ic", "⚙");
    optsBtn.title = "Options";
    const fitBtn = domEl("button", "cvz-ic", "⛶");
    fitBtn.title = "Fit to view";
    const dotBtn = domEl("button", "cvz-ic", "DOT");
    dotBtn.title = "Copy graph as Graphviz DOT";
    const svgBtn = domEl("button", "cvz-ic", "SVG");
    svgBtn.title = "Download as SVG";
    bar.appendChild(sampleSel);
    bar.appendChild(srcBtn);
    bar.appendChild(casePrev);
    bar.appendChild(caseSel);
    bar.appendChild(caseNext);
    bar.appendChild(typeSel);
    bar.appendChild(runBtn);
    bar.appendChild(helpBtn);
    bar.appendChild(domEl("span", "cvz-grow"));
    bar.appendChild(inkTools);
    bar.appendChild(markBtn);
    bar.appendChild(editBtn);
    bar.appendChild(optsBtn);
    bar.appendChild(fitBtn);
    bar.appendChild(dotBtn);
    bar.appendChild(svgBtn);

    const edit = domEl("div", "cvz-edit");
    const ta = document.createElement("textarea");
    ta.spellcheck = false;
    ta.placeholder = "Paste any test input here…";
    edit.appendChild(ta);

    const stage = domEl("div", "cvz-stage");
    const svg = svgEl("svg", { preserveAspectRatio: "xMidYMid meet" });
    const scene = svgEl("g");
    svg.appendChild(scene);
    // Marker drawings live above the scene and are NOT wiped by re-renders;
    // layouts are deterministic, so world coordinates stay valid until the
    // structure itself changes (reparse clears them).
    const inkLayer = svgEl("g");
    svg.appendChild(inkLayer);
    const tipEl = domEl("div", "cvz-tip");
    const emptyEl = domEl("div", "cvz-empty");
    emptyEl.style.display = "none";
    stage.appendChild(svg);
    stage.appendChild(tipEl);
    stage.appendChild(emptyEl);

    // Loud, on-canvas feedback — errors must never hide in the status strip.
    const flashEl = domEl("div", "cvz-flash");
    stage.appendChild(flashEl);
    let flashTimer = null;
    function flash(msg, isErr) {
      flashEl.textContent = msg;
      flashEl.classList.toggle("err", !!isErr);
      flashEl.classList.add("open");
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => flashEl.classList.remove("open"), isErr ? 9000 : 3500);
    }
    flashEl.addEventListener("click", () => flashEl.classList.remove("open"));

    // options popover
    const pop = domEl("div", "cvz-opts");
    pop.innerHTML =
      '<span class="cvz-sec">Graph</span>' +
      '<label><input type="checkbox" data-k="directed"> directed (arrows)</label>' +
      '<label><input type="checkbox" data-k="weights" checked> edge weights</label>' +
      '<span class="cvz-sec">Cells</span>' +
      '<label><input type="checkbox" data-k="heat" checked> heatmap fill</label>' +
      '<label><input type="checkbox" data-k="bars"> bar chart (arrays)</label>' +
      '<span class="cvz-sec">Parsing</span>' +
      '<label>indexing <select data-k="base"><option value="">auto</option><option value="0">0-based</option><option value="1">1-based</option></select></label>' +
      '<label>skip first <input type="number" data-k="skip" min="0" max="99" value="0"> lines</label>';
    stage.appendChild(pop);

    const status = domEl("div", "cvz-status");

    // trace playback bar (hidden until a trace is loaded)
    const traceBar = domEl("div", "cvz-trace");
    traceBar.innerHTML =
      '<button class="cvz-ic" data-t="first" title="Reset to start">⏮</button>' +
      '<button class="cvz-ic" data-t="prev" title="Step back">◀</button>' +
      '<button class="cvz-ic" data-t="play" title="Play / pause">▶</button>' +
      '<button class="cvz-ic" data-t="next" title="Step forward">⏵⏵</button>' +
      '<input type="range" min="0" max="0" value="0" step="1">' +
      '<span class="cvz-tlabel">0/0</span>' +
      '<select title="Playback speed"><option value="700">0.5×</option><option value="350" selected>1×</option><option value="140">2.5×</option><option value="60">6×</option></select>' +
      '<button class="cvz-ic" data-t="close" title="Discard trace">✕</button>';

    // trace help overlay
    const help = domEl("div", "cvz-help");
    {
      const head = domEl("div", "cvz-hrow");
      head.appendChild(domEl("b", null, "Animate your algorithm on this drawing"));
      const grow = domEl("span", "cvz-grow");
      const closeH = domEl("button", null, "✕");
      closeH.onclick = () => help.classList.remove("open");
      head.appendChild(grow);
      head.appendChild(closeH);
      help.appendChild(head);
      const pre = document.createElement("pre");
      pre.textContent = TRACE_HELP;
      help.appendChild(pre);
      for (const [name, macro] of [["C++ macro", TRACE_MACRO_CPP], ["Python helper", TRACE_MACRO_PY]]) {
        const row = domEl("div", "cvz-hrow");
        row.appendChild(domEl("b", null, name));
        row.appendChild(domEl("span", "cvz-grow"));
        const copy = domEl("button", null, "copy");
        copy.onclick = async () => {
          try { await navigator.clipboard.writeText(macro); copy.textContent = "✓"; setTimeout(() => { copy.textContent = "copy"; }, 900); } catch (_) {}
        };
        row.appendChild(copy);
        help.appendChild(row);
        const mpre = document.createElement("pre");
        mpre.textContent = macro;
        help.appendChild(mpre);
      }
      stage.appendChild(help);
    }
    helpBtn.addEventListener("click", () => help.classList.toggle("open"));

    container.appendChild(bar);
    container.appendChild(traceBar);
    container.appendChild(edit);
    container.appendChild(stage);
    container.appendChild(status);

    // -- view (pan/zoom on the svg viewBox)
    const view = { x: 0, y: 0, w: 100, h: 100, fitW: 100, fitH: 100 };
    function applyView() {
      svg.setAttribute("viewBox", view.x + " " + view.y + " " + view.w + " " + view.h);
    }
    function fit(worldW, worldH) {
      const box = stage.getBoundingClientRect();
      const ar = box.width > 0 && box.height > 0 ? box.width / box.height : 1.6;
      let w = worldW, h = worldH;
      if (w / h < ar) w = h * ar; else h = w / ar;
      view.x = -(w - worldW) / 2;
      view.y = -(h - worldH) / 2;
      view.w = w; view.h = h;
      view.fitW = w; view.fitH = h;
      applyView();
    }
    function toWorld(clientX, clientY) {
      const box = svg.getBoundingClientRect();
      return {
        x: view.x + ((clientX - box.left) / box.width) * view.w,
        y: view.y + ((clientY - box.top) / box.height) * view.h
      };
    }
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const pt = toWorld(e.clientX, e.clientY);
      const f = e.deltaY > 0 ? 1.13 : 1 / 1.13;
      const nw = clamp(view.w * f, view.fitW / 14, view.fitW * 6);
      const scale = nw / view.w;
      view.x = pt.x - (pt.x - view.x) * scale;
      view.y = pt.y - (pt.y - view.y) * scale;
      view.w *= scale; view.h *= scale;
      applyView();
    }, { passive: false });
    // -- marker (freehand ink over the drawing) --------------------------------
    let markerOn = false;
    let inkColorKey = "accent";
    function setMarker(on) {
      markerOn = on;
      markBtn.classList.toggle("on", on);
      inkTools.classList.toggle("open", on);
      svg.classList.toggle("inking", on);
    }
    markBtn.addEventListener("click", () => setMarker(!markerOn));
    inkDots.forEach((dot) => {
      dot.addEventListener("click", () => {
        inkColorKey = dot.dataset.ink;
        inkDots.forEach((d) => d.classList.toggle("on", d === dot));
      });
    });
    inkClear.addEventListener("click", () => { inkLayer.innerHTML = ""; });
    function paintInkDots() {
      const pal = resolvePalette(container);
      inkDots.forEach((d) => { d.style.background = pal[d.dataset.ink]; });
    }

    svg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (markerOn) {
        e.preventDefault();
        const pal = resolvePalette(container);
        const pts = [];
        const pt0 = toWorld(e.clientX, e.clientY);
        pts.push(pt0);
        const path = svgEl("path", {
          fill: "none", stroke: pal[inkColorKey] || pal.accent,
          "stroke-width": Math.max(view.w * 0.004, 0.8),
          "stroke-linecap": "round", "stroke-linejoin": "round",
          "stroke-opacity": 0.9
        });
        const d = () => "M " + pts.map((p) => p.x.toFixed(1) + " " + p.y.toFixed(1)).join(" L ");
        path.setAttribute("d", d());
        inkLayer.appendChild(path);
        const minStep = view.w * 0.002;
        const move = (mv) => {
          const p = toWorld(mv.clientX, mv.clientY);
          const last = pts[pts.length - 1];
          if (Math.hypot(p.x - last.x, p.y - last.y) < minStep) return;
          pts.push(p);
          path.setAttribute("d", d());
        };
        const up = () => {
          // a bare click leaves a visible dot rather than an invisible path
          if (pts.length === 1) {
            path.remove();
            inkLayer.appendChild(svgEl("circle", { cx: pt0.x, cy: pt0.y, r: Math.max(view.w * 0.004, 1), fill: pal[inkColorKey] || pal.accent, "fill-opacity": 0.9 }));
          }
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        return;
      }
      const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
      svg.classList.add("panning");
      const box = svg.getBoundingClientRect();
      const move = (mv) => {
        view.x = start.vx - ((mv.clientX - start.x) / box.width) * view.w;
        view.y = start.vy - ((mv.clientY - start.y) / box.height) * view.h;
        applyView();
      };
      const up = () => {
        svg.classList.remove("panning");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });

    function tip(text) {
      if (text == null) { tipEl.style.display = "none"; return; }
      tipEl.textContent = text;
      tipEl.style.display = "block";
    }
    stage.addEventListener("pointermove", (e) => {
      if (tipEl.style.display === "none") return;
      const box = stage.getBoundingClientRect();
      let x = e.clientX - box.left + 14, y = e.clientY - box.top + 12;
      if (x + tipEl.offsetWidth > box.width - 6) x = e.clientX - box.left - tipEl.offsetWidth - 10;
      if (y + tipEl.offsetHeight > box.height - 6) y = e.clientY - box.top - tipEl.offsetHeight - 8;
      tipEl.style.left = x + "px";
      tipEl.style.top = y + "px";
    });

    // -- data plumbing
    function normTests(tests) {
      return (tests || []).map((t) => ({
        input: String(t.input != null ? t.input : ""),
        expected: String(t.expected != null ? t.expected : (t.expected_output != null ? t.expected_output : "")),
        blocks: Array.isArray(t.input_block_sizes) ? t.input_block_sizes : null
      }));
    }
    function currentRaw() {
      if (state.si === -1) return state.custom || "";
      const t = state.tests[state.si];
      if (!t) return "";
      return state.source === "expected" ? t.expected : t.input;
    }
    function currentBlocks() {
      if (state.si === -1 || state.source === "expected") return null;
      const t = state.tests[state.si];
      return t ? t.blocks : null;
    }

    let lastCand = null;
    let lastHandles = null;

    // -- trace player ---------------------------------------------------------
    let trace = null; // { frames, cur, timer }
    const tBtns = traceBar.querySelectorAll("button");
    const tFirst = tBtns[0], tPrev = tBtns[1], tPlay = tBtns[2], tNext = tBtns[3], tClose = tBtns[4];
    const tSlider = traceBar.querySelector("input[type=range]");
    const tLabel = traceBar.querySelector(".cvz-tlabel");
    const tSpeed = traceBar.querySelector("select");
    const touched = new Map(); // element → original paint attributes

    // Live variables — `#cpos var name value` events (emitted by the
    // auto-tracer or by hand) build a watch table over the drawing.
    const varsBox = domEl("div", "cvz-vars");
    stage.appendChild(varsBox);
    const varsState = new Map();
    let varsFresh = new Set();
    function renderVars() {
      if (!varsState.size) { varsBox.classList.remove("open"); return; }
      varsBox.classList.add("open");
      let html = '<div class="cvz-vh">variables</div>';
      let shown = 0;
      for (const [name, value] of varsState) {
        if (++shown > 24) { html += '<div class="cvz-vrow">… +' + (varsState.size - 24) + " more</div>"; break; }
        html += '<div class="cvz-vrow' + (varsFresh.has(name) ? " fresh" : "") + '"><b>' + esc(name) + '</b> = <span>' + esc(value) + "</span></div>";
      }
      varsBox.innerHTML = html;
    }
    function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

    function remember(el) {
      if (!el || touched.has(el)) return;
      touched.set(el, {
        fill: el.getAttribute("fill"),
        fo: el.getAttribute("fill-opacity"),
        stroke: el.getAttribute("stroke"),
        sw: el.getAttribute("stroke-width"),
        text: el.tagName && el.tagName.toLowerCase() === "text" ? el.textContent : null
      });
    }
    function restoreEl(el) {
      const s = touched.get(el);
      if (!s) return;
      const put = (name, v) => { if (v != null) el.setAttribute(name, v); else el.removeAttribute(name); };
      put("fill", s.fill); put("fill-opacity", s.fo); put("stroke", s.stroke); put("stroke-width", s.sw);
      if (s.text != null) el.textContent = s.text;
      touched.delete(el);
    }
    function resetPaint() {
      for (const el of [...touched.keys()]) restoreEl(el);
    }
    function paintShape(h, pal, value) {
      if (!h) return;
      remember(h.el);
      h.el.setAttribute("fill", pal.accent);
      h.el.setAttribute("fill-opacity", "0.95");
      if (h.textEl) {
        remember(h.textEl);
        h.textEl.setAttribute("fill", pal.bg);
        if (value != null) h.textEl.textContent = String(value);
      }
    }
    function unpaintShape(h) {
      if (!h) return;
      restoreEl(h.el);
      if (h.textEl) restoreEl(h.textEl);
    }
    function applyEvent(e, pal) {
      const H = lastHandles || {};
      const a = e.args;
      switch (e.op) {
        case "visit":
        case "mark": {
          if (a.length >= 2 && H.cells && H.cells.has(a[0] + ":" + a[1])) paintShape(H.cells.get(a[0] + ":" + a[1]), pal);
          else if (H.nodes && H.nodes.has(a[0])) paintShape(H.nodes.get(a[0]), pal);
          else if (H.cells && H.cells.has(a[0])) paintShape(H.cells.get(a[0]), pal);
          break;
        }
        case "unvisit": {
          if (a.length >= 2 && H.cells && H.cells.has(a[0] + ":" + a[1])) unpaintShape(H.cells.get(a[0] + ":" + a[1]));
          else if (H.nodes && H.nodes.has(a[0])) unpaintShape(H.nodes.get(a[0]));
          else if (H.cells && H.cells.has(a[0])) unpaintShape(H.cells.get(a[0]));
          break;
        }
        case "cell": {
          if (H.cells && a.length >= 2) paintShape(H.cells.get(a[0] + ":" + a[1]), pal, a.length >= 3 ? a.slice(2).join(" ") : null);
          break;
        }
        case "set": {
          if (H.cells && a.length >= 1) paintShape(H.cells.get(a[0]), pal, a.length >= 2 ? a.slice(1).join(" ") : null);
          break;
        }
        case "edge": {
          if (H.edges && a.length >= 2) {
            const h = H.edges.get(edgeKey(Number(a[0]), Number(a[1])));
            if (h) {
              remember(h.el);
              h.el.setAttribute("stroke", pal.accent);
              h.el.setAttribute("stroke-width", "3");
            }
          }
          break;
        }
        case "var": {
          if (a.length >= 1) varsState.set(a[0], a.slice(1).join(" "));
          break;
        }
        case "clear": resetPaint(); break;
      }
    }
    function traceSeek(k) {
      if (!trace) return;
      k = clamp(k, 0, trace.frames.length);
      resetPaint();
      varsState.clear();
      const pal = resolvePalette(container);
      for (let f = 0; f < k; f++) {
        if (f === k - 1) {
          // remember which variables move in the final frame so they glow
          varsFresh = new Set();
          for (const e of trace.frames[f]) if (e.op === "var" && e.args.length) varsFresh.add(e.args[0]);
        }
        for (const e of trace.frames[f]) applyEvent(e, pal);
      }
      if (k === 0) varsFresh = new Set();
      renderVars();
      trace.cur = k;
      tSlider.value = String(k);
      tLabel.textContent = k + "/" + trace.frames.length;
    }
    function stopPlay() {
      if (trace && trace.timer) { clearInterval(trace.timer); trace.timer = null; }
      tPlay.textContent = "▶";
    }
    function startPlay() {
      if (!trace || !trace.frames.length) return;
      stopPlay();
      if (trace.cur >= trace.frames.length) traceSeek(0);
      trace.timer = setInterval(() => {
        if (!trace || trace.cur >= trace.frames.length) { stopPlay(); return; }
        traceSeek(trace.cur + 1);
      }, Number(tSpeed.value) || 350);
      tPlay.textContent = "⏸";
    }
    function closeTrace() {
      stopPlay();
      resetPaint();
      varsState.clear();
      renderVars();
      trace = null;
      traceBar.classList.remove("open");
    }
    function loadTrace(stderrText, autoplay) {
      closeTrace();
      const frames = parseTrace(stderrText);
      if (!frames.length) return 0;
      trace = { frames, cur: 0, timer: null };
      traceBar.classList.add("open");
      tSlider.max = String(frames.length);
      traceSeek(0);
      if (autoplay) startPlay();
      return frames.length;
    }
    tFirst.addEventListener("click", () => { stopPlay(); traceSeek(0); });
    tPrev.addEventListener("click", () => { stopPlay(); traceSeek((trace ? trace.cur : 0) - 1); });
    tPlay.addEventListener("click", () => { if (trace && trace.timer) stopPlay(); else startPlay(); });
    tNext.addEventListener("click", () => { stopPlay(); traceSeek((trace ? trace.cur : 0) + 1); });
    tClose.addEventListener("click", closeTrace);
    casePrev.addEventListener("click", () => setCase(state.caseIdx - 1));
    caseNext.addEventListener("click", () => setCase(state.caseIdx + 1));
    tSlider.addEventListener("input", () => { stopPlay(); traceSeek(Number(tSlider.value)); });
    tSpeed.addEventListener("change", () => { if (trace && trace.timer) startPlay(); });

    runBtn.addEventListener("click", async () => {
      if (!opts.runTrace) return;
      runBtn.disabled = true;
      const prevLabel = runBtn.textContent;
      runBtn.textContent = "…";
      status.innerHTML = "compiling + running your code on this sample…";
      flash("Compiling + running your code…");
      try {
        // When a specific case of a multi-test input is shown, run exactly that
        // case (re-headed with t=1) so trace indices match the drawing.
        let runInput = currentRaw();
        if (state.seg && state.caseIdx >= 1) {
          const lines = splitLines(currentRaw());
          const c = state.seg.cases[state.caseIdx - 1];
          runInput = "1\n" + lines.slice(c.from, c.to).join("\n") + "\n";
        }
        const res = await opts.runTrace(runInput);
        const verdict = res && res.verdict ? String(res.verdict) : "";
        const nFrames = loadTrace(res && res.stderr, true);
        if (!nFrames) {
          const outdatedRunner = res && res.traceSupported === false;
          const msg = outdatedRunner
            ? "The local runner ignored the auto-trace request — your CPOS VS Code extension is older than this visualizer. Update it to 0.6.0+ and reload the VS Code window, then hit RUN again."
            : "Run finished" + (verdict ? " (" + verdict + ")" : "")
              + " — no trace events came back. Auto-tracing works for Python and C/C++; "
              + "for other languages (or full control) print #cpos lines yourself — press ? for the grammar.";
          status.innerHTML = '<span class="cvz-warn">' + (outdatedRunner ? "runner outdated — reload VS Code" : "no trace in the run" + (verdict ? " (" + verdict + ")" : "")) + "</span>";
          flash(msg, true);
        } else {
          status.innerHTML = "<b>trace</b> " + nFrames + " frames" + (verdict ? " · verdict " + verdict : "") + " — playing (scrub below)";
          flash("Trace loaded: " + nFrames + " frames" + (verdict ? " · verdict " + verdict : ""));
        }
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        status.innerHTML = '<span class="cvz-warn">' + msg.replace(/</g, "&lt;") + "</span>";
        flash(msg, true);
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = prevLabel;
      }
    });

    function populateSamples() {
      sampleSel.innerHTML = "";
      state.tests.forEach((_, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = "Sample " + (i + 1);
        sampleSel.appendChild(o);
      });
      const custom = document.createElement("option");
      custom.value = "-1";
      custom.textContent = "Custom…";
      sampleSel.appendChild(custom);
      if (state.si >= state.tests.length) state.si = state.tests.length ? 0 : -1;
      sampleSel.value = String(state.si);
    }

    function populateCases() {
      const raw = currentRaw();
      state.seg = chooseSegmentation(splitLines(raw), currentBlocks(), hintBoosts(state.statementText));
      if (!state.seg) {
        state.caseIdx = 0;
        caseSel.style.display = casePrev.style.display = caseNext.style.display = "none";
        return;
      }
      caseSel.style.display = casePrev.style.display = caseNext.style.display = "";
      caseSel.innerHTML = "";
      const all = document.createElement("option");
      all.value = "0";
      all.textContent = "All (" + state.seg.t + " cases)";
      caseSel.appendChild(all);
      for (let i = 1; i <= state.seg.t; i++) {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = "Case " + i + "/" + state.seg.t;
        caseSel.appendChild(o);
      }
      if (state.caseIdx > state.seg.t) state.caseIdx = 1;
      if (state.caseIdx === 0 && state.seg.t >= 2) state.caseIdx = 1;
      caseSel.value = String(state.caseIdx);
    }

    function activeLines() {
      const lines = splitLines(currentRaw());
      let sel = lines;
      if (state.seg && state.caseIdx >= 1) {
        const c = state.seg.cases[state.caseIdx - 1];
        sel = lines.slice(c.from, c.to);
      }
      if (state.skip > 0) sel = sel.slice(state.skip);
      return sel;
    }

    function populateTypes(cands) {
      typeSel.innerHTML = "";
      const auto = document.createElement("option");
      auto.value = "auto";
      auto.textContent = "Auto — " + TYPE_LABELS[cands[0].type].toLowerCase();
      typeSel.appendChild(auto);
      const present = new Set();
      for (const c of cands) present.add(c.type);
      for (const t of ["graph", "tree", "grid", "matrix", "array", "perm", "string", "strings", "intervals", "points", "tokens"]) {
        const o = document.createElement("option");
        o.value = t;
        o.textContent = TYPE_LABELS[t] + (present.has(t) ? " ✓" : "");
        typeSel.appendChild(o);
      }
      typeSel.value = state.type;
    }

    function rerender() {
      scene.innerHTML = "";
      tip(null);
      paintInkDots();
      const raw = currentRaw();
      if (!raw.trim()) {
        emptyEl.style.display = "flex";
        emptyEl.textContent = state.tests.length
          ? "This sample is empty."
          : "No sample tests captured yet.\nOpen a problem page (or run a capture), or press ✎ and paste an input to visualize it.";
        status.innerHTML = "";
        populateTypes([parseTokens([""])]);
        return;
      }
      emptyEl.style.display = "none";
      const lines = activeLines();
      const boosts = hintBoosts(state.statementText);
      const cands = candidatesFor(lines, boosts);
      populateTypes(cands);
      let cand = cands[0];
      if (state.type !== "auto") {
        cand = cands.find((c) => c.type === state.type) || forceParse(state.type, lines) || parseTokens(lines);
      }
      lastCand = cand;
      dotBtn.style.display = cand.type === "graph" || cand.type === "tree" ? "" : "none";
      const pal = resolvePalette(container);
      // Functional graphs and other inherently directed inputs get arrows by
      // default; a user toggle always wins once touched.
      const autoDirected = !!(cand.data && cand.data.directed);
      const effDirected = state.directedTouched ? state.directed : (state.directed || autoDirected);
      const dirBox = pop.querySelector("input[data-k=directed]");
      if (dirBox) dirBox.checked = effDirected;
      const o = {
        directed: effDirected, weights: state.weights, heat: state.heat,
        bars: state.bars, base: state.base != null ? state.base : (cand.data && cand.data.base != null ? cand.data.base : 1),
        root: state.root, forceLayout: state.type === "graph" && cand.type === "tree"
      };
      let out;
      try {
        out = RENDERERS[cand.type](scene, cand, pal, o, ui);
      } catch (err) {
        scene.innerHTML = "";
        out = tooLarge(scene, pal, "render failed (" + (err && err.message ? err.message : err) + ")");
      }
      lastHandles = out.handles || null;
      fit(out.w, out.h);
      // A re-layout wipes the scene, so painted elements are gone; replay the
      // trace up to the current frame against the fresh handles.
      if (trace) {
        touched.clear();
        traceSeek(trace.cur);
      }
      const caseNote = state.seg && state.caseIdx >= 1 ? "case " + state.caseIdx + "/" + state.seg.t + " · " : (state.seg ? "multi-test · " : "");
      // Surface the parse note only when it says something the renderer's own
      // status line doesn't (e.g. "tree from parent array p2..pn").
      const extraNote = state.type === "auto" && cand.score > 0 && /parent array|no header|forced/.test(cand.note)
        ? " · <i>" + cand.note + "</i>" : "";
      status.innerHTML = caseNote + (out.status || "") + extraNote;
    }

    const ui = { svg, scene, tip, toWorld, rerender, isMarking: () => markerOn };

    function reparse() {
      state.root = null;
      closeTrace(); // the structure is changing; a stale trace makes no sense
      inkLayer.innerHTML = ""; // marker drawings belong to the old structure
      populateCases();
      rerender();
    }

    // -- toolbar events
    sampleSel.addEventListener("change", () => {
      state.si = Number(sampleSel.value);
      if (state.si === -1) {
        if (state.custom == null) state.custom = currentTestText() || "";
        ta.value = state.custom;
        edit.classList.add("open");
        editBtn.classList.add("on");
      }
      state.caseIdx = 0;
      reparse();
    });
    function currentTestText() {
      const t = state.tests[0];
      return t ? (state.source === "expected" ? t.expected : t.input) : "";
    }
    srcBtn.addEventListener("click", () => {
      state.source = state.source === "input" ? "expected" : "input";
      srcBtn.textContent = state.source === "input" ? "IN" : "OUT";
      srcBtn.classList.toggle("on", state.source === "expected");
      state.caseIdx = 0;
      reparse();
    });
    caseSel.addEventListener("change", () => {
      state.caseIdx = Number(caseSel.value);
      state.root = null;
      rerender();
    });
    typeSel.addEventListener("change", () => {
      state.type = typeSel.value;
      state.root = null;
      rerender();
    });
    editBtn.addEventListener("click", () => {
      const open = edit.classList.toggle("open");
      editBtn.classList.toggle("on", open);
      if (open) {
        ta.value = currentRaw();
        ta.focus();
      }
    });
    let taTimer = null;
    ta.addEventListener("input", () => {
      clearTimeout(taTimer);
      taTimer = setTimeout(() => {
        state.custom = ta.value;
        if (state.si !== -1) {
          state.si = -1;
          sampleSel.value = "-1";
        }
        reparse();
      }, 250);
    });
    optsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      pop.classList.toggle("open");
    });
    container.addEventListener("click", (e) => {
      if (!pop.contains(e.target) && e.target !== optsBtn) pop.classList.remove("open");
    });
    pop.querySelectorAll("input[type=checkbox]").forEach((inp) => {
      inp.addEventListener("change", () => {
        const k = inp.getAttribute("data-k");
        state[k] = inp.checked;
        if (k === "directed") state.directedTouched = true;
        rerender();
      });
    });
    pop.querySelector("select[data-k=base]").addEventListener("change", (e) => {
      const v = e.target.value;
      state.base = v === "" ? null : Number(v);
      rerender();
    });
    pop.querySelector("input[data-k=skip]").addEventListener("change", (e) => {
      state.skip = clamp(Number(e.target.value) || 0, 0, 99);
      state.root = null;
      rerender();
    });
    fitBtn.addEventListener("click", () => rerender());
    svgBtn.addEventListener("click", () => {
      const pal = resolvePalette(container);
      const clone = svg.cloneNode(true);
      clone.setAttribute("xmlns", SVGNS);
      const bgRect = svgEl("rect", { x: view.x, y: view.y, width: view.w, height: view.h, fill: pal.bg });
      clone.insertBefore(bgRect, clone.firstChild);
      const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "cpos-viz" + (state.label ? "-" + state.label.replace(/[^\w.-]+/g, "_") : "") + "-s" + (state.si + 1) + ".svg";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    dotBtn.addEventListener("click", async () => {
      if (!lastCand || (lastCand.type !== "graph" && lastCand.type !== "tree")) return;
      const dot = toDot(lastCand, state.directed);
      try {
        await navigator.clipboard.writeText(dot);
        dotBtn.textContent = "✓";
        setTimeout(() => { dotBtn.textContent = "DOT"; }, 900);
      } catch (_) { /* clipboard denied */ }
    });

    // -- keyboard macros --------------------------------------------------------
    // [ ] switch sample · { } switch case · space play/pause · , . step · f fit
    container.tabIndex = -1;
    container.style.outline = "none";
    stage.addEventListener("pointerdown", () => container.focus({ preventScroll: true }));
    function setSample(i) {
      if (!state.tests.length) return;
      i = ((i % state.tests.length) + state.tests.length) % state.tests.length;
      state.si = i;
      sampleSel.value = String(i);
      state.caseIdx = 0;
      reparse();
    }
    function setCase(k) {
      if (!state.seg) return;
      k = ((k - 1 + state.seg.t) % state.seg.t) + 1;
      state.caseIdx = k;
      caseSel.value = String(k);
      state.root = null;
      rerender();
    }
    container.addEventListener("keydown", (e) => {
      const tag = e.target && e.target.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case "[": setSample((state.si < 0 ? 0 : state.si) - 1); break;
        case "]": setSample((state.si < 0 ? -1 : state.si) + 1); break;
        case "{": setCase(state.caseIdx - 1); break;
        case "}": setCase(state.caseIdx + 1); break;
        case "ArrowLeft": if (state.seg) setCase(state.caseIdx - 1); else setSample((state.si < 0 ? 0 : state.si) - 1); break;
        case "ArrowRight": if (state.seg) setCase(state.caseIdx + 1); else setSample((state.si < 0 ? -1 : state.si) + 1); break;
        case "ArrowUp": setSample((state.si < 0 ? 0 : state.si) - 1); break;
        case "ArrowDown": setSample((state.si < 0 ? -1 : state.si) + 1); break;
        case " ": if (trace) { if (trace.timer) stopPlay(); else startPlay(); } break;
        case ",": if (trace) { stopPlay(); traceSeek(trace.cur - 1); } break;
        case ".": if (trace) { stopPlay(); traceSeek(trace.cur + 1); } break;
        case "f": rerender(); break;
        case "m": setMarker(!markerOn); break;
        case "r": if (opts.runTrace && !runBtn.disabled) runBtn.click(); break;
        default: return;
      }
      e.preventDefault();
    });

    // Re-fit when the panel/tab is resized.
    let ro = null;
    if (typeof ResizeObserver !== "undefined") {
      let first = true;
      ro = new ResizeObserver(() => {
        if (first) { first = false; return; }
        rerender();
      });
      ro.observe(stage);
    }

    // -- init
    state.tests = normTests(opts.tests);
    if (!state.tests.length) state.si = -1;
    populateSamples();
    reparse();

    return {
      setTests(tests, extra) {
        state.tests = normTests(tests);
        if (extra && extra.problemLabel != null) state.label = extra.problemLabel;
        if (extra && extra.statementText != null) state.statementText = extra.statementText;
        if (state.si !== -1 || state.tests.length) state.si = state.tests.length ? 0 : -1;
        state.caseIdx = 0;
        populateSamples();
        reparse();
      },
      repaint: rerender,
      loadTrace(stderrText) {
        return loadTrace(stderrText, true);
      },
      destroy() {
        stopPlay();
        if (ro) ro.disconnect();
        container.classList.remove("cpos-viz");
        container.innerHTML = "";
      }
    };
  }

  root.CPOS_VIZ = {
    mount,
    // exported for tests and for embedders that want detection without UI
    _internals: { candidatesFor, segmentCases, chooseSegmentation, splitLines, hintBoosts, forceParse, parseTrace }
  };
})(typeof self !== "undefined" ? self : this);
