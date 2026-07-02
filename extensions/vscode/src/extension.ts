import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs, existsSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import {
  javaClassName,
  javaEntryClassName,
  javaSubmissionCode,
  materializeJavaTemplate
} from "./java";

type CapturedProblem = {
  platform: string;
  id: string;
  name: string;
  url: string;
  rating?: number;
  tags?: string[];
  category?: string;
  tests?: TestCase[];
  statementHtml?: string;
};

type CsesProgress = {
  solved: string[];
  attempted: string[];
};

type TestCase = {
  input: string;
  expected_output: string;
  input_block_sizes?: number[];
  output_block_sizes?: number[];
  input_output_offset?: number;
};

type CompileConfig = {
  compile?: string;
  run: string;
  extension: string;
};

type ProblemMeta = Omit<CapturedProblem, "tests"> & {
  solutionPath: string;
  capturedAt: string;
};

type Verdict = "AC" | "WA" | "TLE" | "RE" | "CE";

type RunResult = {
  index: number;
  verdict: Verdict;
  passed: boolean;
  actual: string;
  timeMs: number;
  stderr?: string;
};

type SolutionVideo = { id: string; title: string; channel: string };
type SolutionState = {
  problemId: string;
  status: "loading" | "done" | "error";
  videos: SolutionVideo[];
};

const OUTPUT = vscode.window.createOutputChannel("CPOS");
let server: http.Server | undefined;
let serverConflict = false;
let status: vscode.StatusBarItem | undefined;
let lastProblem: ProblemMeta | undefined;
let actionsProvider: CposActionsProvider | undefined;
let extContext: vscode.ExtensionContext | undefined;
let vizPanel: vscode.WebviewPanel | undefined;

const PANEL_THEME_KEY = "cpos.panelTheme";

const runResults = new Map<string, RunResult[]>();
let runningFor: string | undefined;
let solutionData: SolutionState | undefined;

// Anti-cheat: never surface editorials/solutions for a problem whose Codeforces
// contest is still running. We cache CF's contest.list (phase per contest) and
// treat anything that is not FINISHED as off-limits.
type CfContestInfo = { phase: string };
let cfContestCache = new Map<string, CfContestInfo>();
let cfContestLoaded = false;
let cfContestFetchedAt = 0;
let cfContestFetching = false;

type PendingSubmit = {
  platform: string;
  id: string;
  contest?: string;
  index?: string;
  code: string;
  language: string;
  fileName: string;
  submitUrl: string;
  expiresAt: number;
};

let pendingSubmit: PendingSubmit | undefined;

const DEFAULT_COMMANDS: Record<string, CompileConfig> = {
  c: { compile: "gcc -std=c11 -O2 -o {output} {source} -lm", run: "./{output}", extension: "c" },
  cpp: { compile: "g++ -std=c++17 -O2 -o {output} {source}", run: "./{output}", extension: "cpp" },
  python: { run: "python3 {source}", extension: "py" },
  pypy: { run: "pypy3 {source}", extension: "py" },
  java: { compile: "javac -d {dir} {source}", run: "java -cp {dir} {classname}", extension: "java" },
  kotlin: { compile: "kotlinc {source} -include-runtime -d {output}.jar", run: "java -jar {output}.jar", extension: "kt" },
  rust: { compile: "rustc -O -o {output} {source}", run: "./{output}", extension: "rs" },
  go: { run: "go run {source}", extension: "go" },
  csharp: { compile: "mcs -out:{output}.exe {source}", run: "mono {output}.exe", extension: "cs" },
  javascript: { run: "node {source}", extension: "js" },
  ruby: { run: "ruby {source}", extension: "rb" },
  haskell: { compile: "ghc -O2 -o {output} {source} -outputdir {dir}", run: "./{output}", extension: "hs" },
  pascal: { compile: "fpc -O2 -o{output} {source}", run: "./{output}", extension: "pas" }
};

const DEFAULT_TEMPLATES: Record<string, string> = {
  c: "#include <stdio.h>\n\nint main(void) {\n\n    return 0;\n}\n",
  cpp: "#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n\n    return 0;\n}\n",
  python: "import sys\ninput = sys.stdin.readline\n\n\ndef main():\n    pass\n\n\nif __name__ == \"__main__\":\n    main()\n",
  pypy: "import sys\ninput = sys.stdin.readline\n\n\ndef main():\n    pass\n\n\nif __name__ == \"__main__\":\n    main()\n",
  java: "import java.util.*;\nimport java.io.*;\n\npublic class {classname} {\n    public static void main(String[] args) throws IOException {\n        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));\n\n    }\n}\n",
  rust: "use std::io::{self, Read};\n\nfn main() {\n    let mut input = String::new();\n    io::stdin().read_to_string(&mut input).unwrap();\n\n}\n",
  go: "package main\n\nimport (\n\t\"bufio\"\n\t\"fmt\"\n\t\"os\"\n)\n\nfunc main() {\n\treader := bufio.NewReader(os.Stdin)\n\twriter := bufio.NewWriter(os.Stdout)\n\tdefer writer.Flush()\n\t_ = reader\n\t_ = fmt.Fprintln\n}\n",
  kotlin: "import java.io.BufferedReader\nimport java.io.InputStreamReader\n\nfun main() {\n    val br = BufferedReader(InputStreamReader(System.`in`))\n\n}\n",
  csharp: "using System;\nusing System.IO;\n\nclass Main {\n    static void Main() {\n        var input = Console.In;\n\n    }\n}\n",
  javascript: "const data = require('fs').readFileSync(0, 'utf8');\nconst lines = data.split('\\n');\nlet idx = 0;\nconst next = () => lines[idx++];\n\n",
  ruby: "# read input with gets / STDIN.read\n\n",
  haskell: "import Data.List\n\nmain :: IO ()\nmain = do\n    contents <- getContents\n    let ws = words contents\n    return ()\n",
  pascal: "program solution;\nbegin\n\nend.\n"
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extContext = context;
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 80);
  status.command = "cpos.focusPanel";
  actionsProvider = new CposActionsProvider(context.extensionUri);
  context.subscriptions.push(status, OUTPUT);

  context.subscriptions.push(
    vscode.commands.registerCommand("cpos.startCaptureServer", async () => {
      await startCaptureServer().catch((error) => warnServer(error));
      refreshActions();
    }),
    vscode.commands.registerCommand("cpos.stopCaptureServer", () => {
      stopCaptureServer();
      refreshActions();
    }),
    vscode.commands.registerCommand("cpos.runSamples", async () => {
      await runTests();
    }),
    vscode.commands.registerCommand("cpos.submitActiveFile", submitActiveFile),
    vscode.commands.registerCommand("cpos.openProblem", openProblem),
    vscode.commands.registerCommand("cpos.visualizeSamples", openVisualizer),
    vscode.commands.registerCommand("cpos.focusPanel", () => {
      void vscode.commands.executeCommand("cpos.actions.focus");
    }),
    vscode.window.registerWebviewViewProvider("cpos.actions", actionsProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => refreshActions()),
    vscode.workspace.onDidSaveTextDocument(() => refreshActions())
  );

  updateStatus();
  if (config().get<boolean>("autoStartCaptureServer", true)) {
    await startCaptureServer().catch((error) => warnServer(error));
  }
  // Warm the CF contest-phase cache so the Solution tab is gated correctly from
  // the first render (no flash) for problems in a live contest.
  void refreshCfContestList();
  refreshActions();
}

export function deactivate(): void {
  stopCaptureServer();
}

function warnServer(error: unknown): void {
  updateStatus();
  OUTPUT.appendLine(`Could not start capture server: ${String(error)}`);
  vscode.window.showWarningMessage("CPOS capture server could not start. Check that the configured port is free.");
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("cpos");
}

async function startCaptureServer(): Promise<void> {
  if (server) {
    updateStatus();
    return;
  }

  const port = config().get<number>("capturePort", 27122);
  const created = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      created.once("error", reject);
      created.listen(port, "127.0.0.1", () => {
        created.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    // Another CPOS window (or app) already owns the port. That's fine — it will
    // receive the captures. Reflect it quietly instead of failing loudly.
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      serverConflict = true;
      updateStatus();
      OUTPUT.appendLine(`Capture port ${port} is already in use — another CPOS window owns capture.`);
      return;
    }
    throw error;
  }

  server = created;
  serverConflict = false;
  updateStatus();
  OUTPUT.appendLine(`Capture server listening on http://127.0.0.1:${port}`);
}

function stopCaptureServer(): void {
  if (!server) return;
  server.close();
  server = undefined;
  serverConflict = false;
  updateStatus();
}

function updateStatus(): void {
  if (!status) return;
  if (server) {
    status.text = "$(radio-tower) CPOS";
    status.tooltip = "CPOS capture is on — click to open panel";
  } else if (serverConflict) {
    status.text = "$(window) CPOS";
    status.tooltip = "CPOS capture is handled by another window — click to open panel";
  } else {
    status.text = "$(circle-slash) CPOS";
    status.tooltip = "CPOS capture is off — click to open panel";
  }
  status.show();
}

// ───────────────────────── Challenge mode (synced store) ─────────────────────
// VS Code holds the same challenge data as the browser companion and serves it
// over localhost. The browser remains the network engine (ntfy delivery + CF
// refereeing) and syncs both ways; this side is a synced store + UI (no
// notifications here, by design).
const CHALLENGE_STORE = "cpos.challenges";
const CHALLENGE_CF = "cpos.challengeCf";
type ChProblem = { platform: string; contestId: number; index: string; id: string; name: string; url: string; rating: number };
type Challenge = {
  id: string; role: string; me: string; opponent: string; problem: ChProblem;
  createdAt: number; durationMin: number; nonce: string; status: string;
  myAcSec: number | null; oppAcSec: number | null; polled: boolean; notified: boolean; online: boolean;
  removedAt?: number;
};
type PublicChallenge = {
  id: string; from: string; problem: ChProblem; createdAt: number;
  durationMin: number; nonce: string;
};
type ChallengeCf = {
  handle: string;
  handleManual?: boolean;
  publicOn: boolean;
  range: { min: number; max: number };
  updatedAt: number;
};
type PanelTabs = { statement: boolean; solution: boolean; compete: boolean };
const CHALLENGE_PUBLIC = "cpos.challengePublicMatches";
const PANEL_TABS = "cpos.panelTabs";
const LEGACY_SHOW_COMPETE = "cpos.showCompete";

function loadChallenges(): Record<string, Challenge> {
  return extContext?.globalState.get<Record<string, Challenge>>(CHALLENGE_STORE) ?? {};
}
async function saveChallenges(map: Record<string, Challenge>): Promise<void> {
  await extContext?.globalState.update(CHALLENGE_STORE, map);
}
function loadChallengeCf(): ChallengeCf {
  const value = extContext?.globalState.get<Partial<ChallengeCf>>(CHALLENGE_CF) ?? {};
  return {
    handle: value.handle ?? "",
    handleManual: value.handleManual === true,
    publicOn: value.publicOn === true,
    range: normalizeChallengeRange(value.range),
    updatedAt: Number(value.updatedAt) || 0
  };
}
async function saveChallengeCf(cf: ChallengeCf): Promise<void> {
  await extContext?.globalState.update(CHALLENGE_CF, cf);
}
function normalizeChallengeRange(range: { min?: number; max?: number } | undefined): { min: number; max: number } {
  const rawMin = Math.max(800, Math.min(3500, Number(range?.min) || 800));
  const rawMax = Math.max(800, Math.min(3500, Number(range?.max) || 3500));
  return rawMin <= rawMax ? { min: rawMin, max: rawMax } : { min: rawMax, max: rawMin };
}
function loadPublicChallenges(): PublicChallenge[] {
  return extContext?.globalState.get<PublicChallenge[]>(CHALLENGE_PUBLIC) ?? [];
}
async function savePublicChallenges(items: PublicChallenge[]): Promise<void> {
  await extContext?.globalState.update(CHALLENGE_PUBLIC, items.slice(0, 30));
}
function loadPanelTabs(): PanelTabs {
  const saved = extContext?.globalState.get<Partial<PanelTabs>>(PANEL_TABS);
  if (saved) {
    return {
      statement: saved.statement !== false,
      solution: saved.solution !== false,
      compete: saved.compete !== false
    };
  }
  const legacyCompete = extContext?.globalState.get<boolean>(LEGACY_SHOW_COMPETE);
  return { statement: true, solution: true, compete: legacyCompete !== false };
}
async function savePanelTabs(tabs: PanelTabs): Promise<void> {
  await extContext?.globalState.update(PANEL_TABS, tabs);
}
async function challengeSetHandle(handle: string): Promise<void> {
  const cf = loadChallengeCf();
  cf.handle = (handle || "").trim();
  cf.handleManual = !!cf.handle;
  cf.updatedAt = Date.now();
  await saveChallengeCf(cf);
}
function chRandId(n: number): string {
  let s = ""; while (s.length < n) s += Math.random().toString(36).slice(2);
  return s.slice(0, n);
}
function parseChallengeProblem(input: string): ChProblem | null {
  const s = (input || "").trim();
  const m = s.match(/codeforces\.com\/problemset\/problem\/(\d+)\/([A-Za-z][0-9]*)/i)
    || s.match(/codeforces\.com\/contest\/(\d+)\/problem\/([A-Za-z][0-9]*)/i)
    || s.match(/^\s*(\d+)\s*[/ ]?\s*([A-Za-z][0-9]*)\s*$/);
  if (!m) return null;
  const c = parseInt(m[1], 10); const x = m[2].toUpperCase();
  if (!c || !x) return null;
  return { platform: "codeforces", contestId: c, index: x, id: `${c}${x}`, name: "", url: `https://codeforces.com/contest/${c}/problem/${x}`, rating: 0 };
}
async function pickRandomProblem(rating: number): Promise<ChProblem | null> {
  try {
    const res = await fetch("https://codeforces.com/api/problemset.problems");
    const j = (await res.json()) as { status: string; result?: { problems?: Array<{ contestId: number; index: string; name: string; rating: number }> } };
    if (j.status !== "OK" || !j.result?.problems) return null;
    const all = j.result.problems.filter((p) => p.contestId && p.index && typeof p.rating === "number");
    let pool = all.filter((p) => p.rating === rating);
    if (pool.length < 5) pool = all.filter((p) => Math.abs(p.rating - rating) <= 100);
    if (!pool.length) pool = all;
    if (!pool.length) return null;
    const p = pool[Math.floor(Math.random() * pool.length)];
    return { platform: "codeforces", contestId: p.contestId, index: p.index, id: `${p.contestId}${p.index}`, name: p.name || "", url: `https://codeforces.com/contest/${p.contestId}/problem/${p.index}`, rating: p.rating };
  } catch { return null; }
}
async function challengeCreate(opponent: string, problemRaw: string, rating: number, durationMin: number): Promise<void> {
  const cf = loadChallengeCf();
  if (!cf.handle) return;
  const problem = problemRaw ? parseChallengeProblem(problemRaw) : await pickRandomProblem(Math.max(800, Math.min(3500, rating || 1400)));
  if (!problem) return;
  const map = loadChallenges();
  const id = chRandId(12);
  map[id] = {
    id, role: "out", me: cf.handle, opponent: (opponent || "").trim(), problem,
    createdAt: Date.now(), durationMin: durationMin || 60, nonce: chRandId(8), status: "pending",
    myAcSec: null, oppAcSec: null, polled: false, notified: false, online: true
  };
  await saveChallenges(map);
}
async function challengeSetStatus(id: string, action: string): Promise<void> {
  const map = loadChallenges(); const ch = map[id]; if (!ch) return;
  if (action === "accept") ch.status = "active";
  else if (action === "decline") ch.status = "declined";
  await saveChallenges(map);
}
async function challengeRemove(id: string): Promise<void> {
  const map = loadChallenges();
  const ch = map[id];
  if (!ch) return;
  ch.status = "removed";
  ch.removedAt = Date.now();
  await saveChallenges(map);
}
async function challengeSetPublic(on: boolean, min: number, max: number): Promise<void> {
  const cf = loadChallengeCf();
  cf.publicOn = !!on;
  cf.range = normalizeChallengeRange({ min, max });
  cf.updatedAt = Date.now();
  await saveChallengeCf(cf);
  if (!cf.publicOn) await savePublicChallenges([]);
}
async function challengeAcceptPublic(id: string): Promise<void> {
  const invite = loadPublicChallenges().find((item) => item.id === id);
  const cf = loadChallengeCf();
  if (!invite || !cf.handle) return;
  const map = loadChallenges();
  map[id] = {
    id: invite.id,
    role: "in",
    me: cf.handle,
    opponent: invite.from || "",
    problem: invite.problem,
    createdAt: invite.createdAt || Date.now(),
    durationMin: invite.durationMin || 60,
    nonce: invite.nonce || "",
    status: "active",
    myAcSec: null,
    oppAcSec: null,
    polled: false,
    notified: false,
    online: true
  };
  await saveChallenges(map);
  await savePublicChallenges(loadPublicChallenges().filter((item) => item.id !== id));
}
// Merge a map pushed from the browser. The browser is authoritative for
// network-derived status, so prefer a more-advanced remote status over local.
function mergeChallenges(incoming: Record<string, Challenge>): Record<string, Challenge> {
  const map = loadChallenges();
  const rank = (s: string): number => (({ pending: 0, active: 1, won: 2, lost: 2, draw: 2, expired: 2, declined: 2, removed: 3 } as Record<string, number>)[s] ?? 0);
  for (const id of Object.keys(incoming)) {
    const rem = incoming[id]; const loc = map[id];
    map[id] = !loc || rank(rem.status) >= rank(loc.status) ? rem : loc;
  }
  return map;
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { status: "ok", app: "cpos-vscode" });
    return;
  }

  if (req.method === "GET" && req.url === "/config") {
    sendJson(res, 200, await sharedConfigPayload());
    return;
  }

  if (req.method === "POST" && req.url === "/config") {
    try {
      const body = await readJson<{ language?: string; content?: string; defaultLanguage?: string; default_language?: string }>(req);
      const language = body.language?.trim();
      if (language && typeof body.content === "string") {
        await writeSharedTemplate(language, body.content);
      }
      const defaultLanguage = (body.defaultLanguage ?? body.default_language)?.trim();
      if (defaultLanguage) {
        await config().update("defaultLanguage", defaultLanguage, vscode.ConfigurationTarget.Global);
      }
      sendJson(res, 200, { ok: true });
      refreshActions();
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/capture/problem") {
    try {
      const body = await readJson<CapturedProblem>(req);
      const created = await captureProblem(body);
      sendJson(res, 200, { ok: true, name: body.name, tests: created.sampleCount, solutionPath: created.meta.solutionPath });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/capture/cses-progress") {
    try {
      const body = await readJson<CsesProgress>(req);
      await saveCsesProgress(body);
      sendJson(res, 200, { ok: true, solved: body.solved.length });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/pending-submit") {
    if (!pendingSubmit || pendingSubmit.expiresAt < Date.now()) {
      sendJson(res, 404, { ok: false });
      return;
    }
    sendJson(res, 200, { ok: true, ...pendingSubmit });
    return;
  }

  if (req.method === "POST" && req.url === "/pending-submit/consumed") {
    pendingSubmit = undefined;
    sendJson(res, 200, { ok: true });
    return;
  }

  // Additive: compile + run arbitrary code against caller-supplied tests, for
  // the browser companion's in-page editor "Run". Reuses the same compile/run
  // pipeline as Run Samples; does not touch capture or submit.
  if (req.method === "POST" && req.url === "/run") {
    try {
      const body = await readJson<{ code: string; language?: string; tests?: Array<{ input?: string; expected?: string; expected_output?: string }> }>(req);
      if (!body.code || !Array.isArray(body.tests)) {
        sendJson(res, 400, { ok: false, error: "missing code/tests" });
        return;
      }
      const results = await runCodeAgainstTests(body.code, body.language, body.tests);
      sendJson(res, 200, { ok: true, results });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  // Challenge sync: the browser companion is the network engine; it pulls the
  // shared store (GET) and pushes its merged state + the detected handle (POST).
  if (req.method === "GET" && req.url === "/challenges") {
    sendJson(res, 200, {
      ok: true,
      challenges: loadChallenges(),
      publicMatches: loadPublicChallenges(),
      cf: loadChallengeCf()
    });
    return;
  }
  if (req.method === "POST" && req.url === "/challenges") {
    try {
      const body = await readJson<{
        challenges?: Record<string, Challenge>;
        publicMatches?: PublicChallenge[];
        cf?: Partial<ChallengeCf>;
        handle?: string;
        handleManual?: boolean;
        publicOn?: boolean;
        range?: { min: number; max: number };
        updatedAt?: number;
      }>(req);
      if (body.challenges) await saveChallenges(mergeChallenges(body.challenges));
      if (Array.isArray(body.publicMatches)) await savePublicChallenges(body.publicMatches);

      const incoming = body.cf ?? {
        handle: body.handle,
        handleManual: body.handleManual,
        publicOn: body.publicOn,
        range: body.range,
        updatedAt: body.updatedAt
      };
      const local = loadChallengeCf();
      const incomingUpdatedAt = Number(incoming.updatedAt) || 0;
      if (incomingUpdatedAt > local.updatedAt) {
        const canUseIncomingHandle = !!incoming.handle && (!local.handleManual || incoming.handleManual === true);
        await saveChallengeCf({
          handle: canUseIncomingHandle ? incoming.handle! : local.handle,
          handleManual: canUseIncomingHandle ? incoming.handleManual === true : local.handleManual,
          publicOn: typeof incoming.publicOn === "boolean" ? incoming.publicOn : local.publicOn,
          range: incoming.range ? normalizeChallengeRange(incoming.range) : local.range,
          updatedAt: incomingUpdatedAt
        });
      } else if (incoming.handle && !local.handle) {
        local.handle = incoming.handle;
        local.handleManual = incoming.handleManual === true;
        await saveChallengeCf(local);
      }
      sendJson(res, 200, {
        ok: true,
        challenges: loadChallenges(),
        publicMatches: loadPublicChallenges(),
        cf: loadChallengeCf()
      });
      actionsProvider?.refresh();
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

// Compile `code` in `language` and run it against each test, returning per-test
// verdicts. Self-contained (writes to the build dir), so it never disturbs the
// user's solution files, capture state, or pending submissions.
async function runCodeAgainstTests(
  code: string,
  language: string | undefined,
  tests: Array<{ input?: string; expected?: string; expected_output?: string }>
): Promise<Array<{ index: number; verdict: Verdict; passed: boolean; actual: string; expected: string; timeMs: number; stderr?: string }>> {
  const lang = language && DEFAULT_COMMANDS[language] ? language : resolveDefaultLanguage();
  const cfg = getCompileConfig(lang);
  const buildDir = path.join(dataDir(), "build");
  await fs.mkdir(buildDir, { recursive: true });
  const ext = cfg.extension || "txt";
  // Java needs the source filename and run target to match its public class.
  const base = lang === "java" ? javaEntryClassName(code, "Main") : "cpos_run";
  const source = path.join(buildDir, `${base}.${ext}`);
  await fs.writeFile(source, code);
  const timeoutMs = config().get<number>("runTimeoutMs", 5000);

  if (cfg.compile) {
    const compileCommand = expandCommand(cfg.compile, source, base, buildDir);
    const compileResult = await runShell(compileCommand, "", buildDir, Math.max(timeoutMs, 20000));
    if (compileResult.code !== 0) {
      const detail = (compileResult.stderr || compileResult.stdout).trim();
      return tests.map((_, index) => ({ index, verdict: "CE" as Verdict, passed: false, actual: detail, expected: "", timeMs: 0 }));
    }
  }

  const results = [];
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    const expected = (t.expected ?? t.expected_output ?? "").toString();
    const runCommand = expandCommand(cfg.run, source, base, buildDir);
    const r = await runShell(runCommand, (t.input ?? "").toString(), buildDir, timeoutMs);
    const ev = evaluate(i, { input: t.input ?? "", expected_output: expected }, r);
    results.push({ index: i, verdict: ev.verdict, passed: ev.passed, actual: ev.actual, expected, timeMs: ev.timeMs, stderr: ev.stderr });
  }
  return results;
}

function setCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Chrome's Private Network Access: a page on a public origin (codeforces.com,
  // atcoder.jp, …) fetching this 127.0.0.1 server must receive this header on the
  // preflight, or the request is blocked even though CORS otherwise passes.
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

const TUI_CAPTURE_PORT = 27121;

async function forwardCaptureToTui(
  problem: CapturedProblem,
  solutionPath: string
): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${TUI_CAPTURE_PORT}/capture/problem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...problem, solution_path: solutionPath })
    });
    if (!res.ok) {
      OUTPUT.appendLine(`TUI sync failed (${res.status}) — is the CPOS terminal app running?`);
    }
  } catch {
    OUTPUT.appendLine("TUI not running — capture saved in VS Code only.");
  }
}

async function captureProblem(problem: CapturedProblem): Promise<{ meta: ProblemMeta; sampleCount: number }> {
  validateProblem(problem);
  if (!problem.name || !problem.name.trim()) problem.name = problem.id;
  const lang = resolveDefaultLanguage();
  const compileConfig = getCompileConfig(lang);
  const active = activeEditorFilePath();
  const attachToActive = !!active && activeNameMatchesProblem(active, problem);

  let solutionPath: string;
  if (attachToActive) {
    solutionPath = active as string;
  } else {
    solutionPath = await resolveSolutionPath(problem, compileConfig.extension);
    await fs.mkdir(path.dirname(solutionPath), { recursive: true });
    if (!(await exists(solutionPath))) {
      await fs.writeFile(
        solutionPath,
        await templateFor(lang, lang === "java" ? path.parse(solutionPath).name : undefined),
        "utf8"
      );
    }
  }

  let tests = problem.tests ?? [];
  let statementHtml = problem.statementHtml;
  // AtCoder samples/statement aren't reliably scraped in the browser, so fetch
  // them here from the task page (static and authoritative) so capture lands
  // working sample tests and a readable statement.
  if (problem.platform.toLowerCase() === "atcoder") {
    // The task page is static and reliable, so treat server-parsed samples as
    // authoritative (the browser DOM scrape can vary across page layouts); only
    // keep the browser-sent samples when the fetch fails entirely.
    const page = await fetchAtcoderPage(problem.url);
    if (page) {
      const s = parseAtcoderSamples(page);
      if (s.length > 0) tests = s;
      if (!statementHtml) statementHtml = extractAtcoderStatement(page);
    }
  }
  await saveSamples(solutionPath, tests);
  runResults.delete(solutionPath);

  lastProblem = {
    platform: problem.platform,
    id: problem.id,
    name: problem.name,
    url: problem.url,
    rating: problem.rating,
    tags: problem.tags,
    category: problem.category,
    statementHtml,
    solutionPath,
    capturedAt: new Date().toISOString()
  };
  await saveProblemMeta(lastProblem);
  await saveCsesSlugLookup(lastProblem);

  // Only open/switch when we used a separate file. If we attached to the file
  // you're already on, leave your editor exactly where it is.
  if (!attachToActive && config().get<boolean>("openOnCapture", true)) {
    const document = await vscode.workspace.openTextDocument(solutionPath);
    await vscode.window.showTextDocument(document);
  }

  refreshActions();
  void refreshVisualizer();
  const detail = attachToActive
    ? `${tests.length} sample(s) → ${path.basename(solutionPath)}`
    : `${tests.length} sample(s)`;
  vscode.window.showInformationMessage(`CPOS · ${problem.id} (${problem.name}) — ${detail}.`);
  await forwardCaptureToTui({ ...problem, tests }, solutionPath);
  return { meta: lastProblem, sampleCount: tests.length };
}

function activeEditorFilePath(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.uri.scheme === "file") return editor.document.uri.fsPath;
  return undefined;
}

// Fetch the AtCoder task page once; both samples and the statement are parsed
// from this raw HTML (math is still TeX here, before MathJax runs in-browser).
async function fetchAtcoderPage(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { headers: { "Accept-Language": "en", "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return undefined;
    return await res.text();
  } catch (error) {
    OUTPUT.appendLine(`Could not fetch AtCoder task page: ${String(error)}`);
    return undefined;
  }
}

// Extract the English statement section (#task-statement span.lang-en) by
// balancing <span> tags, then map AtCoder's inline $…$ to MathJax's \( … \) so
// the panel renders it (the panel only treats $$…$$ and \(…\) as math).
function extractAtcoderStatement(html: string): string | undefined {
  const inner = extractByClass(html, "lang-en") ?? extractById(html, "task-statement");
  if (!inner) return undefined;
  const cleaned = inner
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<link\b[^>]*>/gi, "");
  return atcoderInlineMathToMathjax(cleaned).trim() || undefined;
}

// Inner HTML of the first <span> whose class contains `className`, matched by
// counting nested <span>/</span> so embedded spans don't truncate it early.
function extractByClass(html: string, className: string): string | undefined {
  const open = new RegExp(`<span\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`, "i");
  const m = open.exec(html);
  if (!m) return undefined;
  const start = m.index + m[0].length;
  const spanRe = /<\/?span\b[^>]*>/gi;
  spanRe.lastIndex = start;
  let depth = 1;
  let tag: RegExpExecArray | null;
  while ((tag = spanRe.exec(html)) !== null) {
    if (tag[0][1] === "/") {
      depth--;
      if (depth === 0) return html.slice(start, tag.index);
    } else {
      depth++;
    }
  }
  return html.slice(start);
}

function extractById(html: string, id: string): string | undefined {
  const m = new RegExp(`<([a-z0-9]+)\\b[^>]*id="${id}"[^>]*>`, "i").exec(html);
  if (!m) return undefined;
  return html.slice(m.index + m[0].length);
}

function atcoderInlineMathToMathjax(html: string): string {
  const display: string[] = [];
  // Protect $$…$$ display math, convert single $…$ to \(…\), then restore.
  let out = html.replace(/\$\$([\s\S]*?)\$\$/g, (block) => {
    display.push(block);
    return `@@CPOSDISP${display.length - 1}@@`;
  });
  out = out.replace(/\$([^$\n]+?)\$/g, (_full, inner) => `\\(${inner}\\)`);
  out = out.replace(/@@CPOSDISP(\d+)@@/g, (_full, i) => display[Number(i)] ?? "");
  return out;
}

// AtCoder task pages render both Japanese and English statements. Heading-text
// matching ("Sample Input N") naturally skips the Japanese copies; we still
// scope to the English section first when it is present.
function parseAtcoderSamples(html: string): TestCase[] {
  const enStart = html.indexOf('class="lang-en"');
  const scope = enStart >= 0 ? html.slice(enStart) : html;
  const ins: string[] = [];
  const outs: string[] = [];
  let cur: "in" | "out" | null = null;
  const tagRe = /<(h3|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(scope)) !== null) {
    if (m[1].toLowerCase() === "h3") {
      const text = stripTags(m[2]).toLowerCase();
      cur = text.includes("sample input") ? "in" : text.includes("sample output") ? "out" : null;
    } else {
      const text = normalizeSample(decodeEntities(stripTags(m[2])));
      if (cur === "in") ins.push(text);
      else if (cur === "out") outs.push(text);
      cur = null;
    }
  }
  const tests: TestCase[] = [];
  for (let i = 0; i < Math.min(ins.length, outs.length); i++) {
    tests.push({ input: ins[i], expected_output: outs[i] });
  }
  return tests;
}

function stripTags(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// Mirror the browser companion's preText: normalize CRLF and strip leading and
// trailing blank lines, leaving the inner sample content untouched.
function normalizeSample(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
}

function validateProblem(problem: CapturedProblem): void {
  // name is intentionally not required: it is a cosmetic field, and judges like
  // AtCoder occasionally yield an empty title in the DOM. captureProblem() falls
  // back to the id so a blank name never rejects an otherwise valid capture.
  for (const key of ["platform", "id", "url"] as const) {
    if (!problem[key] || typeof problem[key] !== "string") {
      throw new Error(`missing ${key}`);
    }
  }
}

function getCompileConfig(lang: string): CompileConfig {
  // 1. An explicit VS Code override always wins, verbatim.
  const overrides = userSetting<Record<string, CompileConfig>>("compileCommands");
  if (overrides && overrides[lang]) return applyPlatformRun(overrides[lang]);

  // 2. Otherwise inherit from the CPOS TUI config so both stay in sync.
  const tui = tuiConfig().compileCommands[lang];
  if (tui && tui.run && tui.extension) {
    const inherited = absolutizeConfig({ compile: tui.compile, run: tui.run, extension: tui.extension });
    if (lang === "java" && !inherited.run.includes("{classname}")) {
      inherited.run = inherited.run.replace(/\bMain\b/, "{classname}");
    }
    return applyPlatformRun(inherited);
  }

  // 3. Fall back to the built-in defaults.
  const value = DEFAULT_COMMANDS[lang];
  if (!value) throw new Error(`No compile command configured for ${lang}`);

  // On macOS, plain `g++`/`gcc` is Apple clang, which lacks <bits/stdc++.h>.
  // Use a real GNU toolchain (e.g. Homebrew g++-15) by absolute path when
  // available, so it works even when the GUI app's PATH misses /opt/homebrew/bin.
  if (lang === "cpp") {
    return applyPlatformRun({
      ...value,
      compile: `${cppCompiler()} -std=c++17 -O2 -o {output} {source}`
    });
  }
  if (lang === "c") {
    return applyPlatformRun({
      ...value,
      compile: `${cCompiler()} -std=c11 -O2 -o {output} {source} -lm`
    });
  }
  if (lang === "python") {
    return applyPlatformRun({ ...value, run: `${pythonRunner()} {source}` });
  }
  if (lang === "pypy") {
    return applyPlatformRun({ ...value, run: `${pypyRunner()} {source}` });
  }
  return applyPlatformRun(value);
}

// Returns a VS Code setting only when the user explicitly set it (so we can
// fall back to the CPOS TUI config when they haven't).
function userSetting<T>(key: string): T | undefined {
  const info = config().inspect<T>(key);
  return info?.workspaceFolderValue ?? info?.workspaceValue ?? info?.globalValue;
}

function resolveDefaultLanguage(): string {
  return userSetting<string>("defaultLanguage") ?? tuiConfig().defaultLanguage ?? "cpp";
}

function absolutizeConfig(c: CompileConfig): CompileConfig {
  return {
    ...c,
    compile: c.compile ? absolutizeCommand(c.compile) : c.compile,
    run: absolutizeCommand(c.run)
  };
}

// Resolve a command's leading binary (e.g. `g++-15`, `python3`) to an absolute
// path when we can find it, so commands work even if the GUI app's PATH is thin.
function absolutizeCommand(command: string): string {
  const match = command.match(/^(\s*)(\S+)([\s\S]*)$/);
  if (!match) return command;
  const [, lead, bin, rest] = match;
  if (bin.includes("/")) return command;
  const resolved = resolveBinary([bin], bin);
  return resolved === bin ? command : `${lead}${resolved}${rest}`;
}

type TuiConfig = {
  defaultLanguage?: string;
  templateFile?: string;
  compileCommands: Record<string, Partial<CompileConfig>>;
};

let tuiConfigCache: TuiConfig | undefined;
let tuiConfigMtime = -1;

function tuiConfigPath(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "cpos", "config.toml");
  }
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "cpos", "config.toml");
  }
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "cpos", "config.toml");
}

function sharedTemplatePath(lang: string): string {
  const ext = DEFAULT_COMMANDS[lang]?.extension ?? "txt";
  return path.join(path.dirname(tuiConfigPath()), "templates", `template.${ext}`);
}

async function writeSharedTemplate(lang: string, content: string): Promise<void> {
  const file = sharedTemplatePath(lang);
  if (!content.trim()) {
    try {
      await fs.unlink(file);
    } catch {
      /* already using the built-in starter */
    }
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

async function readSharedTemplate(lang: string): Promise<string | undefined> {
  try {
    return await fs.readFile(sharedTemplatePath(lang), "utf8");
  } catch {
    return undefined;
  }
}

async function sharedConfigPayload(): Promise<{ ok: true; defaultLanguage: string; templates: Record<string, string> }> {
  const templates: Record<string, string> = {};
  await Promise.all(Object.keys(DEFAULT_COMMANDS).map(async (lang) => {
    const content = await readSharedTemplate(lang);
    if (content !== undefined) templates[lang] = content;
  }));
  const defaultLanguage = resolveDefaultLanguage();
  if (templates[defaultLanguage] === undefined) {
    const legacy = (userSetting<string>("templateFile") ?? tuiConfig().templateFile ?? "").trim();
    if (legacy) {
      try {
        templates[defaultLanguage] = await fs.readFile(expandHome(legacy), "utf8");
      } catch {
        /* keep the template absent and let clients use their built-in starter */
      }
    }
  }
  return { ok: true, defaultLanguage, templates };
}

function tuiConfig(): TuiConfig {
  const file = tuiConfigPath();
  try {
    const mtime = statSync(file).mtimeMs;
    if (tuiConfigCache && mtime === tuiConfigMtime) return tuiConfigCache;
    tuiConfigCache = parseTuiConfig(readFileSync(file, "utf8"));
    tuiConfigMtime = mtime;
    return tuiConfigCache;
  } catch {
    tuiConfigCache = { compileCommands: {} };
    return tuiConfigCache;
  }
}

// Minimal TOML reader for just the keys we share with the TUI: top-level
// default_language / template_file and [compile_commands.<lang>] tables.
function parseTuiConfig(text: string): TuiConfig {
  const cfg: TuiConfig = { compileCommands: {} };
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const value = parseTomlString(kv[2]);
    if (value === undefined) continue;
    const key = kv[1];
    if (section === "") {
      if (key === "default_language") cfg.defaultLanguage = value;
      else if (key === "template_file") cfg.templateFile = value;
    } else if (section.startsWith("compile_commands.")) {
      const lang = section.slice("compile_commands.".length);
      const entry = cfg.compileCommands[lang] ?? (cfg.compileCommands[lang] = {});
      if (key === "compile") entry.compile = value;
      else if (key === "run") entry.run = value;
      else if (key === "extension") entry.extension = value;
    }
  }
  return cfg;
}

function parseTomlString(raw: string): string | undefined {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s
      .slice(1, -1)
      .replace(/\\\\/g, "\\")
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1);
  }
  return undefined;
}

const compilerCache = new Map<string, string>();

function resolveBinary(candidates: string[], fallback: string): string {
  const key = candidates.join("|");
  const cached = compilerCache.get(key);
  if (cached) return cached;

  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extraDirs = toolPathDirs();
  for (const candidate of candidates) {
    const names =
      process.platform === "win32" ? [candidate, `${candidate}.exe`] : [candidate];
    for (const name of names) {
      for (const dir of [...pathDirs, ...extraDirs]) {
        const full = path.join(dir, name);
        if (existsSync(full)) {
          compilerCache.set(key, full);
          return full;
        }
      }
    }
  }
  compilerCache.set(key, fallback);
  return fallback;
}

function cppCompiler(): string {
  return resolveBinary(["g++-15", "g++-14", "g++-13", "g++-12", "g++-11"], "g++");
}

function cCompiler(): string {
  return resolveBinary(["gcc-15", "gcc-14", "gcc-13", "gcc-12", "gcc-11"], "gcc");
}

/** Extra dirs merged into PATH for spawned runs (GUI apps often have a thin PATH). */
function toolPathDirs(): string[] {
  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    return [
      "C:\\msys64\\ucrt64\\bin",
      "C:\\msys64\\mingw64\\bin",
      "C:\\msys64\\usr\\bin",
      "C:\\MinGW\\bin",
      path.join(pf, "mingw-w64", "bin"),
      path.join(pf86, "mingw-w64", "bin"),
      path.join(os.homedir(), "scoop", "shims"),
      "C:\\Windows\\System32"
    ];
  }
  return ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin", "/bin"];
}

function processEnvForRun(): NodeJS.ProcessEnv {
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const merged = [...new Set([...pathDirs, ...toolPathDirs()])].join(path.delimiter);
  return { ...process.env, PATH: merged };
}

function shellForRun(): { file: string; args: (command: string) => string[] } {
  if (process.platform === "win32") {
    const file = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
    return { file, args: (command) => ["/d", "/s", "/c", command] };
  }
  for (const file of ["/bin/sh", "/usr/bin/sh"]) {
    if (existsSync(file)) return { file, args: (command) => ["-c", command] };
  }
  return { file: "sh", args: (command) => ["-c", command] };
}

/** Windows cannot run `./binary`; map Unix-style run templates to `.exe` names. */
function applyPlatformRun(config: CompileConfig): CompileConfig {
  if (process.platform !== "win32") return config;
  let run = config.run;
  let compile = config.compile;
  if (run === "./{output}") run = "{output}.exe";
  else if (run.startsWith("./{output}")) run = run.replace(/^\.\/\{output\}/, "{output}.exe");
  // Explicitly add .exe to compile output so the run target matches.
  // Matches "-o {output}" or "-o  {output}" but not "-o {output}.jar" etc.
  if (compile) compile = compile.replace(/-o\s+\{output\}(?!\.)/, "-o {output}.exe");
  return { ...config, compile, run };
}

function pythonRunner(): string {
  if (process.platform === "win32") {
    return resolveBinary(["python", "python3", "py"], "python");
  }
  return resolveBinary(["python3", "python"], "python3");
}

function pypyRunner(): string {
  if (process.platform === "win32") {
    return resolveBinary(["pypy3", "pypy"], "pypy3");
  }
  return resolveBinary(["pypy3", "pypy"], "pypy3");
}

function solutionPathFor(problem: CapturedProblem, extension: string): string {
  const base = solutionBaseDir();
  const dir = config().get<boolean>("subfolderPerPlatform", false)
    ? path.join(base, platformSlug(problem.platform))
    : base;
  return path.join(dir, `${solutionBaseName(problem, extension)}.${extension}`);
}

async function resolveSolutionPath(problem: CapturedProblem, extension: string): Promise<string> {
  const primary = solutionPathFor(problem, extension);
  if (!(await exists(primary))) return primary;

  try {
    const raw = await fs.readFile(problemMetaPathFor(primary), "utf8");
    const existing = JSON.parse(raw) as ProblemMeta;
    if (existing.id === problem.id) return primary;
  } catch {
    // File exists but isn't ours — pick a disambiguated name.
  }

  if (isCsesPlatform(problem.platform)) {
    const slug = slugFromName(problem.name);
    if (slug) {
      const disambiguated = extension === "java"
        ? javaClassName(`${slug}_${safeId(problem.id)}`)
        : `${slug}-${safeId(problem.id)}`;
      return path.join(path.dirname(primary), `${disambiguated}.${extension}`);
    }
  }
  return primary;
}

function isCsesPlatform(platform: string): boolean {
  return platform.toLowerCase() === "cses";
}

// CSES files use a readable PascalCase slug from the problem name
// (e.g. "Weird Algorithm" → WeirdAlgorithm.cpp). The numeric task id stays
// in metadata for submit, progress sync, and sample lookup.
function slugFromName(name: string): string {
  return name
    .split(/[\s\-–—]+/)
    .map((word) => word.replace(/[^a-zA-Z0-9]/g, ""))
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

function solutionBaseName(problem: CapturedProblem | ProblemMeta, extension?: string): string {
  let base: string;
  if (isCsesPlatform(problem.platform)) {
    const slug = slugFromName(problem.name);
    if (slug) {
      base = slug;
      return extension === "java" ? javaClassName(base) : base;
    }
  }
  base = safeId(problem.id);
  return extension === "java" ? javaClassName(base) : base;
}

function activeNameMatchesProblem(activePath: string, problem: CapturedProblem): boolean {
  const base = path.parse(activePath).name.toLowerCase();
  const id = safeId(problem.id).toLowerCase();
  if (base === id) return true;
  if (path.extname(activePath).toLowerCase() === ".java" &&
      base === javaClassName(solutionBaseName(problem)).toLowerCase()) {
    return true;
  }
  if (isCsesPlatform(problem.platform)) {
    const slug = slugFromName(problem.name).toLowerCase();
    if (slug && (
      base === slug ||
      base === `${slug}-${id}` ||
      (path.extname(activePath).toLowerCase() === ".java" &&
        (base === javaClassName(slug).toLowerCase() ||
          base === javaClassName(`${slug}_${id}`).toLowerCase()))
    )) return true;
  }
  return false;
}

async function saveCsesSlugLookup(meta: ProblemMeta): Promise<void> {
  if (!isCsesPlatform(meta.platform)) return;
  const slug = slugFromName(meta.name);
  if (!slug) return;
  const file = path.join(dataDir(), "cses-slugs.json");
  let lookup: Record<string, Omit<ProblemMeta, "solutionPath">> = {};
  try {
    lookup = JSON.parse(await fs.readFile(file, "utf8")) as typeof lookup;
  } catch {
    /* start fresh */
  }
  lookup[slug.toLowerCase()] = {
    platform: meta.platform,
    id: meta.id,
    name: meta.name,
    url: meta.url,
    rating: meta.rating,
    tags: meta.tags,
    category: meta.category,
    statementHtml: meta.statementHtml,
    capturedAt: meta.capturedAt
  };
  await fs.writeFile(file, JSON.stringify(lookup, null, 2), "utf8");
}

async function loadCsesMetaBySlug(basename: string, source: string): Promise<ProblemMeta | undefined> {
  try {
    const lookup = JSON.parse(
      await fs.readFile(path.join(dataDir(), "cses-slugs.json"), "utf8")
    ) as Record<string, Omit<ProblemMeta, "solutionPath">>;
    const hit = lookup[basename.toLowerCase()];
    if (!hit) return undefined;
    return { ...hit, solutionPath: source };
  } catch {
    return undefined;
  }
}

// Where captured files are created: the open folder by default, otherwise a
// fixed fallback. This keeps files inside the user's own project structure
// instead of a separate "workspace".
function solutionBaseDir(): string {
  const mode = config().get<string>("saveLocation", "workspaceFolder");
  if (mode === "workspaceFolder") {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders[0].uri.fsPath;
  }
  return expandHome(config().get<string>("fixedDir", "~/cpos"));
}

function platformSlug(platform: string): string {
  const lower = platform.toLowerCase();
  if (lower === "codeforces" || lower === "cf") return "codeforces";
  if (lower === "cses") return "cses";
  if (lower === "atcoder") return "atcoder";
  return lower.replace(/[^a-z0-9_-]/g, "_") || "problems";
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function templateFor(lang: string, className?: string): Promise<string> {
  // Prefer the shared per-language CPOS template. Existing VS Code/TUI template
  // paths remain the fallback and are surfaced in the Config UI for migration.
  const shared = await readSharedTemplate(lang);
  if (shared !== undefined) return materializeTemplate(shared, lang, className);
  const explicitTemplate = (userSetting<string>("templateFile") ?? "").trim();
  if (explicitTemplate) {
    try {
      return materializeTemplate(await fs.readFile(expandHome(explicitTemplate), "utf8"), lang, className);
    } catch (error) {
      OUTPUT.appendLine(`Could not read template file: ${String(error)}`);
    }
  }
  const templateFile = (tuiConfig().templateFile ?? "").trim();
  if (templateFile) {
    try {
      return materializeTemplate(await fs.readFile(expandHome(templateFile), "utf8"), lang, className);
    } catch (error) {
      OUTPUT.appendLine(`Could not read template file: ${String(error)}`);
    }
  }
  return materializeTemplate(DEFAULT_TEMPLATES[lang] ?? "", lang, className);
}

function materializeTemplate(template: string, lang: string, className?: string): string {
  if (lang !== "java" || !className) return template;
  return materializeJavaTemplate(template, className);
}

function dataDir(): string {
  return path.join(os.homedir(), ".cpos-vscode");
}

async function saveSamples(solutionPath: string, tests: TestCase[]): Promise<void> {
  const dir = dataDir();
  await fs.mkdir(path.join(dir, "samples"), { recursive: true });
  await fs.writeFile(samplePathFor(solutionPath), JSON.stringify(tests, null, 2), "utf8");

  if (config().get<boolean>("saveSamplesNextToSolution", false)) {
    await fs.writeFile(`${solutionPath}.samples.json`, JSON.stringify(tests, null, 2), "utf8");
  }
}

function hashPath(p: string): string {
  let norm = path.normalize(p);
  norm = process.platform === "win32" ? norm.toLowerCase() : norm;
  return Buffer.from(norm).toString("base64url");
}

function samplePathFor(solutionPath: string): string {
  return path.join(dataDir(), "samples", `${hashPath(solutionPath)}.json`);
}

async function saveProblemMeta(meta: ProblemMeta): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(path.join(dataDir(), "last-problem.json"), JSON.stringify(meta, null, 2), "utf8");
  await fs.mkdir(path.join(dataDir(), "problems"), { recursive: true });
  await fs.writeFile(problemMetaPathFor(meta.solutionPath), JSON.stringify(meta, null, 2), "utf8");
}

async function loadProblemMeta(): Promise<ProblemMeta | undefined> {
  if (lastProblem) return lastProblem;
  try {
    const raw = await fs.readFile(path.join(dataDir(), "last-problem.json"), "utf8");
    lastProblem = JSON.parse(raw) as ProblemMeta;
    return lastProblem;
  } catch {
    return undefined;
  }
}

async function loadProblemMetaForFile(source: string): Promise<ProblemMeta | undefined> {
  try {
    const raw = await fs.readFile(problemMetaPathFor(source), "utf8");
    return JSON.parse(raw) as ProblemMeta;
  } catch {
    const fallback = await loadProblemMeta();
    if (fallback) {
      const match = process.platform === "win32"
        ? fallback.solutionPath.toLowerCase() === source.toLowerCase()
        : fallback.solutionPath === source;
      if (match) return fallback;
    }
    const inferred = inferProblemMetaFromPath(source);
    if (inferred) return inferred;
    return loadCsesMetaBySlug(path.parse(source).name, source);
  }
}

function problemMetaPathFor(solutionPath: string): string {
  return path.join(dataDir(), "problems", `${hashPath(solutionPath)}.json`);
}

// Best-effort guess for files that were not created by a capture. We only use
// this when there is no saved metadata for the file path.
function inferProblemMetaFromPath(source: string): ProblemMeta | undefined {
  const id = path.parse(source).name;
  const parent = path.basename(path.dirname(source)).toLowerCase();

  let platform: string | undefined;
  if (parent === "codeforces" || parent === "cf") platform = "codeforces";
  else if (parent === "cses") platform = "cses";
  else if (parent === "atcoder") platform = "atcoder";
  else if (/^\d+[A-Za-z]\d*$/.test(id)) platform = "codeforces";

  if (!platform) return undefined;

  if (platform === "cses" && !/^\d+$/.test(id)) {
    return undefined;
  }

  let url: string | undefined;
  if (platform === "codeforces") url = codeforcesProblemUrl(id);
  else if (platform === "cses") url = `https://cses.fi/problemset/task/${id}`;
  else if (platform === "atcoder") {
    const prefix = id.match(/^([a-z0-9]+)_/i);
    url = prefix ? `https://atcoder.jp/contests/${prefix[1]}/tasks/${id}` : undefined;
  }
  if (!url) return undefined;

  return {
    platform,
    id,
    name: id,
    url,
    solutionPath: source,
    capturedAt: new Date(0).toISOString()
  };
}

function codeforcesProblemUrl(id: string): string | undefined {
  const match = id.match(/^(\d+)([A-Za-z0-9]+)$/);
  if (!match) return undefined;
  return `https://codeforces.com/problemset/problem/${match[1]}/${match[2]}`;
}

function tuiDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "cpos");
  }
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "cpos");
  }
  const base = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "cpos");
}

async function saveCsesProgress(progress: CsesProgress): Promise<void> {
  const json = JSON.stringify(progress, null, 2);
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(path.join(dataDir(), "cses-progress.json"), json, "utf8");
  // Mirror to TUI data dir so both apps share progress.
  const tuiDir = tuiDataDir();
  await fs.mkdir(tuiDir, { recursive: true });
  await fs.writeFile(path.join(tuiDir, "cses_progress.json"), json, "utf8");
}

async function runTests(indices?: number[]): Promise<void> {
  const source = await activeSolutionPath();
  if (!source) {
    vscode.window.showWarningMessage("Open a solution file or capture a problem first.");
    return;
  }
  if (process.platform === "win32" && !(await saveOpenSolutionDocument(source))) {
    vscode.window.showWarningMessage("CPOS: save the solution file before running samples.");
    return;
  }

  const tests = await loadSamples(source);
  if (tests.length === 0) {
    vscode.window.showWarningMessage("No samples for this file. Open the problem in your browser to capture, or add a test in the CPOS panel.");
    return;
  }

  const lang = languageForFile(source);
  let compileConfig: CompileConfig;
  try {
    compileConfig = getCompileConfig(lang);
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    return;
  }

  const buildDir = path.join(dataDir(), "build");
  await fs.mkdir(buildDir, { recursive: true });
  const outputName = path.parse(source).name;
  const className = lang === "java"
    ? javaEntryClassName(await fs.readFile(source, "utf8"), outputName)
    : outputName;
  const timeoutMs = config().get<number>("runTimeoutMs", 5000);

  const targets = indices && indices.length > 0 ? indices : tests.map((_, i) => i);
  const existing = runResults.get(source) ?? [];

  runningFor = source;
  refreshActions();

  try {
    if (compileConfig.compile) {
      const compileCommand = expandCommand(compileConfig.compile, source, outputName, buildDir, className);
      OUTPUT.appendLine(`$ ${compileCommand}`);
      const compileResult = await runShell(compileCommand, "", buildDir, Math.max(timeoutMs, 20000));
      if (compileResult.code !== 0) {
        const ceResults: RunResult[] = tests.map((_, index) => ({
          index,
          verdict: "CE",
          passed: false,
          actual: (compileResult.stderr || compileResult.stdout).trim(),
          timeMs: 0
        }));
        runResults.set(source, ceResults);
        runningFor = undefined;
        refreshActions();
        vscode.window.showErrorMessage("CPOS: compilation failed. See the CPOS panel.");
        return;
      }
    }

    const merged: RunResult[] = tests.map((_, index) => {
      const prior = existing.find((r) => r.index === index);
      return prior ?? { index, verdict: "WA", passed: false, actual: "", timeMs: 0 };
    });

    for (const index of targets) {
      const test = tests[index];
      if (!test) continue;
      const runCommand = expandCommand(compileConfig.run, source, outputName, buildDir, className);
      const result = await runShell(runCommand, test.input, buildDir, timeoutMs);
      merged[index] = evaluate(index, test, result);
    }

    runResults.set(source, merged);
    runningFor = undefined;
    refreshActions();

    const ran = targets.length;
    const passed = targets.filter((i) => merged[i]?.passed).length;
    const message = `CPOS: ${passed}/${ran} passed`;
    if (passed === ran) vscode.window.showInformationMessage(message);
    else vscode.window.showWarningMessage(message);
  } catch (error) {
    runningFor = undefined;
    refreshActions();
    vscode.window.showErrorMessage(`CPOS run failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function saveOpenSolutionDocument(source: string): Promise<boolean> {
  const document = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.scheme === "file" && sameFilePath(doc.uri.fsPath, source)
  );
  if (!document?.isDirty) return true;
  return document.save();
}

function sameFilePath(left: string, right: string): boolean {
  const a = path.normalize(left);
  const b = path.normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function evaluate(index: number, test: TestCase, result: { code: number; stdout: string; stderr: string; timedOut: boolean; timeMs: number }): RunResult {
  const actual = result.stdout.replace(/\s+$/g, "");
  const expected = test.expected_output.replace(/\s+$/g, "");
  if (result.timedOut) {
    return { index, verdict: "TLE", passed: false, actual, timeMs: result.timeMs, stderr: result.stderr.trim() || undefined };
  }
  if (result.code !== 0) {
    return { index, verdict: "RE", passed: false, actual, timeMs: result.timeMs, stderr: result.stderr.trim() || undefined };
  }
  const passed = normalize(actual) === normalize(expected);
  return { index, verdict: passed ? "AC" : "WA", passed, actual, timeMs: result.timeMs, stderr: result.stderr.trim() || undefined };
}

function normalize(value: string): string {
  return value
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n+$/g, "");
}

async function submitActiveFile(): Promise<void> {
  const source = await activeSolutionPath();
  if (!source) {
    vscode.window.showWarningMessage("Open a captured solution file first.");
    return;
  }

  const meta = await loadProblemMetaForFile(source);
  if (!meta) {
    vscode.window.showWarningMessage("This file is not linked to a captured problem yet.");
    return;
  }

  const editor = vscode.window.activeTextEditor;
  const sourceCode =
    editor?.document.uri.fsPath === source ? editor.document.getText() : await fs.readFile(source, "utf8");
  if (!sourceCode.trim()) {
    vscode.window.showWarningMessage("The active solution file is empty.");
    return;
  }

  const lang = languageForFile(source);
  const code = lang === "java" ? javaSubmissionCode(sourceCode, path.parse(source).name) : sourceCode;
  const cf = parseCodeforcesId(meta.id);
  const taskId = isCsesPlatform(meta.platform) ? csesTaskId(meta) : undefined;

  const submitUrl = submitUrlFor(meta);
  if (!submitUrl) {
    vscode.window.showWarningMessage(`Submit is not supported for ${meta.platform}.`);
    return;
  }

  pendingSubmit = {
    platform: meta.platform,
    id: isCsesPlatform(meta.platform) ? (taskId ?? meta.id) : meta.id,
    contest: cf.contest,
    index: cf.index,
    code,
    language: lang,
    fileName: path.basename(source),
    submitUrl,
    expiresAt: Date.now() + 120_000
  };

  await vscode.env.clipboard.writeText(code);
  void showSubmitQueuedStatus(meta.id, submitUrl, pendingSubmit);
}

async function showSubmitQueuedStatus(problemId: string, submitUrl: string, queued: PendingSubmit): Promise<void> {
  const consumed = await waitForPendingSubmitConsumed(queued, 3500);
  if (consumed) {
    vscode.window.showInformationMessage(`Submitting ${problemId} in Chrome...`);
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    "Submission queued, but the CPOS Chrome companion has not picked it up yet.",
    "Open submit page"
  );
  if (choice === "Open submit page") {
    await vscode.env.openExternal(vscode.Uri.parse(submitUrl));
  }
}

async function waitForPendingSubmitConsumed(queued: PendingSubmit, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pendingSubmit !== queued) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return pendingSubmit !== queued;
}

function parseCodeforcesId(id: string): { contest?: string; index?: string } {
  const match = id.match(/^(\d+)([A-Za-z]\d*)$/);
  if (!match) return {};
  return { contest: match[1], index: match[2].toUpperCase() };
}

// Refresh CF contest phases at most once per minute. On a successful update we
// re-render the panel so the Solution tab appears/disappears with the new data.
async function refreshCfContestList(): Promise<void> {
  const now = Date.now();
  if (cfContestFetching) return;
  if (cfContestLoaded && now - cfContestFetchedAt < 60_000) return;
  cfContestFetching = true;
  try {
    const resp = await fetch("https://codeforces.com/api/contest.list?gym=false");
    if (resp.ok) {
      const json = (await resp.json()) as { status?: string; result?: Array<{ id: number; phase: string }> };
      if (json.status === "OK" && Array.isArray(json.result)) {
        const map = new Map<string, CfContestInfo>();
        for (const c of json.result) map.set(String(c.id), { phase: c.phase });
        cfContestCache = map;
        cfContestFetchedAt = now;
        cfContestLoaded = true;
        refreshActions();
      }
    }
  } catch {
    /* offline / API down — leave cache as-is */
  } finally {
    cfContestFetching = false;
  }
}

// true = contest running (hide solution), false = finished (allow),
// undefined = not yet known (cache not loaded).
function cfContestOngoing(contest: string): boolean | undefined {
  const info = cfContestCache.get(contest);
  if (info) return info.phase !== "FINISHED";
  // Loaded but contest absent → not an official ongoing contest (e.g. old/gym) → allow.
  if (cfContestLoaded) return false;
  return undefined;
}

// Whether the Solution tab must be hidden for this problem. Only Codeforces
// contest problems can be gated; CSES and the CF problemset have no live contest.
function isSolutionBlocked(meta: ProblemMeta | undefined): boolean {
  if (!meta) return false;
  const platform = meta.platform.toLowerCase();
  if (platform !== "codeforces" && platform !== "cf") return false;
  const { contest } = parseCodeforcesId(meta.id);
  if (!contest) return false;
  const ongoing = cfContestOngoing(contest);
  if (ongoing === undefined) {
    // Unknown until we fetch — block now (anti-cheat safe) and refresh.
    void refreshCfContestList();
    return true;
  }
  // Keep phases fresh so the tab unlocks promptly once the contest ends.
  if (cfContestLoaded && Date.now() - cfContestFetchedAt >= 60_000) void refreshCfContestList();
  return ongoing;
}

async function activeSolutionPath(): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.uri.scheme === "file") {
    return editor.document.uri.fsPath;
  }
  return (await loadProblemMeta())?.solutionPath;
}

function csesTaskId(meta: ProblemMeta): string | undefined {
  const fromUrl = meta.url.match(/\/task\/(\d+)/)?.[1];
  if (fromUrl) return fromUrl;
  if (/^\d+$/.test(meta.id)) return meta.id;
  return undefined;
}

function submitUrlFor(meta: ProblemMeta): string | undefined {
  const platform = meta.platform.toLowerCase();
  if (platform === "codeforces" || platform === "cf") {
    const cf = parseCodeforcesId(meta.id);
    if (!cf.contest) return undefined;
    const index = cf.index ? `?submittedProblemIndex=${encodeURIComponent(cf.index)}` : "";
    return `https://codeforces.com/contest/${cf.contest}/submit${index}`;
  }
  if (platform === "cses") {
    const taskId = csesTaskId(meta);
    if (!taskId) return undefined;
    return `https://cses.fi/problemset/submit/${taskId}/`;
  }
  if (platform === "atcoder") {
    const at = atcoderContestTask(meta);
    if (!at) return undefined;
    return `https://atcoder.jp/contests/${at.contest}/submit?taskScreenName=${encodeURIComponent(at.task)}`;
  }
  return undefined;
}

// AtCoder ids are scoped to a contest (e.g. abc300_a in contest abc300). The
// captured URL carries both; the id alone is not enough to build a submit URL.
function atcoderContestTask(meta: ProblemMeta): { contest: string; task: string } | undefined {
  const m = meta.url.match(/atcoder\.jp\/contests\/([^/]+)\/tasks\/([^/?#]+)/);
  if (m) return { contest: m[1], task: m[2] };
  // Fall back to the id's contest prefix (abc300_a → abc300) when the URL is absent.
  const prefix = meta.id.match(/^([a-z0-9]+)_/i);
  if (prefix) return { contest: prefix[1], task: meta.id };
  return undefined;
}

async function loadSamples(source: string): Promise<TestCase[]> {
  try {
    return JSON.parse(await fs.readFile(samplePathFor(source), "utf8")) as TestCase[];
  } catch {
    try {
      return JSON.parse(await fs.readFile(`${source}.samples.json`, "utf8")) as TestCase[];
    } catch {
      return [];
    }
  }
}

function languageForFile(source: string): string {
  const ext = path.extname(source).slice(1);
  const match = Object.entries(DEFAULT_COMMANDS).find(([, value]) => value.extension === ext);
  return match?.[0] ?? resolveDefaultLanguage();
}

function expandCommand(
  command: string,
  source: string,
  outputName: string,
  buildDir: string,
  className = path.parse(source).name
): string {
  // On Windows use full absolute path for .exe so cmd.exe finds the binary
  // even if the current-directory PATH lookup doesn't work as expected.
  const exeExpand = process.platform === "win32"
    ? quoteShellPath(path.join(buildDir, `${outputName}.exe`))
    : `${outputName}.exe`;
  // Replace compound tokens before `{output}` so we never produce `"Hello".exe`.
  return command
    .replaceAll("{output}.jar", `${outputName}.jar`)
    .replaceAll("{output}.exe", exeExpand)
    .replaceAll("{source}", quoteShellPath(source))
    .replaceAll("{output}", outputName)
    .replaceAll("{dir}", quoteShellPath(buildDir))
    .replaceAll("{classname}", outputName === className ? outputName : quoteShellPath(className));
}

/** Quote filesystem paths for the platform shell. */
function quoteShellPath(value: string): string {
  if (process.platform === "win32") {
    // cmd.exe + MinGW/Python: stray quotes become part of filenames/paths on Windows.
    if (!needsWindowsQuoting(value)) return value;
    return `"${value.replace(/"/g, '""')}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function needsWindowsQuoting(value: string): boolean {
  return /[\s"&|<>^()]/.test(value);
}

function runShell(
  command: string,
  input: string,
  cwd: string,
  timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean; timeMs: number }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const shell = shellForRun();
    const child = spawn(shell.file, shell.args(command), {
      cwd,
      env: processEnvForRun(),
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr, timedOut, timeMs: Date.now() - start });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

async function openProblem(): Promise<void> {
  const source = await activeSolutionPath();
  const meta = source ? await loadProblemMetaForFile(source) : await loadProblemMeta();
  if (!meta) {
    vscode.window.showWarningMessage("Capture a problem first.");
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(meta.url));
}

async function searchProblem(): Promise<void> {
  const source = await activeSolutionPath();
  const meta = source ? await loadProblemMetaForFile(source) : await loadProblemMeta();
  if (!meta) {
    vscode.window.showWarningMessage("Link a problem first to search for editorials.");
    return;
  }
  const platformLabel = platformDisplayName(meta.platform);
  const query = `${platformLabel} ${meta.id} ${meta.name} editorial solution`.trim();
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

async function openGithub(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse("https://github.com/Soham109/cpos"));
}

async function openSponsor(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse("https://github.com/sponsors/Soham109"));
}

async function openDiscord(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse("https://discord.gg/QkdmcRKz"));
}

type PanelState = {
  source?: string;
  fileName: string;
  meta?: ProblemMeta;
  tests: TestCase[];
  results: RunResult[];
  serverRunning: boolean;
  serverConflict: boolean;
  running: boolean;
  theme?: string;
  solution?: SolutionState;
  solutionBlocked: boolean;
  config: {
    defaultLanguage: string;
    templates: Record<string, string>;
    languages: string[];
  };
  challenges: Record<string, Challenge>;
  publicChallenges: PublicChallenge[];
  cf: ChallengeCf;
  tabs: PanelTabs;
};

async function currentState(): Promise<PanelState> {
  const source = await activeSolutionPath();
  const meta = source ? await loadProblemMetaForFile(source) : await loadProblemMeta();
  const tests = source ? await loadSamples(source) : [];
  const results = source ? runResults.get(source) ?? [] : [];
  const solution = meta && solutionData?.problemId === meta.id ? solutionData : undefined;
  const sharedConfig = await sharedConfigPayload();
  return {
    source,
    fileName: source ? path.basename(source) : "No active file",
    meta,
    tests,
    results,
    serverRunning: server !== undefined,
    serverConflict,
    running: runningFor === source && source !== undefined,
    theme: extContext?.globalState.get<string>(PANEL_THEME_KEY),
    solution,
    solutionBlocked: isSolutionBlocked(meta),
    config: {
      defaultLanguage: sharedConfig.defaultLanguage,
      templates: sharedConfig.templates,
      languages: Object.keys(DEFAULT_COMMANDS)
    },
    challenges: loadChallenges(),
    publicChallenges: loadPublicChallenges(),
    cf: loadChallengeCf(),
    tabs: loadPanelTabs()
  };
}

function refreshActions(): void {
  actionsProvider?.refresh();
}

function platformDisplayName(platform: string): string {
  switch (platform.toLowerCase()) {
    case "codeforces":
    case "cf":
      return "Codeforces";
    case "cses":
      return "CSES";
    case "atcoder":
      return "AtCoder";
    default:
      return platform;
  }
}

function buildSolutionQuery(meta: ProblemMeta): string {
  const platform = meta.platform.toLowerCase();
  if (platform === "codeforces" || platform === "cf") {
    return `codeforces ${meta.id} ${meta.name} editorial solution`;
  }
  if (platform === "cses") {
    return `cses ${meta.name} solution tutorial`;
  }
  if (platform === "atcoder") {
    return `atcoder ${meta.id} ${meta.name} editorial solution`;
  }
  return `${meta.id} ${meta.name} editorial solution`;
}

async function fetchAndCacheSolution(): Promise<void> {
  const source = await activeSolutionPath();
  const meta = source ? await loadProblemMetaForFile(source) : await loadProblemMeta();
  if (!meta) return;
  // Never fetch solutions for a problem in a live contest, even if a stale
  // webview message slips through after the tab was hidden.
  if (isSolutionBlocked(meta)) return;
  if (solutionData?.problemId === meta.id &&
      (solutionData.status === "done" || solutionData.status === "loading")) return;

  solutionData = { problemId: meta.id, status: "loading", videos: [] };
  refreshActions();

  const videos = await fetchYouTubeVideos(buildSolutionQuery(meta));
  solutionData = { problemId: meta.id, status: videos.length > 0 ? "done" : "error", videos };
  refreshActions();
}

async function fetchYouTubeVideos(query: string): Promise<SolutionVideo[]> {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%3D%3D`;
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseYouTubeVideos(html);
  } catch {
    return [];
  }
}

function parseYouTubeVideos(html: string): SolutionVideo[] {
  // Try structured ytInitialData first (more info: title + channel)
  const markerIdx = html.indexOf("var ytInitialData = ");
  if (markerIdx !== -1) {
    const endIdx = html.indexOf(";</script>", markerIdx);
    if (endIdx !== -1) {
      try {
        const raw = html.slice(markerIdx + "var ytInitialData = ".length, endIdx);
        const data = JSON.parse(raw) as Record<string, unknown>;
        const videos = walkForVideoRenderers(data, 3);
        if (videos.length > 0) return videos;
      } catch { /* fallthrough */ }
    }
  }
  // Fallback: regex extraction of bare video IDs
  const seen = new Set<string>();
  const results: SolutionVideo[] = [];
  const re = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && results.length < 3) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      results.push({ id: m[1], title: "", channel: "" });
    }
  }
  return results;
}

function walkForVideoRenderers(obj: unknown, max: number): SolutionVideo[] {
  const results: SolutionVideo[] = [];
  function walk(o: unknown): void {
    if (!o || typeof o !== "object" || results.length >= max) return;
    if (Array.isArray(o)) {
      for (const item of o) walk(item);
      return;
    }
    const rec = o as Record<string, unknown>;
    if (rec.videoRenderer && typeof rec.videoRenderer === "object") {
      const vr = rec.videoRenderer as Record<string, unknown>;
      if (typeof vr.videoId === "string") {
        const titleRuns = ((vr.title as Record<string, unknown>)?.runs) as unknown[] | undefined;
        const title = Array.isArray(titleRuns)
          ? String((titleRuns[0] as Record<string, unknown>)?.text ?? "") : "";
        const chRuns = ((vr.ownerText as Record<string, unknown>)?.runs) as unknown[] | undefined;
        const channel = Array.isArray(chRuns)
          ? String((chRuns[0] as Record<string, unknown>)?.text ?? "") : "";
        if (title) results.push({ id: vr.videoId, title, channel });
      }
    }
    for (const val of Object.values(rec)) walk(val);
  }
  walk(obj);
  return results;
}

// ---------------------------------------------------------------------------
// Sample visualizer — a full editor-tab webview that draws the captured sample
// tests as the structure they are (graph/tree/grid/matrix/array/permutation/
// intervals/points). All parsing and drawing lives in media/viz-core.js, the
// same engine the browser companions ship; this side only feeds it data.

function vizNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 20000);
}

async function vizData(): Promise<{ tests: TestCase[]; label: string; statement: string }> {
  const source = await activeSolutionPath();
  const tests = source ? await loadSamples(source) : [];
  const meta = await loadProblemMeta();
  const matches = meta && source && meta.solutionPath === source;
  const label = matches && meta ? meta.id : source ? path.parse(source).name : "";
  const statement = matches && meta?.statementHtml ? stripHtml(meta.statementHtml) : "";
  return { tests, label, statement };
}

async function postVizData(): Promise<void> {
  if (!vizPanel) return;
  const { tests, label, statement } = await vizData();
  vizPanel.title = label ? `Viz · ${label}` : "CPOS Visualizer";
  void vizPanel.webview.postMessage({ type: "setData", tests, label, statement });
}

async function refreshVisualizer(): Promise<void> {
  if (vizPanel) await postVizData();
}

// Run the active solution file on one sample input and hand its stderr back to
// the visualizer webview, which animates any #cpos trace lines it contains.
async function runTraceForViz(id: number, input: string): Promise<void> {
  const reply = (payload: { stderr?: string; verdict?: string; actual?: string; error?: string }) => {
    void vizPanel?.webview.postMessage({ type: "traceResult", id, ...payload });
  };
  try {
    const source = await activeSolutionPath();
    if (!source) {
      reply({ error: "No solution file — open your solution in the editor first." });
      return;
    }
    const code = await fs.readFile(source, "utf8");
    if (!code.trim()) {
      reply({ error: `${path.basename(source)} is empty — write your solution first.` });
      return;
    }
    const results = await runCodeAgainstTests(code, languageForFile(source), [{ input, expected: "" }]);
    const r = results[0];
    if (!r) {
      reply({ error: "The runner returned no result." });
      return;
    }
    if (r.verdict === "CE") {
      reply({ error: "Compile error — run the samples in the CPOS panel to see the full message." });
      return;
    }
    reply({ stderr: r.stderr ?? "", verdict: r.verdict, actual: r.actual });
  } catch (error) {
    reply({ error: error instanceof Error ? error.message : String(error) });
  }
}

async function openVisualizer(): Promise<void> {
  if (vizPanel) {
    vizPanel.reveal(undefined, true);
    await postVizData();
    return;
  }
  if (!extContext) return;
  const extensionUri = extContext.extensionUri;
  vizPanel = vscode.window.createWebviewPanel(
    "cpos.visualizer",
    "CPOS Visualizer",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [extensionUri]
    }
  );
  vizPanel.onDidDispose(() => {
    vizPanel = undefined;
  });
  vizPanel.webview.onDidReceiveMessage((message: { type?: string; id?: number; input?: string }) => {
    if (message?.type === "ready") void postVizData();
    if (message?.type === "runTrace") void runTraceForViz(message.id ?? 0, message.input ?? "");
  });
  extContext.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => {
      void vizPanel?.webview.postMessage({ type: "repaint" });
    })
  );
  const coreUri = vizPanel.webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "viz-core.js")
  );
  const nonce = vizNonce();
  const csp = vizPanel.webview.cspSource;
  vizPanel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data:; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    /* Map the CPOS palette onto the live VS Code theme so the drawing always
       matches the editor. viz-core.js reads these vars at render time. */
    --cpos-bg: var(--vscode-editor-background, #14141f);
    --cpos-panel: var(--vscode-sideBar-background, var(--vscode-editor-background, #1b1b2b));
    --cpos-panel-2: var(--vscode-editorWidget-background, #232334);
    --cpos-fg: var(--vscode-editor-foreground, #e8e6f0);
    --cpos-dim: var(--vscode-descriptionForeground, #8b88a0);
    --cpos-border: var(--vscode-editorWidget-border, var(--vscode-panel-border, #2a2a3e));
    --cpos-accent: var(--vscode-textLink-foreground, #b794ff);
    --cpos-ok: var(--vscode-testing-iconPassed, #7ee787);
    --cpos-bad: var(--vscode-testing-iconFailed, #ff7a93);
    --cpos-warn: var(--vscode-editorWarning-foreground, #f0c060);
    background: var(--cpos-bg);
  }
  #root { height: 100vh; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${coreUri}"></script>
<script nonce="${nonce}">
  (function () {
    const vscode = acquireVsCodeApi();
    const root = document.getElementById("root");
    let ctl = null;
    let traceSeq = 0;
    const pendingTraces = new Map();
    function runTrace(input) {
      return new Promise((resolve, reject) => {
        const id = ++traceSeq;
        pendingTraces.set(id, { resolve, reject });
        vscode.postMessage({ type: "runTrace", id, input });
        setTimeout(() => {
          if (pendingTraces.has(id)) {
            pendingTraces.delete(id);
            reject(new Error("run timed out"));
          }
        }, 60000);
      });
    }
    window.addEventListener("message", (event) => {
      const msg = event.data || {};
      if (msg.type === "setData") {
        if (!ctl) {
          ctl = CPOS_VIZ.mount(root, {
            tests: msg.tests,
            problemLabel: msg.label,
            statementText: msg.statement,
            runTrace
          });
        } else {
          ctl.setTests(msg.tests, { problemLabel: msg.label, statementText: msg.statement });
        }
      } else if (msg.type === "repaint" && ctl) {
        ctl.repaint();
      } else if (msg.type === "traceResult") {
        const pending = pendingTraces.get(msg.id);
        if (!pending) return;
        pendingTraces.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error));
        else pending.resolve({ stderr: msg.stderr, verdict: msg.verdict, actual: msg.actual });
      }
    });
    vscode.postMessage({ type: "ready" });
  })();
</script>
</body>
</html>`;
}

class CposActionsProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((message) => void this.onMessage(message));
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.postState();
    });
  }

  refresh(): void {
    void this.postState();
  }

  private async onMessage(message: {
    type?: string;
    index?: number;
    tests?: TestCase[];
    theme?: string;
    language?: string;
    content?: string;
    defaultLanguage?: string;
    opponent?: string;
    problem?: string;
    rating?: number;
    durationMin?: number;
    id?: string;
    on?: boolean;
    min?: number;
    max?: number;
    handle?: string;
    tab?: keyof PanelTabs;
    shown?: boolean;
  }): Promise<void> {
    switch (message.type) {
      case "ready":
        await this.postState();
        break;
      case "chCreate":
        await challengeCreate(message.opponent ?? "", message.problem ?? "", message.rating ?? 1400, message.durationMin ?? 60);
        await this.postState();
        break;
      case "chAccept":
        if (message.id) await challengeSetStatus(message.id, "accept");
        await this.postState();
        break;
      case "chDecline":
        if (message.id) await challengeSetStatus(message.id, "decline");
        await this.postState();
        break;
      case "chRemove":
        if (message.id) await challengeRemove(message.id);
        await this.postState();
        break;
      case "chSetPublic":
        await challengeSetPublic(!!message.on, message.min ?? 800, message.max ?? 3500);
        await this.postState();
        break;
      case "chSetHandle":
        await challengeSetHandle(message.handle ?? "");
        await this.postState();
        break;
      case "chAcceptPublic":
        if (message.id) await challengeAcceptPublic(message.id);
        await this.postState();
        break;
      case "setPanelTab":
        if (
          (message.tab === "statement" || message.tab === "solution" || message.tab === "compete") &&
          typeof message.shown === "boolean"
        ) {
          const tabs = loadPanelTabs();
          tabs[message.tab] = message.shown;
          await savePanelTabs(tabs);
        }
        await this.postState();
        break;
      case "saveTheme":
        if (message.theme) await extContext?.globalState.update(PANEL_THEME_KEY, message.theme);
        break;
      case "saveTemplate":
        if (message.language && typeof message.content === "string") {
          await writeSharedTemplate(message.language, message.content);
        }
        if (message.defaultLanguage) {
          await config().update("defaultLanguage", message.defaultLanguage, vscode.ConfigurationTarget.Global);
        }
        await this.postState();
        vscode.window.showInformationMessage("CPOS: template saved and shared with local CPOS clients.");
        break;
      case "run":
        if (message.tests) await this.persistTests(message.tests);
        await runTests();
        break;
      case "runSingle":
        if (message.tests) await this.persistTests(message.tests);
        if (typeof message.index === "number") await runTests([message.index]);
        break;
      case "submit":
        await submitActiveFile();
        break;
      case "viz":
        await openVisualizer();
        break;
      case "openProblem":
        await openProblem();
        break;
      case "searchProblem":
        await searchProblem();
        break;
      case "openGithub":
        await openGithub();
        break;
      case "openSponsor":
        await openSponsor();
        break;
      case "openDiscord":
        await openDiscord();
        break;
      case "retryServer":
        await startCaptureServer().catch((error) => warnServer(error));
        await this.postState();
        break;
      case "openSource":
        await this.openSource();
        break;
      case "persistTests":
        await this.persistTests(message.tests ?? []);
        break;
      case "fetchSolution":
        void fetchAndCacheSolution();
        break;
      case "openUrl": {
        const url = (message as { url?: string }).url;
        if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }
      default:
        break;
    }
  }

  private async openSource(): Promise<void> {
    const source = await activeSolutionPath();
    if (!source) return;
    const document = await vscode.workspace.openTextDocument(source);
    await vscode.window.showTextDocument(document);
  }

  private async persistTests(tests: TestCase[]): Promise<void> {
    const source = await activeSolutionPath();
    if (!source) return;
    await saveSamples(source, tests);
    const existing = runResults.get(source);
    if (existing) {
      runResults.set(
        source,
        existing.filter((r) => r.index < tests.length)
      );
    }
  }

  private async postState(): Promise<void> {
    if (!this.view) return;
    const state = await currentState();
    void this.view.webview.postMessage({ type: "state", state });
  }

  private html(): string {
    const nonce = String(Date.now());
    const logoUri = this.view!.webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "icon128.png"))
      .toString();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.view!.webview.cspSource} https: data:; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net; frame-src https://www.youtube-nocookie.com https://www.youtube.com;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script nonce="${nonce}">
  window.MathJax = {
    tex: { inlineMath: [['\\\\(', '\\\\)']], displayMath: [['$$', '$$'], ['\\\\[', '\\\\]']] },
    svg: { fontCache: 'global' },
    startup: { typeset: false }
  };
</script>
<script async nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
<style>
  :root {
    --mono: var(--vscode-editor-font-family, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
    --radius: 6px;
    --pad: 12px;
    --fontsize: 12px;
  }

  /* ── Theme: CPOS (signature purple) ───────────────────────── */
  body[data-theme="cpos"] {
    --bg: #0c0c13;
    --panel: #14141f;
    --input-bg: #0a0a11;
    --fg: #e7e7f2;
    --dim: #8d8da6;
    --border: #2c2c40;
    --border-soft: #20202e;
    --accent: #b794ff;
    --accent-dim: #7c5cbf;
    --accent-on: #14141f;
    --highlight: #221c3a;
    --ok: #7ee787;
    --bad: #ff7a93;
    --warn: #f0c060;
    --cf: #79b8ff;
  }

  /* ── Theme: Midnight (calm slate-blue) ────────────────────── */
  body[data-theme="midnight"] {
    --bg: #0d1117;
    --panel: #161b22;
    --input-bg: #0a0e14;
    --fg: #e6edf3;
    --dim: #8b98a8;
    --border: #2a313c;
    --border-soft: #1d242e;
    --accent: #6cb6ff;
    --accent-dim: #3b6ea5;
    --accent-on: #0d1117;
    --highlight: #16263d;
    --ok: #6fd58a;
    --bad: #ff7a93;
    --warn: #e3b341;
    --cf: #79b8ff;
  }

  /* ── Theme: Amber (warm terminal) ─────────────────────────── */
  body[data-theme="amber"] {
    --bg: #14110a;
    --panel: #1d1810;
    --input-bg: #100d07;
    --fg: #f0e6d2;
    --dim: #a89878;
    --border: #3a3220;
    --border-soft: #2a2418;
    --accent: #f0b860;
    --accent-dim: #aa7c30;
    --accent-on: #14110a;
    --highlight: #2e2510;
    --ok: #b8c46a;
    --bad: #e88a6a;
    --warn: #f0c060;
    --cf: #d8b87a;
  }

  /* ── Theme: Paper (high-contrast grayscale) ───────────────── */
  body[data-theme="paper"] {
    --bg: #101010;
    --panel: #191919;
    --input-bg: #0b0b0b;
    --fg: #f0f0f0;
    --dim: #9a9a9a;
    --border: #3a3a3a;
    --border-soft: #2a2a2a;
    --accent: #e0e0e0;
    --accent-dim: #8a8a8a;
    --accent-on: #101010;
    --highlight: #262626;
    --ok: #c8d4c8;
    --bad: #d6b0b0;
    --warn: #d4c89c;
    --cf: #c4c4c4;
  }

  /* ── Theme: Native (matches your VS Code color theme) ─────── */
  body[data-theme="native"] {
    --bg: var(--vscode-sideBar-background);
    --panel: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    --input-bg: var(--vscode-input-background, var(--vscode-editor-background));
    --fg: var(--vscode-sideBar-foreground, var(--vscode-foreground));
    --dim: var(--vscode-descriptionForeground, #888);
    --border: var(--vscode-panel-border, var(--vscode-editorWidget-border, #3a3a3a));
    --border-soft: var(--vscode-panel-border, #2a2a2a);
    --accent: var(--vscode-textLink-foreground, #4daafc);
    --accent-dim: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground, #3b6ea5));
    --accent-on: var(--vscode-button-foreground, #ffffff);
    --highlight: var(--vscode-list-hoverBackground, rgba(128,128,128,0.12));
    --ok: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #4caf50));
    --bad: var(--vscode-testing-iconFailed, var(--vscode-errorForeground, #f14c4c));
    --warn: var(--vscode-charts-yellow, #e3b341);
    --cf: var(--vscode-charts-blue, #4daafc);
    --btn-bg: var(--vscode-button-background, #007acc);
    --btn-fg: var(--vscode-button-foreground, #ffffff);
    --btn-hover: var(--vscode-button-hoverBackground, #006bb3);
    --btn-border: var(--vscode-button-border, var(--btn-bg));
    --btn-secondary-bg: var(--vscode-button-secondaryBackground, var(--highlight));
    --btn-secondary-fg: var(--vscode-button-secondaryForeground, var(--dim));
  }

  * { box-sizing: border-box; }
  * {
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--dim) 45%, transparent) transparent;
  }
  *::-webkit-scrollbar { width: 8px; height: 8px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--dim) 42%, transparent);
    border: 2px solid transparent;
    border-radius: 999px;
    background-clip: padding-box;
  }
  *::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--accent) 55%, transparent);
    background-clip: padding-box;
  }
  html {
    height: 100%;
    overflow: hidden;
  }
  body {
    margin: 0;
    padding: var(--pad) 10px;
    height: 100%;
    overflow: hidden;
    color: var(--fg);
    background: var(--bg);
    font-family: var(--mono);
    font-size: var(--fontsize);
    line-height: 1.5;
  }
  #app {
    height: calc(100vh - (var(--pad) * 2));
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .link { color: var(--accent); cursor: pointer; }
  .link:hover { text-decoration: underline; }
  .muted { color: var(--dim); }

  .box {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--panel);
  }

  .head { padding: 11px 12px; margin-bottom: 10px; container-type: inline-size; }
  .head .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; max-width: 100%; min-width: 0; overflow: hidden; }
  .brandrow { display: flex; align-items: center; gap: 7px; flex: 0 0 auto; }
  .logo {
    width: 16px; height: 16px; border-radius: 4px; flex-shrink: 0;
    display: block; object-fit: contain;
  }
  .title { font-weight: 700; font-size: 13px; color: var(--fg); letter-spacing: 0.08em; }
  .rule { height: 1px; background: var(--border-soft); margin: 9px 0; }

  /* header icon buttons */
  .headtools { display: inline-flex; align-items: center; justify-content: flex-end; gap: 5px; flex: 1 1 auto; min-width: 0; max-width: 100%; overflow: hidden; }
  .iconbtn {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--dim);
    border-radius: 5px;
    padding: 3px 7px;
    font-size: 10px;
    cursor: pointer;
    line-height: 1;
    font-family: var(--mono);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 auto;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    white-space: nowrap;
  }
  .iconbtn .btn-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .iconbtn:hover { border-color: var(--accent-dim); }
  .iconbtn svg { width: 12px; height: 12px; flex-shrink: 0; }
  .iconbtn.gh {
    background: #0d1117;
    border-color: #30363d;
    color: #f0f6fc;
  }
  .iconbtn.gh:hover { background: #161b22; border-color: #484f58; color: #fff; }
  .iconbtn.icononly { padding: 4px; justify-content: center; }
  .iconbtn.squeezed { display: none; }
  .iconbtn.sponsor {
    background: color-mix(in srgb, #db61a2 18%, transparent);
    border-color: color-mix(in srgb, #db61a2 46%, var(--border));
    color: #f08fc0;
  }
  .iconbtn.sponsor svg { color: #db61a2; }
  .iconbtn.sponsor:hover {
    background: color-mix(in srgb, #db61a2 30%, transparent);
    border-color: #db61a2;
    color: #fbcfe5;
  }
  .iconbtn.discord {
    background: color-mix(in srgb, #5865f2 16%, transparent);
    border-color: color-mix(in srgb, #5865f2 46%, var(--border));
    color: #aeb5ff;
  }
  .iconbtn.discord:hover {
    background: color-mix(in srgb, #5865f2 28%, transparent);
    border-color: #5865f2;
    color: #fff;
  }
  .iconbtn.theme {
    background: color-mix(in srgb, var(--accent-dim) 32%, transparent);
    border-color: var(--accent-dim);
    color: var(--accent);
  }
  .iconbtn.theme:hover {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    color: var(--accent);
  }
  .iconbtn:disabled { opacity: 0.4; cursor: default; pointer-events: none; }
  .actions button:disabled { opacity: 0.45; cursor: default; }
  .themebar {
    display: none;
    gap: 7px;
    flex-wrap: wrap;
    padding: 9px 12px;
    margin-bottom: 10px;
  }
  .themebar.open { display: flex; }
  .swatch {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 8px;
    background: transparent;
    color: var(--dim);
    font-size: 9px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    min-width: 52px;
  }
  .swatch:hover { border-color: var(--accent-dim); color: var(--fg); }
  .swatch.active { border-color: var(--accent); color: var(--accent); }
  .swatch .chips { display: flex; gap: 3px; }
  .swatch .chip { width: 12px; height: 12px; border-radius: 3px; }

  .pline { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
  .tag {
    font-size: 9px;
    font-weight: 700;
    padding: 1px 5px;
    border: 1px solid var(--border);
    color: var(--dim);
    letter-spacing: 0.06em;
  }
  .tag.codeforces { color: var(--cf); border-color: var(--border); }
  .tag.cses { color: var(--ok); border-color: var(--border); }
  .tag.atcoder { color: #b9c0c9; border-color: var(--border); }
  .pid { font-weight: 700; font-size: 14px; color: var(--fg); }
  .problem-link {
    border: none;
    background: transparent;
    color: var(--accent);
    padding: 0;
    border-radius: 0;
    font-size: 14px;
    font-weight: 700;
    line-height: 1.35;
    text-align: left;
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--accent) 55%, transparent);
    text-underline-offset: 2px;
  }
  .problem-link:hover {
    color: var(--accent);
    background: transparent;
    text-decoration-color: var(--accent);
  }
  .problem-link-icon {
    display: inline-block;
    margin-left: 4px;
    color: var(--accent);
    font-size: 10px;
    line-height: 1;
    text-decoration: none;
    transform: translateY(-1px);
  }
  .rating { color: var(--warn); font-size: 11px; }
  .pname { color: var(--fg); opacity: 0.82; font-size: 11px; margin-top: 3px; }
  .fileline { margin-top: 7px; font-size: 10px; color: var(--dim); }

  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 0; }
  .stat { padding: 5px 4px; text-align: center; background: color-mix(in srgb, var(--panel) 88%, transparent); }
  .stat .num { font-size: 13px; font-weight: 700; line-height: 1.2; }
  .stat .num.ok { color: var(--ok); }
  .stat .num.bad { color: var(--bad); }
  .stat .num.accent { color: var(--accent); }
  .stat .lbl {
    font-size: 8px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--dim);
    margin-top: 2px;
  }

  .actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin-bottom: 0; }
  button.viz-action { grid-column: 1 / -1; }
  button {
    font-family: var(--mono);
    font-size: 11px;
    cursor: pointer;
    padding: 7px 8px;
    border-radius: 3px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--fg);
  }
  button:hover:not(.primary) { border-color: var(--accent-dim); background: var(--highlight); }
  button.problem-link:hover:not(.primary) {
    border-color: transparent;
    background: transparent;
    color: var(--accent);
    text-decoration-color: var(--accent);
  }
  button:active { opacity: 0.85; }
  button.primary {
    border-color: var(--accent-dim);
    background: var(--accent-dim);
    color: var(--fg);
    font-weight: 700;
  }
  button.primary:hover { background: var(--accent); border-color: var(--accent); color: var(--accent-on); }
  button.submit-action {
    border-color: color-mix(in srgb, var(--ok) 58%, var(--border));
    background: color-mix(in srgb, var(--ok) 18%, transparent);
    color: var(--ok);
    font-weight: 700;
  }
  button.submit-action:hover {
    border-color: var(--ok);
    background: color-mix(in srgb, var(--ok) 30%, transparent);
    color: var(--fg);
  }
  button.primary:disabled {
    opacity: 0.45;
    cursor: default;
    background: var(--highlight);
    border-color: var(--border);
  }
  /* Native theme: VS Code primary button (white label on theme button bg) */
  body[data-theme="native"] button.primary {
    background: var(--btn-bg);
    color: var(--btn-fg);
    border-color: var(--btn-border);
  }
  body[data-theme="native"] button.primary:hover {
    background: var(--btn-hover);
    border-color: var(--btn-hover);
    color: var(--btn-fg);
  }
  body[data-theme="native"] button.primary:disabled {
    opacity: 1;
    background: var(--btn-secondary-bg);
    color: var(--btn-secondary-fg);
    border-color: var(--btn-border, var(--border));
  }
  button.ghost {
    padding: 2px 7px;
    font-size: 10px;
    color: var(--dim);
    background: transparent;
  }
  button.ghost:hover { color: var(--accent); border-color: var(--accent-dim); }

  .section {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 4px 0 8px;
    font-size: 9px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--dim);
  }

  /* Tests tab: keep the app chrome calm and put long sample scrolling inside
     the editors instead of turning the whole side panel into a long page. */
  .tests-wrapper {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow: hidden;
    padding-right: 0;
  }
  .tests-command {
    flex: 0 0 auto;
    display: grid;
    gap: 7px;
  }
  .tests-list-head {
    flex: 0 0 auto;
    margin: 0;
  }
  .tests-list {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 2px;
  }

  .test { margin-bottom: 8px; overflow: hidden; }
  .test:last-child { margin-bottom: 0; }
  .test.pass { border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); }
  .test.fail { border-color: color-mix(in srgb, var(--bad) 45%, var(--border)); }
  .test.collapsed .test-head { border-bottom: none; }
  .test.collapsed .test-body { display: none; }
  .test-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 9px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--highlight);
  }
  .test-title { display: flex; align-items: center; gap: 8px; font-size: 11px; }
  .test-title .idx { color: var(--fg); font-weight: 700; }
  .collapse-toggle {
    padding: 1px 6px;
    min-width: 20px;
    color: var(--dim);
    font-size: 10px;
    line-height: 1.35;
  }
  .collapse-toggle:hover { color: var(--accent); }
  .verdict {
    font-size: 9px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 3px;
    border: 1px solid var(--border);
    letter-spacing: 0.04em;
    color: var(--dim);
  }
  .verdict.AC { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 50%, var(--border)); }
  .verdict.WA, .verdict.CE { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 50%, var(--border)); }
  .verdict.TLE, .verdict.RE { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 50%, var(--border)); }
  .verdict.run { color: var(--accent); border-color: var(--accent-dim); }
  .verdict.none { display: none; }
  .test-body { padding: 8px; display: flex; flex-direction: column; gap: 7px; min-height: 0; }
  .io-grid {
    display: grid;
    grid-template-columns: var(--io-in-pct, 68%) 6px minmax(0, 1fr);
    gap: 0;
    align-items: stretch;
    min-height: 0;
  }
  .io-col { min-width: 0; display: flex; flex-direction: column; }
  .io-splitter {
    cursor: col-resize;
    background: var(--border-soft);
    border-radius: 2px;
    margin: 18px 0 0;
    align-self: stretch;
    touch-action: none;
  }
  .io-splitter:hover, .io-splitter.dragging { background: var(--accent-dim); }
  .io-input-box, .io-exp-box {
    position: relative;
    height: clamp(132px, calc(100vh - 365px), 300px);
    min-height: 0;
    border-radius: 4px;
    border: 1px solid var(--border-soft);
    background: var(--input-bg);
    overflow: hidden;
  }
  .io-input-box:focus-within, .io-exp-box:focus-within { border-color: var(--accent-dim); }
  .io-line-bg, .io-exp-line-bg {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 0;
    padding: 6px 7px 6px 0;
    overflow: hidden;
  }
  .io-line-bg .ln, .io-exp-line-bg .ln {
    display: flex;
    align-items: stretch;
    min-height: calc(11px * 1.4);
    line-height: 1.4;
    font-size: 11px;
    font-family: var(--mono);
    border-radius: 2px;
    white-space: pre;
    overflow: hidden;
  }
  .io-line-bg .ln-gutter, .io-exp-line-bg .ln-gutter {
    flex: 0 0 18px;
    text-align: right;
    padding-right: 5px;
    color: var(--dim);
    font-size: 9px;
    opacity: 0;
    user-select: none;
  }
  .io-line-bg .ln.blk-hi .ln-gutter, .io-exp-line-bg .ln.blk-hi .ln-gutter { opacity: 1; color: var(--warn); }
  .io-line-bg .ln-txt, .io-exp-line-bg .ln-txt {
    flex: 1;
    min-width: 0;
    padding-right: 4px;
    visibility: hidden;
  }
  .io-line-bg .ln.blk-odd, .io-exp-line-bg .ln.blk-odd { background: rgba(128, 128, 128, 0.11); }
  .io-line-bg .ln.blk-even, .io-exp-line-bg .ln.blk-even { background: transparent; }
  .io-line-bg .ln.blk-hi, .io-exp-line-bg .ln.blk-hi {
    background: rgba(240, 192, 96, 0.38) !important;
  }
  .io-input-box textarea.in, .io-exp-box textarea.exp {
    position: relative;
    z-index: 1;
    display: block;
    width: 100%;
    height: 100%;
    min-height: 0;
    resize: none;
    border: none;
    background: transparent;
    color: var(--fg);
    padding: 6px 7px 6px 25px;
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.4;
    overflow-y: auto;
    caret-color: var(--fg);
  }
  .io-input-box textarea.in, .io-exp-box textarea.exp { scrollbar-gutter: stable; }
  .io-input-box textarea.in:focus, .io-exp-box textarea.exp:focus { outline: none; }
  label {
    font-size: 8px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--dim);
    margin-bottom: 3px;
    display: block;
  }
  textarea {
    width: 100%;
    resize: vertical;
    font-family: var(--mono);
    font-size: 11px;
    padding: 6px 7px;
    border-radius: 4px;
    border: 1px solid var(--border-soft);
    background: var(--input-bg);
    color: var(--fg);
    line-height: 1.4;
    overflow-y: auto;
  }
  textarea:focus { outline: none; border-color: var(--accent-dim); }
  .got {
    white-space: pre-wrap;
    font-family: var(--mono);
    font-size: 11px;
    padding: 6px 7px;
    border-radius: 4px;
    background: var(--input-bg);
    border: 1px solid var(--border-soft);
    max-height: 120px;
    overflow-y: auto;
  }
  .got.fail { border-color: color-mix(in srgb, var(--bad) 45%, var(--border)); color: var(--bad); }
  .test-actions { display: flex; gap: 4px; }
  .time { font-size: 10px; color: var(--ok); }
  .empty {
    padding: 18px 12px;
    text-align: center;
    color: var(--dim);
    line-height: 1.6;
    border-style: dashed;
  }
  .tabs { flex: 0 0 auto; display: flex; gap: 2px; margin-bottom: 10px; border-bottom: 1px solid var(--border-soft); overflow-x: auto; scrollbar-width: none; }
  .tabs::-webkit-scrollbar { display: none; }
  .tab { padding: 7px 10px; border: none; background: transparent; color: var(--dim); cursor: pointer; border-bottom: 2px solid transparent; font-size: 11px; font-family: var(--mono); text-transform: uppercase; letter-spacing: 0.04em; }
  .tab.active { color: var(--fg); border-bottom-color: var(--accent); font-weight: 700; }
  .tab:hover:not(.active) { color: var(--fg); }
  .tab { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; }
  .tab-ico { display: none; align-items: center; }
  .tab-ico svg { width: 14px; height: 14px; display: block; }
  .tab.compact { padding-left: 8px; padding-right: 8px; }
  .tab.compact .tab-label { display: none; }
  .tab.compact .tab-ico { display: inline-flex; }
  .head .row { flex-wrap: nowrap; }
  .brandrow { flex: 0 0 auto; min-width: 0; }
  .headtools { flex: 1 1 auto; min-width: 0; max-width: 100%; overflow: hidden; justify-content: flex-end; }
  .iconbtn.compact { padding-left: 6px; padding-right: 6px; }
  .iconbtn.compact .btn-label { display: none; }
  @container (max-width: 560px) {
    .headtools .iconbtn[data-prio="0"] .btn-label,
    .headtools .iconbtn[data-prio="1"] .btn-label { display: none; }
    .headtools .iconbtn[data-prio="0"],
    .headtools .iconbtn[data-prio="1"] { padding-left: 6px; padding-right: 6px; }
  }
  @container (max-width: 460px) {
    .headtools .iconbtn[data-prio="2"] .btn-label { display: none; }
    .headtools .iconbtn[data-prio="2"] { padding-left: 6px; padding-right: 6px; }
  }
  @container (max-width: 390px) {
    .headtools .iconbtn[data-prio="3"] .btn-label { display: none; }
    .headtools .iconbtn[data-prio="3"] { padding-left: 6px; padding-right: 6px; }
  }
  .settings-tab {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 5px 8px; color: #fff; margin-left: auto;
    position: sticky; right: 0; background: var(--bg); box-shadow: -8px 0 8px var(--bg);
  }
  .settings-tab svg { width: 13px; height: 13px; }
  .settings-tab:hover, .settings-tab.active { color: #fff; border-bottom-color: var(--accent); }
  .config-wrapper { overflow: auto; min-height: 0; padding-bottom: 8px; }
  .config-heading { margin: 2px 2px 12px; }
  .config-heading h2 { margin: 0 0 4px; font-size: 16px; }
  .config-card { padding: 12px; display: flex; flex-direction: column; gap: 11px; margin-bottom: 8px; }
  .config-title { font-weight: 700; font-size: 12px; color: var(--fg); }
  .config-tab-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px solid var(--border-soft); cursor: pointer; }
  .config-tab-row:first-of-type { border-top: 0; }
  .config-tab-row input {
    appearance: none;
    -webkit-appearance: none;
    width: 17px;
    height: 17px;
    flex: 0 0 17px;
    display: grid;
    place-items: center;
    margin: 0;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--input-bg);
    color: var(--accent-on);
    cursor: pointer;
    transition: border-color .12s ease, background .12s ease, box-shadow .12s ease;
  }
  .config-tab-row input::after {
    content: "";
    width: 8px;
    height: 4px;
    border-left: 2px solid currentColor;
    border-bottom: 2px solid currentColor;
    transform: translateY(-1px) rotate(-45deg) scale(0);
    transition: transform .12s ease;
  }
  .config-tab-row input:checked {
    border-color: var(--accent);
    background: var(--accent);
  }
  .config-tab-row input:checked::after { transform: translateY(-1px) rotate(-45deg) scale(1); }
  .config-tab-row input:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent); }
  .config-tab-row input:disabled {
    border-color: var(--border);
    background: var(--border-soft);
    color: var(--dim);
    cursor: default;
    opacity: .8;
  }
  .config-tab-row:has(input:disabled) { cursor: default; }
  .config-tab-copy { display: flex; flex-direction: column; gap: 2px; }
  .config-tab-copy small { color: var(--dim); font-size: 10px; }
  /* Compete */
  .cmp-wrap { display: flex; flex-direction: column; gap: 10px; overflow: auto; min-height: 0; padding-bottom: 8px; }
  .cmp-card { border: 1px solid var(--border); border-radius: 8px; padding: 11px; background: var(--panel); }
  .cmp-card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:9px; }
  .cmp-card-title { font-size:12px; font-weight:700; }
  .cmp-card-note { color:var(--dim); font-size:10px; line-height:1.45; margin-top:2px; }
  .cmp-identity { display:flex; gap:7px; align-items:center; }
  .cmp-identity .cmp-in { flex:1; }
  .cmp-form { display: flex; flex-direction: column; gap: 7px; }
  .cmp-segment { display:flex; gap:3px; padding:3px; background:var(--input-bg); border:1px solid var(--border-soft); border-radius:7px; }
  .cmp-segment button { flex:1; border:0; border-radius:5px; padding:6px; color:var(--dim); background:transparent; font:inherit; cursor:pointer; }
  .cmp-segment button:hover { border-color:transparent; background:var(--highlight); color:var(--fg); }
  .cmp-segment button.active { color:var(--fg); background:var(--panel); box-shadow:0 0 0 1px var(--border); }
  .cmp-segment button.active:hover { background:var(--panel); }
  .cmp-in { width: 100%; box-sizing: border-box; padding: 7px 9px; border-radius: 6px; border: 1px solid var(--border); background: var(--input-bg); color: var(--fg); font: inherit; font-size: 12px; }
  .cmp-in:focus { outline: none; border-color: var(--accent); }
  .cmp-field { display:flex; flex-direction:column; gap:4px; }
  .cmp-field > label { color:var(--dim); font-size:9px; text-transform:uppercase; letter-spacing:.07em; }
  .cmp-row2 { display: flex; gap: 7px; }
  .cmp-row2 > * { flex: 1; min-width: 0; }
  .cmp-send { width: 100%; padding: 9px; border: 0; border-radius: 7px; background: var(--accent); color: var(--accent-on); font: inherit; font-weight: 700; font-size: 12px; cursor: pointer; }
  button.cmp-send:hover { border: 0; background: var(--accent); color: var(--accent-on); filter: brightness(1.08); opacity: 1; }
  .cmp-send:disabled { opacity: .5; cursor: default; filter: none; }
  .cmp-msg { font-size: 11px; color: var(--dim); min-height: 14px; }
  .cmp-pub { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .cmp-pub-lbl { flex: 1; }
  .cmp-range { width: 56px; box-sizing: border-box; padding: 5px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--input-bg); color: var(--fg); font: inherit; font-size: 11px; text-align: center; }
  .cmp-dash { color: var(--dim); }
  .cmp-toggle { width: 34px; height: 19px; border-radius: 999px; border: 1px solid var(--border); background: var(--border-soft); position: relative; cursor: pointer; flex: 0 0 auto; padding: 0; }
  .cmp-toggle > span { position: absolute; width: 13px; height: 13px; border-radius: 50%; background: var(--dim); top: 2px; left: 2px; transition: .16s; }
  .cmp-toggle.on { background: var(--accent); border-color: var(--accent); }
  .cmp-toggle.on > span { transform: translateX(15px); background: var(--accent-on); }
  .cmp-listhead { color: var(--dim); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; margin-top: 2px; }
  .cmp-list { display: flex; flex-direction: column; gap: 6px; }
  .cmp-item { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border: 1px solid var(--border); border-radius: 7px; }
  .cmp-who { flex: 1; min-width: 0; }
  .cmp-prob { color: var(--accent); font-weight: 600; font-size: 12px; text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; cursor: pointer; }
  .cmp-sub { color: var(--dim); font-size: 11px; }
  .cmp-mini { padding: 5px 9px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--fg); font: inherit; font-size: 11px; cursor: pointer; }
  .cmp-mini:hover { border-color: var(--accent); color: var(--accent); }
  .cmp-mini.solid { background: var(--accent); color: var(--accent-on); border-color: var(--accent); }
  button.cmp-mini.solid:hover { background: var(--accent); color: var(--accent-on); border-color: var(--accent); filter: brightness(1.08); }
  .cmp-badge { font-size: 10px; font-weight: 700; color: #fff; padding: 3px 7px; border-radius: 20px; white-space: nowrap; }
  .cmp-x { border: 0; background: transparent; color: var(--dim); cursor: pointer; font-size: 11px; padding: 2px 4px; }
  .config-note { color: var(--dim); font-size: 10px; line-height: 1.45; }
  .config-field { display: flex; flex-direction: column; gap: 5px; }
  .config-field label { color: var(--dim); font-size: 9px; text-transform: uppercase; letter-spacing: .08em; }
  .config-field select, .config-field textarea {
    width: 100%; color: var(--fg); background: var(--bg);
    border: 1px solid var(--border); border-radius: 6px; font: inherit;
  }
  .config-field select { padding: 7px 8px; }
  .config-field input { width: 100%; box-sizing: border-box; color: var(--fg); background: var(--input-bg); border: 1px solid var(--border); border-radius: 6px; font: inherit; padding: 7px 8px; }
  .config-field input:focus { outline: none; border-color: var(--accent); }
  .config-toggle { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--fg); cursor: pointer; }
  .config-toggle input { width: auto; }
  .config-field textarea { min-height: 260px; padding: 9px; resize: vertical; line-height: 1.45; tab-size: 4; }
  .config-buttons { display: flex; gap: 6px; flex-wrap: wrap; }
  .config-buttons button {
    border: 1px solid var(--border); border-radius: 6px; padding: 6px 9px;
    color: var(--fg); background: var(--btn-secondary-bg); font: inherit; cursor: pointer;
  }
  .config-buttons button.primary { color: var(--btn-fg); background: var(--btn-bg); border-color: var(--btn-border); }
  @media (max-width: 355px) {
    .cmp-row2, .cmp-identity { flex-direction:column; align-items:stretch; }
  }
  .statement-view {
    max-width: 980px;
    margin: 0 auto;
    padding: 20px 8px 28px 8px;
    color: var(--fg);
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: 14px;
    line-height: 1.65;
  }
  .statement-view pre {
    background: var(--input-bg);
    padding: 10px 12px;
    border: 1px solid var(--border-soft);
    overflow-x: auto;
    font-family: var(--mono);
    font-size: 12px;
    margin: 10px 0;
  }
  .statement-view code {
    font-family: var(--mono);
    background: var(--highlight);
    padding: 1px 4px;
    font-size: 0.9em;
  }
  .statement-view h1, .statement-view h2, .statement-view h3 {
    margin-top: 1.4em;
    margin-bottom: 0.55em;
    color: var(--fg);
    font-weight: 700;
  }
  .statement-view p { margin: 11px 0; }
  .statement-view ul, .statement-view ol { padding-left: 22px; margin: 10px 0; }
  .statement-view .property-title { font-weight: 700; }
  .statement-view .math { display: inline-block; }
  .statement-view .header {
    text-align: center;
    margin: 0 auto 22px auto;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border-soft);
  }
  .statement-view .header .title {
    font-size: 22px;
    line-height: 1.25;
    font-weight: 700;
    letter-spacing: 0;
    color: var(--fg);
    margin-bottom: 10px;
  }
  .statement-view .time-limit,
  .statement-view .memory-limit {
    display: inline-flex;
    gap: 4px;
    align-items: baseline;
    margin: 2px 10px;
    color: var(--dim);
    font-size: 12px;
  }
  .statement-view .time-limit .property-title,
  .statement-view .memory-limit .property-title {
    color: var(--fg);
    font-weight: 700;
  }
  .statement-view .input-specification,
  .statement-view .output-specification,
  .statement-view .note,
  .statement-view .sample-tests {
    margin: 24px 0 0 0;
    padding: 0;
    background: transparent;
    border: none;
  }
  .statement-view .input-specification .section-title,
  .statement-view .output-specification .section-title,
  .statement-view .note .section-title,
  .statement-view .sample-tests .section-title,
  .statement-view .input-specification > div:first-child,
  .statement-view .output-specification > div:first-child,
  .statement-view .note > div:first-child {
    display: block;
    margin: 0 0 8px 0;
    padding-bottom: 5px;
    color: var(--fg);
    border-bottom: 1px solid var(--border-soft);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: none;
  }
  .statement-view .input-specification p:last-child,
  .statement-view .output-specification p:last-child,
  .statement-view .note p:last-child {
    margin-bottom: 0;
  }
  /* CSES statement normalization — match the Codeforces layout */
  .statement-view .cses-title {
    text-align: center;
    font-size: 22px;
    line-height: 1.25;
    font-weight: 700;
    color: var(--fg);
    margin: 0 auto 10px auto;
    padding: 0;
    border: none;
  }
  .statement-view .task-constraints {
    list-style: none;
    text-align: center;
    margin: 0 auto 22px auto;
    padding: 0 0 16px 0;
    border-bottom: 1px solid var(--border-soft);
  }
  .statement-view .task-constraints li {
    display: inline-block;
    margin: 2px 10px;
    color: var(--dim);
    font-size: 12px;
  }
  .statement-view .task-constraints li b {
    color: var(--fg);
    font-weight: 700;
  }
  .statement-view .md h1 {
    margin: 24px 0 8px 0;
    padding-bottom: 5px;
    color: var(--fg);
    border-bottom: 1px solid var(--border-soft);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0;
  }
  .statement-view-wrapper {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 6px;
  }

  /* ── Statement tab: appended sample tests ─────────────────── */
  .stmt-sample { margin: 14px 0 0 0; }
  .stmt-sample-hdr { font-size: 11px; font-weight: 700; color: var(--fg); margin-bottom: 6px; }
  .stmt-sample-io { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .stmt-sample-lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--dim); margin-bottom: 3px; }
  .stmt-sample-pre {
    margin: 0; padding: 7px 9px; background: var(--input-bg);
    border: 1px solid var(--border-soft); border-radius: 4px;
    font-size: 11px; font-family: var(--mono); white-space: pre;
    overflow-x: auto; line-height: 1.45; cursor: default;
  }
  .stmt-blk { display: block; border-radius: 2px; }
  .stmt-blk-odd  { background: rgba(128,128,128,0.10); }
  .stmt-blk-even { background: transparent; }

  /* ── Solution tab ─────────────────────────────────────────── */
  .sol-wrapper {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 0 6px 12px 0;
  }
  .accordion {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    margin-bottom: 8px;
  }
  .acc-header {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 9px 12px;
    background: var(--panel);
    border: none;
    color: var(--fg);
    cursor: pointer;
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 700;
    text-align: left;
    letter-spacing: 0.04em;
  }
  .acc-header:hover { background: var(--highlight); }
  .acc-arrow { color: var(--dim); font-size: 12px; transition: transform 0.18s; display: inline-block; }
  .acc-arrow.closed { transform: rotate(-90deg); }
  .acc-body { display: none; border-top: 1px solid var(--border-soft); }
  .acc-body.open { display: block; }
  .sol-video-card { padding: 10px 10px 12px; border-bottom: 1px solid var(--border-soft); }
  .sol-video-card:last-child { border-bottom: none; }
  .sol-video-meta { font-size: 11px; margin-bottom: 8px; color: var(--fg); line-height: 1.4; }
  .sol-channel { color: var(--dim); font-size: 10px; }
  .sol-video-wrap { position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; border-radius: 4px; background: #000; }
  .sol-video-wrap iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none; }
  .sol-video-thumb { cursor: pointer; border: 1px solid var(--border-soft); }
  .sol-thumb-img { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.18s, filter 0.18s; }
  .sol-video-thumb:hover .sol-thumb-img, .sol-video-thumb:focus-visible .sol-thumb-img { transform: scale(1.04); filter: brightness(0.78); }
  .sol-play-badge {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: 46px; height: 32px; border-radius: 7px;
    background: rgba(18,18,18,0.78); color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; padding-left: 2px; pointer-events: none;
    transition: background 0.18s, transform 0.18s; box-shadow: 0 1px 6px rgba(0,0,0,0.4);
  }
  .sol-video-thumb:hover .sol-play-badge, .sol-video-thumb:focus-visible .sol-play-badge { background: #cc0000; transform: translate(-50%, -50%) scale(1.08); }
  .sol-spinner { padding: 14px 12px; color: var(--dim); font-size: 11px; text-align: center; }
  .sol-empty { padding: 12px; color: var(--dim); font-size: 11px; }
  .sol-embed-err { padding: 10px 12px; font-size: 10px; color: var(--dim); font-style: italic; }
  .sol-link {
    padding: 9px 12px;
    font-size: 11px;
    cursor: pointer;
    color: var(--accent);
    border-bottom: 1px solid var(--border-soft);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sol-link:hover { background: var(--highlight); }
  .sol-link:last-child { border-bottom: none; }
  .sol-no-meta { padding: 18px 12px; text-align: center; color: var(--dim); line-height: 1.6; border-style: dashed; }

</style>
</head>
<body>
  <div id="app"></div>
<script nonce="${nonce}">
  const CPOS_LOGO = ${JSON.stringify(logoUri)};
  const GH_ICON = '<svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.18.82.63-.18 1.31-.27 1.98-.27.67 0 1.35.09 1.98.27 1.51-1.04 2.18-.82 2.18-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
  const HEART_ICON = '<svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M8 14.25.345 6.595a3.75 3.75 0 1 1 5.305-5.305L8 3.64l2.35-2.35a3.75 3.75 0 1 1 5.305 5.305L8 14.25z"/></svg>';
  const DISCORD_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M19.54 5.34A16.3 16.3 0 0 0 15.44 4l-.5 1.02a15.2 15.2 0 0 0-5.87 0L8.55 4a16.5 16.5 0 0 0-4.1 1.35C1.85 9.17 1.15 12.9 1.5 16.58a16.7 16.7 0 0 0 5.03 2.55l1.23-1.67a10.7 10.7 0 0 1-1.93-.93l.47-.36c3.72 1.72 7.75 1.72 11.43 0l.48.36c-.62.37-1.27.68-1.94.93l1.23 1.67a16.6 16.6 0 0 0 5.02-2.55c.42-4.27-.72-7.97-2.98-11.24ZM8.68 14.3c-1.12 0-2.04-1.03-2.04-2.3s.9-2.3 2.04-2.3c1.15 0 2.06 1.04 2.04 2.3 0 1.27-.9 2.3-2.04 2.3Zm6.64 0c-1.12 0-2.04-1.03-2.04-2.3s.9-2.3 2.04-2.3c1.15 0 2.06 1.04 2.04 2.3 0 1.27-.89 2.3-2.04 2.3Z"/></svg>';
  const SETTINGS_ICON = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2.2"/><path d="M6.8 1.8h2.4l.5 1.7 1.4.8 1.7-.5L14 5.9l-1.2 1.3v1.6l1.2 1.3-1.2 2.1-1.7-.5-1.4.8-.5 1.7H6.8l-.5-1.7-1.4-.8-1.7.5L2 10.1l1.2-1.3V7.2L2 5.9l1.2-2.1 1.7.5 1.4-.8.5-1.7Z"/></svg>';
  // Per-tab glyphs shown when the panel is too narrow for text labels.
  const TAB_ICONS = {
    tests: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="2.5" width="10" height="11" rx="1.5"/><path d="m5.4 6 1.2 1.2L8.9 5"/><path d="M5.5 10h5"/></svg>',
    statement: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3.5" y="2" width="9" height="12" rx="1.5"/><path d="M5.5 5h5M5.5 8h5M5.5 11h3"/></svg>',
    solution: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 2.2a4 4 0 0 0-2.4 7.2c.5.4.8 1 .8 1.6h3.2c0-.6.3-1.2.8-1.6A4 4 0 0 0 8 2.2Z"/><path d="M6.6 13.2h2.8"/></svg>',
    compete: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M5 3h6v3a3 3 0 0 1-6 0V3Z"/><path d="M5 3.8H3.4v1A1.8 1.8 0 0 0 5 6.6M11 3.8h1.6v1A1.8 1.8 0 0 1 11 6.6"/><path d="M8 9v1.8M6 13.2h4l-.4-2.4H6.4Z"/></svg>'
  };
  const vscode = acquireVsCodeApi();
  let state = { tests: [], results: [], source: null };
  let renderedSource = undefined;
  const saved = vscode.getState() || {};
  let theme = saved.theme || 'cpos';
  let activeTab = saved.activeTab || 'tests';
  let themesOpen = false;
  let competeMode = saved.competeMode === 'public' ? 'public' : 'friend';
  let ioSplit = typeof saved.ioSplit === 'number' ? saved.ioSplit : 68;
  let collapsedTests = saved.collapsedTests && typeof saved.collapsedTests === 'object' ? saved.collapsedTests : {};
  document.body.setAttribute('data-theme', theme);

  function persistUiState() {
    vscode.setState(Object.assign({}, vscode.getState(), { theme, ioSplit, activeTab, competeMode, collapsedTests }));
  }

  function applyIoSplit(pct) {
    ioSplit = Math.min(82, Math.max(48, pct));
    document.querySelectorAll(".io-grid").forEach((grid) => {
      grid.style.setProperty("--io-in-pct", ioSplit + "%");
    });
    persistUiState();
  }

  function parseCodeforcesOutputBlockSizes(expected) {
    const lines = String(expected || "").split("\\n");
    const sizes = [];
    let i = 0;
    while (i < lines.length) {
      const s = lines[i].trim();
      if (!s) {
        i++;
        continue;
      }
      if (s === "NO") {
        sizes.push(1);
        i++;
        continue;
      }
      if (s === "YES") {
        i++;
        const k = i < lines.length ? parseInt(lines[i].trim(), 10) : NaN;
        if (!isNaN(k) && k >= 0) {
          sizes.push(2 + k);
          i++;
          i += k;
        } else {
          sizes.push(2);
        }
        continue;
      }
      sizes.push(1);
      i++;
    }
    return sizes.length ? sizes : null;
  }

  function inferOutputOffset(blockSizes, expected, outputBlockSizes) {
    if (outputBlockSizes && blockSizes.length === outputBlockSizes.length + 1) return 1;
    if (blockSizes.length > 1 && blockSizes[0] === 1) {
      const t = parseInt(String(expected || "").split("\\n")[0] || "", 10);
      const outN = outputBlockSizes ? outputBlockSizes.length : parseCodeforcesOutputBlockSizes(expected)?.length;
      if (!isNaN(t) && outN && blockSizes.length === outN + 1) return 1;
    }
    const expCount = String(expected || "").split("\\n").filter(function (l) { return l.trim().length > 0; }).length;
    if (blockSizes.length === expCount + 1) return 1;
    if (blockSizes.length > expCount && blockSizes[0] === 1) return 1;
    return 0;
  }

  function computeInputBlocks(lines, expected, blockSizes, outputOffset, outputBlockSizes) {
    if (blockSizes && blockSizes.length) {
      const offset =
        typeof outputOffset === "number"
          ? outputOffset
          : inferOutputOffset(blockSizes, expected, outputBlockSizes);
      const blocks = [];
      let idx = 0;
      for (let i = 0; i < blockSizes.length; i++) {
        const size = Math.max(1, blockSizes[i]);
        blocks.push({
          start: idx,
          end: idx + size - 1,
          outIdx: i >= offset ? i - offset : -1
        });
        idx += size;
      }
      if (idx < lines.length) {
        blocks.push({ start: idx, end: lines.length - 1, outIdx: -1 });
      }
      return { blocks: blocks, outputOffset: offset };
    }

    const expLines = String(expected || "").split("\\n");
    const expCount = expLines.filter(function (l) { return l.trim().length > 0; }).length;

    const blankBlocks = [];
    let curStart = 0;
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === "") {
        if (inBlock) {
          blankBlocks.push({ start: curStart, end: i - 1, outIdx: blankBlocks.length });
          inBlock = false;
        }
      } else if (!inBlock) {
        curStart = i;
        inBlock = true;
      }
    }
    if (inBlock) blankBlocks.push({ start: curStart, end: lines.length - 1, outIdx: blankBlocks.length });
    if (blankBlocks.length > 1 && blankBlocks.length === expCount) {
      return { blocks: blankBlocks, outputOffset: 0 };
    }

    const t = parseInt(String(lines[0] || "").trim(), 10);
    if (!isNaN(t) && t > 0 && t === expCount && lines.length > t) {
      const rest = lines.length - 1;
      if (rest === t) {
        const oneLineBlocks = Array.from({ length: t }, function (_, i) {
          return { start: i + 1, end: i + 1, outIdx: i };
        });
        return { blocks: [{ start: 0, end: 0, outIdx: -1 }].concat(oneLineBlocks), outputOffset: 1 };
      }
    }

    return { blocks: [{ start: 0, end: Math.max(0, lines.length - 1), outIdx: -1 }], outputOffset: 0 };
  }

  function computeOutputBlocks(lines, blockSizes) {
    if (blockSizes && blockSizes.length) {
      const blocks = [];
      let idx = 0;
      for (let i = 0; i < blockSizes.length; i++) {
        const size = Math.max(1, blockSizes[i]);
        blocks.push({ start: idx, end: idx + size - 1, outIdx: i });
        idx += size;
      }
      if (idx < lines.length) blocks.push({ start: idx, end: lines.length - 1, outIdx: blocks.length });
      return blocks;
    }
    return lines.map(function (_, i) { return { start: i, end: i, outIdx: i }; });
  }

  function lineIndexFromTextarea(ta, clientY) {
    const style = getComputedStyle(ta);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
    const padTop = parseFloat(style.paddingTop) || 0;
    const rect = ta.getBoundingClientRect();
    const y = clientY - rect.top + ta.scrollTop - padTop;
    const lines = ta.value.split("\\n");
    const idx = Math.floor(y / lineHeight);
    return Math.max(0, Math.min(lines.length - 1, idx));
  }

  function blockForLine(blocks, lineIdx) {
    for (let i = 0; i < blocks.length; i++) {
      if (lineIdx >= blocks[i].start && lineIdx <= blocks[i].end) return i;
    }
    return -1;
  }

  function lineRowsHtml(lines, blocks, gutter) {
    return lines.map(function (line, i) {
      const blk = blockForLine(blocks, i);
      const gutterTxt = gutter && blk >= 0 && blocks[blk].start === i && blocks[blk].outIdx >= 0
        ? String(blocks[blk].outIdx + 1)
        : "";
      const blkClass = blk >= 0 && blk % 2 ? "even" : "odd";
      const blkId = blk >= 0 ? blk : -1;
      // Background rows are stripe/gutter only — text lives in the textarea to avoid duplicate rendering.
      return '<div class="ln blk-' + blkClass + '" data-blk="' + blkId + '" data-line="' + i + '"><span class="ln-gutter">' + gutterTxt + '</span><span class="ln-txt">' + (line.length ? "x" : "&nbsp;") + '</span></div>';
    }).join("");
  }

  function syncIoLines(card) {
    const inTa = card.querySelector("textarea.in");
    const expTa = card.querySelector("textarea.exp");
    if (!inTa || !expTa) return;
    const inLines = inTa.value.split("\\n");
    if (!inLines.length) inLines.push("");
    const sizesRaw = card.getAttribute("data-block-sizes");
    const blockSizes = sizesRaw ? sizesRaw.split(",").map(Number).filter(function (n) { return n > 0; }) : null;
    const offsetRaw = card.getAttribute("data-output-offset");
    const outputOffset = offsetRaw != null && offsetRaw !== "" ? parseInt(offsetRaw, 10) : undefined;
    const expLines = expTa.value.split("\\n");
    if (!expLines.length) expLines.push("");
    const outSizesRaw = card.getAttribute("data-output-block-sizes");
    let outputBlockSizes = outSizesRaw ? outSizesRaw.split(",").map(Number).filter(function (n) { return n > 0; }) : null;
    if (!outputBlockSizes || !outputBlockSizes.length) {
      outputBlockSizes = parseCodeforcesOutputBlockSizes(expTa.value);
    }
    const meta = computeInputBlocks(
      inLines,
      expTa.value,
      blockSizes && blockSizes.length ? blockSizes : null,
      outputOffset,
      outputBlockSizes
    );
    const blocks = meta.blocks;
    card._ioBlocks = blocks;
    card._ioOutputOffset = meta.outputOffset;
    const inBg = card.querySelector(".io-line-bg");
    const expBg = card.querySelector(".io-exp-line-bg");
    if (inBg) inBg.innerHTML = lineRowsHtml(inLines, blocks, true);
    const expBlocks = computeOutputBlocks(expLines, outputBlockSizes && outputBlockSizes.length ? outputBlockSizes : null);
    card._expBlocks = expBlocks;
    if (expBg) expBg.innerHTML = lineRowsHtml(expLines, expBlocks, true);
    autoResizeTextareas(card);
  }

  function setBlockHighlight(card, inputBlockIdx, expBlockIdx) {
    if (!card) return;
    const key = inputBlockIdx + ":" + expBlockIdx;
    if (card._hiKey === key) return;
    card._hiKey = key;
    card.querySelectorAll(".io-line-bg .ln").forEach(function (ln) {
      const blk = parseInt(ln.getAttribute("data-blk"), 10);
      ln.classList.toggle("blk-hi", inputBlockIdx >= 0 && blk === inputBlockIdx);
    });
    card.querySelectorAll(".io-exp-line-bg .ln").forEach(function (ln) {
      const blk = parseInt(ln.getAttribute("data-blk"), 10);
      ln.classList.toggle("blk-hi", expBlockIdx >= 0 && blk === expBlockIdx);
    });
  }

  function clearBlockHighlight(card) {
    if (!card) return;
    card._hiKey = "";
    card.querySelectorAll(".ln.blk-hi").forEach(function (ln) { ln.classList.remove("blk-hi"); });
  }

  function bindIoScroll(card) {
    const pairs = [
      [card.querySelector("textarea.in"), card.querySelector(".io-line-bg")],
      [card.querySelector("textarea.exp"), card.querySelector(".io-exp-line-bg")]
    ];
    pairs.forEach(function (pair) {
      const ta = pair[0];
      const bg = pair[1];
      if (!ta || !bg || ta._cposScrollBound) return;
      ta._cposScrollBound = true;
      ta.addEventListener("scroll", function () {
        bg.style.transform = "translateY(" + (-ta.scrollTop) + "px)";
      });
    });
  }

  function bindIoHover(card) {
    if (card._ioHoverBound) return;
    card._ioHoverBound = true;
    bindIoScroll(card);
    const inBox = card.querySelector(".io-input-box");
    const expBox = card.querySelector(".io-exp-box");
    const inTa = card.querySelector("textarea.in");
    const expTa = card.querySelector("textarea.exp");

    function pickFromInput(ev) {
      if (!inTa) return;
      const lineIdx = lineIndexFromTextarea(inTa, ev.clientY);
      const blocks = card._ioBlocks || [{ start: 0, end: 0, outIdx: -1 }];
      const b = blockForLine(blocks, lineIdx);
      const outIdx = b >= 0 && blocks[b] ? blocks[b].outIdx : -1;
      setBlockHighlight(card, b, outIdx);
    }

    function pickFromExpected(ev) {
      if (!expTa) return;
      const lineIdx = lineIndexFromTextarea(expTa, ev.clientY);
      const expBlocks = card._expBlocks || [{ start: 0, end: 0, outIdx: 0 }];
      const outBlockIdx = blockForLine(expBlocks, lineIdx);
      const inBlocks = card._ioBlocks || [];
      let inBlockIdx = -1;
      for (let j = 0; j < inBlocks.length; j++) {
        if (inBlocks[j].outIdx === outBlockIdx) {
          inBlockIdx = j;
          break;
        }
      }
      setBlockHighlight(card, inBlockIdx, outBlockIdx);
    }

    if (inBox) {
      inBox.addEventListener("mousemove", pickFromInput);
      inBox.addEventListener("mouseleave", function () { clearBlockHighlight(card); });
    }
    if (expBox) {
      expBox.addEventListener("mousemove", pickFromExpected);
      expBox.addEventListener("mouseleave", function () { clearBlockHighlight(card); });
    }
  }

  function inputLineHtml(text, expected, blockSizes, outputOffset, outputBlockSizes) {
    const lines = String(text == null ? "" : text).split("\\n");
    if (!lines.length) lines.push("");
    let outSizes = outputBlockSizes;
    if (!outSizes || !outSizes.length) outSizes = parseCodeforcesOutputBlockSizes(expected);
    const meta = computeInputBlocks(lines, expected, blockSizes, outputOffset, outSizes);
    return lineRowsHtml(lines, meta.blocks, true);
  }

  function expLineHtml(text, outputBlockSizes) {
    const lines = String(text == null ? "" : text).split("\\n");
    if (!lines.length) lines.push("");
    let outSizes = outputBlockSizes;
    if (!outSizes || !outSizes.length) outSizes = parseCodeforcesOutputBlockSizes(text);
    const blocks = computeOutputBlocks(lines, outSizes && outSizes.length ? outSizes : null);
    return lineRowsHtml(lines, blocks, true);
  }

  function syncInputLines(ta) {
    const card = ta.closest(".test");
    if (card) {
      card.removeAttribute("data-block-sizes");
      card.removeAttribute("data-output-offset");
      syncIoLines(card);
    }
  }

  function bindIoSplitters(root) {
    (root || document).querySelectorAll("[data-splitter]").forEach(function (handle) {
      if (handle._cposSplitBound) return;
      handle._cposSplitBound = true;
      handle.addEventListener("mousedown", function (ev) {
        const grid = handle.closest(".io-grid");
        if (!grid) return;
        ev.preventDefault();
        handle.classList.add("dragging");
        const rect = grid.getBoundingClientRect();
        function onMove(e) {
          const pct = ((e.clientX - rect.left) / rect.width) * 100;
          applyIoSplit(pct);
        }
        function onUp() {
          handle.classList.remove("dragging");
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        }
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });
    });
  }

  function send(type, extra) { vscode.postMessage(Object.assign({ type }, extra || {})); }

  function isTestCollapsed(index) {
    return !!collapsedTests[String(index)];
  }

  function toggleTestCollapsed(index) {
    const key = String(index);
    collapsedTests = Object.assign({}, collapsedTests);
    if (collapsedTests[key]) delete collapsedTests[key];
    else collapsedTests[key] = true;
    persistUiState();
  }

  function removeCollapsedTest(index) {
    const next = {};
    Object.keys(collapsedTests).forEach((key) => {
      const oldIndex = Number(key);
      if (Number.isNaN(oldIndex) || oldIndex === index) return;
      next[String(oldIndex > index ? oldIndex - 1 : oldIndex)] = true;
    });
    collapsedTests = next;
    persistUiState();
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

  let persistTimer;
  function collectTests() {
    const cards = document.querySelectorAll(".test");
    const tests = [];
    cards.forEach((card) => {
      const input = card.querySelector("textarea.in").value;
      const expected_output = card.querySelector("textarea.exp").value;
      const row = { input, expected_output };
      const sizesRaw = card.getAttribute("data-block-sizes");
      if (sizesRaw) {
        const sizes = sizesRaw.split(",").map(Number).filter(function (n) { return n > 0; });
        if (sizes.length) row.input_block_sizes = sizes;
      }
      const offsetRaw = card.getAttribute("data-output-offset");
      if (offsetRaw != null && offsetRaw !== "") row.input_output_offset = parseInt(offsetRaw, 10);
      const outSizesRaw = card.getAttribute("data-output-block-sizes");
      if (outSizesRaw) {
        const outSizes = outSizesRaw.split(",").map(Number).filter(function (n) { return n > 0; });
        if (outSizes.length) row.output_block_sizes = outSizes;
      }
      tests.push(row);
    });
    return tests;
  }
  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => send("persistTests", { tests: collectTests() }), 400);
  }

  function verdictClass(v) { return ["AC","WA","TLE","RE","CE"].includes(v) ? v : "none"; }

  function textareaRows(text, min, max) {
    const lines = String(text || "").split("\\n").length;
    return Math.min(max, Math.max(min, lines));
  }

  function autoResizeTextareas(root) {
    (root || document).querySelectorAll("textarea").forEach((ta) => {
      if (ta.classList.contains("in") || ta.classList.contains("exp")) {
        ta.style.height = "";
        return;
      }
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 280) + "px";
    });
  }

  function resultHtml(r) {
    if (state.running || !r) return "";
    if (r.verdict === "AC") {
      return '<div class="time">Passed in ' + r.timeMs + 'ms</div>';
    }
    const stderr = r.stderr ? "\\n[stderr] " + r.stderr : "";
    return '<label>Got' + (r.timeMs != null ? ' · ' + r.timeMs + 'ms' : '') +
      '</label><div class="got fail">' + (esc(r.actual) || "(no output)") + esc(stderr) + '</div>';
  }

  function platformClass(p) {
    const k = String(p || "").toLowerCase();
    if (k === "codeforces" || k === "cf") return "codeforces";
    if (k === "cses") return "cses";
    if (k === "atcoder") return "atcoder";
    return "";
  }

  function header() {
    const m = state.meta;
    let problemBlock;
    if (m) {
      const pClass = platformClass(m.platform);
      const tag = m.platform ? '<span class="tag ' + pClass + '">' + esc(String(m.platform).toUpperCase()) + '</span>' : '';
      const rating = m.rating ? '<span class="rating">★ ' + esc(m.rating) + '</span>' : '';
      problemBlock = '<div class="pline">' + tag
        + '<button class="problem-link pid" data-act="openProblem" title="Open problem in browser">' + esc(m.id)
        + '<span class="problem-link-icon" aria-hidden="true">↗</span></button>'
        + rating + '</div>'
        + '<div class="pname">' + esc(m.name) + '</div>';
    } else {
      problemBlock = '<div class="pline"><span class="pid muted">no problem linked</span></div>'
        + '<div class="pname">open a Codeforces, CSES or AtCoder problem in your browser to capture it</div>';
    }
    const file = state.fileName
      ? '<span class="link" data-act="openSource">' + esc(state.fileName) + '</span>'
      : '<span class="muted">no file open</span>';
    const tests = state.tests.length + ' test' + (state.tests.length === 1 ? '' : 's');
    return '<div class="box head header">'
      + '<div class="row">'
      + '<span class="brandrow"><img class="logo" src="' + CPOS_LOGO + '" alt="CPOS" /><span class="title">CPOS</span></span>'
      + '<span class="headtools">'
      + '<button class="iconbtn sponsor" data-prio="3" data-act="openSponsor" title="Sponsor CPOS — keep it free and local-first">' + HEART_ICON + '<span class="btn-label">Sponsor</span></button>'
      + '<button class="iconbtn theme" data-prio="2" data-act="toggleThemes" title="Themes">◑<span class="btn-label"> theme</span></button>'
      + '<button class="iconbtn discord" data-prio="1" data-act="openDiscord" title="Join CPOS on Discord" aria-label="Join CPOS on Discord">' + DISCORD_ICON + '<span class="btn-label">Discord</span></button>'
      + '<button class="iconbtn gh" data-prio="0" data-act="openGithub" title="CPOS on GitHub" aria-label="CPOS on GitHub">' + GH_ICON + '<span class="btn-label">GitHub</span></button>'
      + '</span>'
      + '</div>'
      + '<div class="rule"></div>'
      + problemBlock
      + '<div class="fileline">' + file + ' · ' + tests + '</div>'
      + '</div>'
      + themebar();
  }

  const THEMES = [
    { id: 'cpos',     name: 'CPOS',     chips: ['#0c0c13', '#b794ff', '#7ee787'] },
    { id: 'midnight', name: 'Midnight', chips: ['#0d1117', '#6cb6ff', '#6fd58a'] },
    { id: 'amber',    name: 'Amber',    chips: ['#14110a', '#f0b860', '#b8c46a'] },
    { id: 'paper',    name: 'Paper',    chips: ['#101010', '#e0e0e0', '#9a9a9a'] },
    { id: 'native',   name: 'Native',   chips: ['#222', '#4daafc', '#4caf50'] }
  ];

  function themebar() {
    const cells = THEMES.map(function (t) {
      const chips = t.chips.map(function (c) {
        return '<span class="chip" style="background:' + c + '"></span>';
      }).join('');
      const cls = t.id === theme ? 'swatch active' : 'swatch';
      return '<button class="' + cls + '" data-act="setTheme" data-theme="' + t.id + '">'
        + '<span class="chips">' + chips + '</span>' + t.name + '</button>';
    }).join('');
    return '<div class="box themebar' + (themesOpen ? ' open' : '') + '">' + cells + '</div>';
  }

  function applyTheme(id) {
    theme = id;
    document.body.setAttribute('data-theme', id);
    persistUiState();
    // Persist to the extension's global storage so it survives restarts/reinstalls.
    send('saveTheme', { theme: id });
  }

  function statbar() {
    const total = state.tests.length;
    const ran = !state.running && state.results.length > 0;
    const passed = ran ? state.results.filter((r) => r.passed).length : null;
    const failed = ran ? state.results.filter((r) => !r.passed).length : null;
    const cell = (num, cls, lbl) =>
      '<div class="box stat"><div class="num ' + cls + '">' + num + '</div><div class="lbl">' + lbl + '</div></div>';
    return '<div class="stats summary">'
      + cell(total, 'accent', 'Tests')
      + cell(passed == null ? '–' : passed, 'ok', 'Passed')
      + cell(failed == null ? '–' : failed, 'bad', 'Failed')
      + '</div>';
  }

  function actions() {
    const runLabel = state.running ? "running…" : "Run All";
    return '<div class="actions">'
      + '<button class="primary" data-act="run" ' + (state.running ? "disabled" : "") + '>' + runLabel + '</button>'
      + '<button class="submit-action" data-act="submit">Submit</button>'
      + '<button class="viz-action" data-act="viz" title="Draw the samples as the structure they are — graph, tree, grid, array…">Visualize</button>'
      + '</div>';
  }

  function testCard(t, i) {
    const r = state.results.find((x) => x.index === i);
    let verdict = "", vClass = "none", cardClass = "";
    if (state.running) { verdict = "RUN"; vClass = "run"; }
    else if (r) { verdict = r.verdict; vClass = verdictClass(r.verdict); cardClass = r.passed ? "pass" : "fail"; }
    const collapsed = isTestCollapsed(i);
    const classes = "box test" + (cardClass ? " " + cardClass : "") + (collapsed ? " collapsed" : "");
    const got = '<div class="result-slot">' + resultHtml(r) + '</div>';
    const inRows = textareaRows(t.input, 3, 14);
    const expRows = textareaRows(t.expected_output, 2, 6);
    const blockAttr = t.input_block_sizes && t.input_block_sizes.length
      ? ' data-block-sizes="' + t.input_block_sizes.join(",") + '"'
      : "";
    const offsetAttr = typeof t.input_output_offset === "number"
      ? ' data-output-offset="' + t.input_output_offset + '"'
      : "";
    const outBlockAttr = t.output_block_sizes && t.output_block_sizes.length
      ? ' data-output-block-sizes="' + t.output_block_sizes.join(",") + '"'
      : "";
    return '<div class="' + classes + '" data-index="' + i + '"' + blockAttr + offsetAttr + outBlockAttr + '>'
      + '<div class="test-head">'
      + '<div class="test-title"><span class="idx">Test ' + (i + 1) + '</span>'
      + '<button class="ghost collapse-toggle" data-act="toggleTest" data-index="' + i + '" '
      + 'aria-expanded="' + (!collapsed) + '" aria-label="' + (collapsed ? "Expand" : "Collapse") + ' test ' + (i + 1) + '">'
      + (collapsed ? '+' : '-') + '</button>'
      + '<span class="verdict ' + vClass + '">' + verdict + '</span></div>'
      + '<div class="test-actions">'
      + '<button class="ghost" data-act="runSingle" data-index="' + i + '">run</button>'
      + '<button class="ghost" data-act="deleteTest" data-index="' + i + '">del</button>'
      + '</div>'
      + '</div>'
      + '<div class="test-body">'
      + '<div class="io-grid" style="--io-in-pct:' + ioSplit + '%">'
      + '<div class="io-col io-col-input"><label>Input</label>'
      + '<div class="io-input-box"><div class="io-line-bg">' + inputLineHtml(t.input, t.expected_output, t.input_block_sizes, t.input_output_offset, t.output_block_sizes) + '</div>'
      + '<textarea class="in" rows="' + inRows + '" spellcheck="false">' + esc(t.input) + '</textarea></div></div>'
      + '<div class="io-splitter" data-splitter title="Drag to resize"></div>'
      + '<div class="io-col io-col-exp"><label>Expected</label>'
      + '<div class="io-exp-box"><div class="io-exp-line-bg">' + expLineHtml(t.expected_output, t.output_block_sizes) + '</div>'
      + '<textarea class="exp" rows="' + expRows + '" spellcheck="false">' + esc(t.expected_output) + '</textarea></div></div>'
      + '</div>'
      + got
      + '</div>'
      + '</div>';
  }

  function testsSection() {
    let body;
    if (state.tests.length === 0) {
      body = '<div class="box empty">no test cases — capture from browser or + add</div>';
    } else {
      body = state.tests.map((t, i) => testCard(t, i)).join("");
    }
    return '<div class="section tests-list-head"><span>Test Cases</span>'
      + '<button class="ghost" data-act="addTest">+ add</button></div>'
      + '<div class="tests-list">' + body + '</div>';
  }

  function testsView() {
    return '<div class="tests-wrapper">'
      + '<div class="tests-command">' + statbar() + actions() + '</div>'
      + testsSection()
      + '</div>';
  }

  function tabsHtml() {
    const shown = state.tabs || { statement: true, solution: true, compete: true };
    const tabs = [{ id: 'tests', label: 'Tests', priority: 4 }];
    if (shown.statement !== false && state.meta && state.meta.statementHtml) tabs.push({ id: 'statement', label: 'Statement', priority: 3 });
    if (shown.solution !== false && state.meta && !state.solutionBlocked) tabs.push({ id: 'solution', label: 'Solution', priority: 2 });
    if (shown.compete !== false) tabs.push({ id: 'compete', label: 'Compete', priority: 1 });
    return '<div class="tabs" role="tablist">'
      + tabs.map(function(t) {
        return '<button role="tab" aria-selected="' + (activeTab === t.id ? "true" : "false")
          + '" tabindex="0" title="' + t.label + '" class="tab ' + (activeTab === t.id ? "active" : "")
          + '" data-act="setTab" data-tab="' + t.id + '" data-priority="' + t.priority + '">'
          + '<span class="tab-ico">' + (TAB_ICONS[t.id] || '') + '</span>'
          + '<span class="tab-label">' + t.label + '</span></button>';
      }).join('')
      + '<button role="tab" aria-selected="' + (activeTab === 'config' ? "true" : "false")
      + '" class="tab settings-tab ' + (activeTab === 'config' ? "active" : "")
      + '" data-act="openConfig" title="CPOS settings" aria-label="CPOS settings">' + SETTINGS_ICON + '</button>'
      + '</div>';
  }

  function configSection() {
    const cfg = state.config || { defaultLanguage: 'cpp', templates: {}, languages: ['cpp'] };
    const languages = cfg.languages || ['cpp'];
    const chosen = languages.indexOf(cfg.defaultLanguage) >= 0 ? cfg.defaultLanguage : languages[0];
    const options = languages.map(function(lang) {
      return '<option value="' + esc(lang) + '"' + (lang === chosen ? ' selected' : '') + '>' + esc(lang) + '</option>';
    }).join('');
    const content = (cfg.templates && cfg.templates[chosen]) || '';
    const shown = state.tabs || { statement: true, solution: true, compete: true };
    const tabRow = function(id, title, note, checked, disabled) {
      return '<label class="config-tab-row"><input class="config-tab-check" data-tab="' + id + '" type="checkbox"'
        + (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + ' />'
        + '<span class="config-tab-copy"><span>' + title + '</span><small>' + note + '</small></span></label>';
    };
    return '<div class="config-wrapper">'
      + '<div class="config-heading"><h2>Settings</h2><div class="config-note">Keep the panel focused on the tools you actually use.</div></div>'
      + '<section class="box config-card"><div><div class="config-title">Shown tabs</div>'
      + '<div class="config-note">Tests is always available. Problem-specific tabs appear when content exists.</div></div>'
      + tabRow('tests', 'Tests', 'Run and edit captured samples.', true, true)
      + tabRow('statement', 'Statement', 'Show captured problem statements.', shown.statement !== false, false)
      + tabRow('solution', 'Solution', 'Show editorials after the contest allows them.', shown.solution !== false, false)
      + tabRow('compete', 'Compete', 'Create and manage Codeforces races.', shown.compete !== false, false)
      + '</section>'
      + '<section class="box config-card">'
      + '<div><div class="config-title">Shared templates</div><div class="config-note">Default language and template contents sync with Chrome and the TUI.</div></div>'
      + '<div class="config-field"><label for="config-default-lang">Default language</label><select id="config-default-lang">' + options + '</select></div>'
      + '<div class="config-field"><label for="config-lang">Language</label><select id="config-lang">' + options + '</select></div>'
      + '<div class="config-field"><label for="config-template">Template</label><textarea id="config-template" spellcheck="false">' + esc(content) + '</textarea></div>'
      + '<input id="config-upload" type="file" hidden />'
      + '<div class="config-buttons">'
      + '<button data-act="uploadTemplate">Upload file</button>'
      + '<button data-act="resetTemplate">Reset</button>'
      + '<button class="primary" data-act="saveTemplate">Save &amp; sync</button>'
      + '</div>'
      + '</section></div>';
  }

  function sanitizeHtml(html) {
    if (!html) return "";
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const blockedTags = ["script", "iframe", "object", "embed", "link", "style"];
    blockedTags.forEach(tag => {
      doc.querySelectorAll(tag).forEach(e => e.remove());
    });
    doc.querySelectorAll(".input-file, .output-file").forEach(e => e.remove());
    // CSES: drop the trailing "Example" section (sample I/O) so it does not
    // duplicate the Tests tab. It is the #example heading plus everything that
    // follows it in the same container. #example exists only on CSES pages.
    const example = doc.querySelector("#example");
    if (example) {
      let node = example;
      while (node) {
        const next = node.nextSibling;
        if (node.parentNode) node.parentNode.removeChild(node);
        node = next;
      }
    }
    doc.querySelectorAll("*").forEach(e => {
      Array.from(e.attributes).forEach(attr => {
        if (attr.name.toLowerCase().startsWith("on")) {
          e.removeAttribute(attr.name);
        }
      });
    });
    return doc.body.innerHTML;
  }

  function statementSection() {
    let inner = sanitizeHtml(state.meta.statementHtml);
    // Codeforces statements already carry their own title; CSES/AtCoder
    // captured statements do not, so prepend the problem name as a heading.
    const platLower = String(state.meta.platform || "").toLowerCase();
    const needsTitle = platLower === "cses" || platLower === "atcoder";
    if (needsTitle && state.meta.name && inner) {
      inner = '<h1 class="cses-title">' + esc(state.meta.name) + '</h1>' + inner;
    }
    // CF content.js strips .sample-tests before capturing, so hasSamples is
    // always false for CF — we re-inject them in the correct position.
    var buildBlockedPre = function(text, blockSizes, cls) {
      var safe = text == null ? '' : String(text);
      if (!blockSizes || !blockSizes.length || blockSizes.length <= 1) {
        return '<pre class="stmt-sample-pre ' + cls + '">' + esc(safe) + '</pre>';
      }
      var lines = safe.split('\\n');
      var lineIdx = 0;
      var spans = [];
      for (var b = 0; b < blockSizes.length; b++) {
        var sz = blockSizes[b];
        var blockLines = lines.slice(lineIdx, lineIdx + sz);
        var alt = b % 2 === 0 ? ' stmt-blk-odd' : ' stmt-blk-even';
        spans.push('<span class="stmt-blk' + alt + '" data-blk="' + b + '">' + esc(blockLines.join('\\n')) + '</span>');
        lineIdx += sz;
      }
      if (lineIdx < lines.length) {
        spans.push('<span class="stmt-blk">' + esc(lines.slice(lineIdx).join('\\n')) + '</span>');
      }
      return '<pre class="stmt-sample-pre ' + cls + '">' + spans.join('\\n') + '</pre>';
    };
    const hasSamples = inner.indexOf('class="sample-tests"') !== -1 || inner.indexOf("class='sample-tests'") !== -1;
    if (!hasSamples && state.tests && state.tests.length > 0) {
      var rows = state.tests.map(function(t, si) {
        var inHtml  = buildBlockedPre(t.input, t.input_block_sizes, 'stmt-in');
        var outHtml = buildBlockedPre(t.expected_output, t.output_block_sizes, 'stmt-out');
        return '<div class="stmt-sample" data-si="' + si + '">'
          + '<div class="stmt-sample-hdr">Example ' + (si + 1) + '</div>'
          + '<div class="stmt-sample-io">'
          + '<div><div class="stmt-sample-lbl">Input</div>' + inHtml + '</div>'
          + '<div><div class="stmt-sample-lbl">Output</div>' + outHtml + '</div>'
          + '</div></div>';
      }).join('');
      var samplesHtml = '<div class="sample-tests" style="margin:24px 0 0 0">'
        + '<div class="section-title">Sample Tests</div>' + rows + '</div>';
      // Insert BEFORE the Note section (CF puts Note after sample-tests).
      // If no Note exists (CSES), append at end.
      var noteIdx = inner.indexOf('<div class="note"');
      if (noteIdx !== -1) {
        inner = inner.slice(0, noteIdx) + samplesHtml + inner.slice(noteIdx);
      } else {
        inner += samplesHtml;
      }
    }
    return '<div class="statement-view-wrapper"><div class="statement-view">' + inner + '</div></div>';
  }

  function solutionSection() {
    const m = state.meta;
    if (!m) {
      return '<div class="box sol-no-meta">Capture a problem first to see solutions.</div>';
    }
    const sol = state.solution;
    const status = sol ? sol.status : 'idle';

    // ── Video accordion content ──
    let videoContent;
    if (status === 'loading' || status === 'idle') {
      videoContent = '<div class="sol-spinner">&#9680; Searching for video solutions…</div>';
    } else if (status === 'done' && sol.videos && sol.videos.length > 0) {
      // YouTube's IFrame player can't verify the embedding origin inside a VS Code
      // webview (no usable referrer) → Error 153. So instead of embedding, show a
      // real thumbnail that opens the watch page in the user's actual browser.
      videoContent = sol.videos.map(function(v) {
        const watchUrl = 'https://www.youtube.com/watch?v=' + esc(v.id);
        const thumb = 'https://i.ytimg.com/vi/' + esc(v.id) + '/hqdefault.jpg';
        const meta = v.title
          ? '<div class="sol-video-meta">' + esc(v.title)
              + (v.channel ? ' <span class="sol-channel">— ' + esc(v.channel) + '</span>' : '')
              + '</div>'
          : '';
        return '<div class="sol-video-card" data-vid="' + esc(v.id) + '">' + meta
          + '<div class="sol-video-wrap sol-video-thumb" data-act="openUrl" data-href="' + watchUrl + '" '
          + 'role="button" tabindex="0" title="Open on YouTube">'
          + '<img class="sol-thumb-img" src="' + thumb + '" alt="" loading="lazy" />'
          + '<span class="sol-play-badge">&#9654;</span>'
          + '</div></div>';
      }).join('');
    } else {
      videoContent = null; // none found — don't render an empty "Video Solutions" box
    }

    // ── Links accordion content ──
    const pid  = String(m.id   || '');
    const pname = String(m.name || '');
    const plat  = String(m.platform || '').toLowerCase();
    const isCf  = plat === 'codeforces' || plat === 'cf';
    const platLabel = plat === 'codeforces' || plat === 'cf' ? 'Codeforces'
      : plat === 'cses' ? 'CSES'
      : plat === 'atcoder' ? 'AtCoder'
      : '';
    const prefix = platLabel ? platLabel + ' ' : '';
    const ytQ = encodeURIComponent(prefix + pid + ' ' + pname + ' editorial solution');
    const gQ  = encodeURIComponent(prefix + pid + ' ' + pname + ' editorial solution');

    const linkDefs = [
      { icon: '▶', label: 'YouTube: ' + pid + ' editorial', href: 'https://www.youtube.com/results?search_query=' + ytQ },
      { icon: '⌕', label: 'Google: ' + pid + ' editorial',  href: 'https://www.google.com/search?q=' + gQ }
    ];
    if (isCf) {
      const cfMatch = pid.match(/^(\\d+)([A-Za-z]\\d*)$/);
      if (cfMatch) {
        linkDefs.push({ icon: '◉', label: 'CF Problem page', href: 'https://codeforces.com/problemset/problem/' + cfMatch[1] + '/' + cfMatch[2].toUpperCase() });
        linkDefs.push({ icon: '◉', label: 'CF Editorial search', href: 'https://codeforces.com/blog/search?q=' + encodeURIComponent(pid) });
      }
    }
    if (plat === 'atcoder') {
      linkDefs.push({ icon: '◉', label: 'AtCoder problem page', href: m.url });
      linkDefs.push({ icon: '◉', label: 'AtCoder editorial', href: m.url + '/editorial' });
    }
    if (plat === 'cses') {
      linkDefs.push({ icon: '◉', label: 'CSES problem page', href: m.url });
    }
    const linksHtml = linkDefs.map(function(l) {
      return '<div class="sol-link" data-act="openUrl" data-href="' + l.href + '">'
        + '<span>' + l.icon + '</span><span>' + esc(l.label) + '</span></div>';
    }).join('');

    function accordion(id, title, content, open) {
      return '<div class="accordion">'
        + '<button class="acc-header" data-act="toggleAccordion" data-accordion="' + id + '">'
        + '<span>' + title + '</span>'
        + '<span class="acc-arrow' + (open ? '' : ' closed') + '">&#9662;</span>'
        + '</button>'
        + '<div class="acc-body' + (open ? ' open' : '') + '" data-accordion-body="' + id + '">'
        + content + '</div></div>';
    }

    return '<div class="sol-wrapper">'
      + (videoContent ? accordion('videos', 'Video Solutions', videoContent, true) : '')
      + accordion('links',  'Editorials &amp; Links', linksHtml, true)
      + '</div>';
  }

  function competeSection() {
    const cf = state.cf || {};
    const handle = cf.handle || '';
    const range = cf.range || { min: 800, max: 3500 };
    const chs = state.challenges || {};
    const items = Object.keys(chs).map(function (k) { return chs[k]; })
      .filter(function (ch) { return ch.status !== 'removed'; })
      .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }).slice(0, 12);
    const publicItems = (state.publicChallenges || []).slice(0, 8);
    const BADGE = { pending: ['Pending', '#f59f00'], active: ['Racing', 'var(--accent)'], won: ['Won', '#2f9e44'], lost: ['Lost', '#e03131'], draw: ['Draw', '#f08c00'], expired: ['Expired', '#888'], declined: ['Declined', '#888'] };

    const identity = '<section class="cmp-card"><div class="cmp-card-head"><div><div class="cmp-card-title">Codeforces identity</div>'
      + '<div class="cmp-card-note">Synced with the browser companion.</div></div></div>'
      + '<div class="cmp-identity"><input id="cmp-handle" class="cmp-in" type="text" value="' + esc(handle) + '" placeholder="Codeforces handle" spellcheck="false" />'
      + '<button class="cmp-mini solid" data-act="chSaveHandle">Save</button></div></section>';

    const currentProblem = state.meta && (String(state.meta.platform || '').toLowerCase() === 'codeforces' || String(state.meta.platform || '').toLowerCase() === 'cf')
      ? '<option value="current">Current problem (' + esc(state.meta.id) + ')</option>'
      : '';
    const form = '<section class="cmp-card"><div class="cmp-card-head"><div><div class="cmp-card-title">New race</div>'
      + '<div class="cmp-card-note">Challenge a friend or publish an open race.</div></div></div>'
      + '<div class="cmp-form">'
      + '<div class="cmp-segment"><button class="' + (competeMode === 'friend' ? 'active' : '') + '" data-act="chMode" data-mode="friend">Friend</button><button class="' + (competeMode === 'public' ? 'active' : '') + '" data-act="chMode" data-mode="public">Open race</button></div>'
      + '<div id="cmp-opp-field" class="cmp-field"' + (competeMode === 'public' ? ' style="display:none"' : '') + '><label for="cmp-opp">Opponent</label><input id="cmp-opp" class="cmp-in" type="text" placeholder="Codeforces handle" /></div>'
      + '<div class="cmp-field"><label for="cmp-problem-mode">Problem</label><select id="cmp-problem-mode" class="cmp-in">'
      + currentProblem + '<option value="random">Random by rating</option><option value="custom">Problem ID or link</option></select></div>'
      + '<div id="cmp-custom-field" class="cmp-field" style="display:none"><label for="cmp-prob">Problem ID or link</label><input id="cmp-prob" class="cmp-in" type="text" placeholder="2237D or Codeforces link" /></div>'
      + '<div class="cmp-row2">'
      + '<div id="cmp-rating-field" class="cmp-field"><label for="cmp-rating">Rating</label><input id="cmp-rating" class="cmp-in" type="number" value="1400" min="800" max="3500" step="100" /></div>'
      + '<div class="cmp-field"><label for="cmp-dur">Time limit</label><select id="cmp-dur" class="cmp-in"><option value="30">30 minutes</option><option value="60" selected>1 hour</option><option value="120">2 hours</option><option value="1440">1 day</option></select></div>'
      + '</div><button id="cmp-create" class="cmp-send" data-act="chCreate">' + (competeMode === 'public' ? 'Publish open race' : 'Send challenge') + '</button>'
      + '<div id="cmp-msg" class="cmp-msg"></div></div></section>';

    let publicList;
    if (!cf.publicOn) {
      publicList = '<div class="config-note">Turn this on to find open races.</div>';
    } else if (!publicItems.length) {
      publicList = '<div class="config-note">No matching races yet.</div>';
    } else {
      publicList = '<div class="cmp-list">' + publicItems.map(function (item) {
        const p = item.problem || {};
        return '<div class="cmp-item"><div class="cmp-who"><span class="cmp-prob" data-act="openUrl" data-href="' + esc(p.url || '#') + '">'
          + esc((p.id || 'Problem') + (p.rating ? ' · ' + p.rating : '')) + '</span><div class="cmp-sub">from ' + esc(item.from || 'another coder')
          + ' · ' + esc(item.durationMin || 60) + ' min</div></div>'
          + '<button class="cmp-mini solid" data-act="chAcceptPublic" data-id="' + esc(item.id) + '">Accept</button></div>';
      }).join('') + '</div>';
    }
    const pub = '<section class="cmp-card"><div class="cmp-card-head"><div><div class="cmp-card-title">Public matching</div>'
      + '<div class="cmp-card-note">Find open races by problem rating.</div></div>'
      + '<button class="cmp-toggle ' + (cf.publicOn ? 'on' : '') + '" role="switch" aria-checked="' + (cf.publicOn ? 'true' : 'false') + '" data-act="chTogglePublic"><span></span></button></div>'
      + '<div class="cmp-pub"><span class="cmp-pub-lbl">Problem rating</span>'
      + '<input id="cmp-min" class="cmp-range" type="number" value="' + (range.min || 800) + '" min="800" max="3500" step="100" title="min rating" />'
      + '<span class="cmp-dash">–</span>'
      + '<input id="cmp-max" class="cmp-range" type="number" value="' + (range.max || 3500) + '" min="800" max="3500" step="100" title="max rating" />'
      + '</div><div style="height:8px"></div>' + publicList + '</section>';

    let listHtml;
    if (!items.length) {
      listHtml = '<div style="color:var(--dim);text-align:center;padding:4px;font-size:12px">No challenges yet.</div>';
    } else {
      listHtml = items.map(function (ch) {
        const p = ch.problem || {};
        const prob = (p.id || '') + (p.name ? ' — ' + p.name : '');
        const url = p.url || '#';
        const oppTxt = ch.opponent ? ((ch.role === 'out' ? 'vs ' : 'from ') + ch.opponent) : 'open';
        let right;
        if (ch.role === 'in' && ch.status === 'pending') {
          right = '<button class="cmp-mini solid" data-act="chAccept" data-id="' + esc(ch.id) + '">Accept</button>'
                + '<button class="cmp-mini" data-act="chDecline" data-id="' + esc(ch.id) + '">Decline</button>';
        } else {
          const b = BADGE[ch.status] || [ch.status, '#888'];
          right = '<span class="cmp-badge" style="background:' + b[1] + '">' + esc(b[0]) + '</span>';
        }
        return '<div class="cmp-item">'
          + '<div class="cmp-who"><span class="cmp-prob" data-act="openUrl" data-href="' + esc(url) + '">' + esc(prob) + '</span>'
          + '<div class="cmp-sub">' + esc(oppTxt) + '</div></div>'
          + right
          + '<button class="cmp-x" data-act="chRemove" data-id="' + esc(ch.id) + '" title="Remove">&#10005;</button>'
          + '</div>';
      }).join('');
    }

    return '<div class="cmp-wrap">' + identity + form + pub
      + '<section class="cmp-card"><div class="cmp-card-head"><div><div class="cmp-card-title">Your races</div>'
      + '<div class="cmp-card-note">Invites, active races, and results.</div></div></div>'
      + '<div class="cmp-list">' + listHtml + '</div></section></div>';
  }

  function render() {
    const app = document.getElementById("app");
    let body = "";
    // Build the active tab's body defensively: a throw here must NEVER leave the
    // panel blank. If a tab-builder fails, fall back to the Tests view (and show
    // the error) so the user always has a working panel.
    try {
      if (activeTab === "statement" && state.meta && state.meta.statementHtml) {
        body = statementSection();
      } else if (activeTab === "solution" && state.meta && !state.solutionBlocked) {
        body = solutionSection();
      } else if (activeTab === "compete") {
        body = competeSection();
      } else if (activeTab === "config") {
        body = configSection();
      } else {
        body = testsView();
      }
    } catch (err) {
      try { body = testsView(); }
      catch (_) { body = ""; }
      body = '<div class="box" style="border-color:var(--err,#c33);color:var(--dim);font-size:11px;padding:10px;margin-bottom:8px">'
        + 'The "' + esc(activeTab) + '" view failed to render: ' + esc(String(err && err.message ? err.message : err))
        + '</div>' + body;
    }
    var chrome;
    try { chrome = header() + tabsHtml(); }
    catch (e) { chrome = '<div class="header">CPOS</div>'; }
    app.innerHTML = chrome + body;
    renderedSource = state.source;
    bind();
    document.querySelectorAll(".config-tab-check:not(:disabled)").forEach(function (input) {
      input.onchange = function () {
        send("setPanelTab", { tab: input.getAttribute("data-tab"), shown: input.checked });
      };
    });
    applyIoSplit(ioSplit);
    bindIoSplitters(app);
    app.querySelectorAll(".test").forEach(function (card) {
      syncIoLines(card);
      bindIoHover(card);
    });
    autoResizeTextareas(app);

    if (activeTab === "statement") {
      if (window.MathJax && typeof window.MathJax.typesetPromise === "function") {
        window.MathJax.typesetPromise([app.querySelector('.statement-view')]).catch(function(){});
      }
    }
    scheduleResponsiveChrome();
  }

  // Update verdicts/results without wiping in-progress textarea edits (same file).
  function patch() {
    const app = document.getElementById("app");
    const cards = app.querySelectorAll(".test");
    // If the test count changed (add/delete/new capture), do a full render.
    if (cards.length !== state.tests.length) { render(); return; }

    const tmp = document.createElement("div");
    tmp.innerHTML = header() + statbar() + actions();
    const newHeader = tmp.querySelector(".header");
    const newActions = tmp.querySelector(".actions");
    const newSummary = tmp.querySelector(".summary");
    const oldHeader = app.querySelector(".header");
    const oldActions = app.querySelector(".actions");
    const oldSummary = app.querySelector(".summary");
    if (oldHeader && newHeader) oldHeader.replaceWith(newHeader);
    if (oldActions && newActions) oldActions.replaceWith(newActions);
    if (oldSummary && newSummary) oldSummary.replaceWith(newSummary);

    cards.forEach((card, i) => {
      const r = state.results.find((x) => x.index === i);
      card.className = "box test"
        + (state.running ? "" : r ? (r.passed ? " pass" : " fail") : "")
        + (isTestCollapsed(i) ? " collapsed" : "");
      const v = card.querySelector(".verdict");
      if (state.running) { v.textContent = "RUN"; v.className = "verdict run"; }
      else if (r) { v.textContent = r.verdict; v.className = "verdict " + verdictClass(r.verdict); }
      else { v.textContent = ""; v.className = "verdict none"; }
      const slot = card.querySelector(".result-slot");
      if (slot) slot.innerHTML = resultHtml(r);
    });
    bind();
    bindIoSplitters(app);
    app.querySelectorAll(".test").forEach(function (card) {
      syncIoLines(card);
      bindIoHover(card);
    });
    scheduleResponsiveChrome();
  }

  function bind() {
    document.querySelectorAll("[data-act]").forEach((el) => {
      el.onclick = async () => {
        const act = el.getAttribute("data-act");
        const idx = el.getAttribute("data-index");
        if (act === "toggleThemes") {
          themesOpen = !themesOpen;
          const bar = document.querySelector(".themebar");
          if (bar) bar.classList.toggle("open", themesOpen);
          return;
        }
        if (act === "setTheme") {
          applyTheme(el.getAttribute("data-theme"));
          document.querySelectorAll(".swatch").forEach((s) => {
            s.classList.toggle("active", s.getAttribute("data-theme") === theme);
          });
          return;
        }
        if (act === "openConfig") {
          activeTab = "config";
          persistUiState();
          render();
          return;
        }
        if (act === "chMode") {
          competeMode = el.getAttribute("data-mode") === "public" ? "public" : "friend";
          persistUiState();
          render();
          return;
        }
        if (act === "chSaveHandle") {
          const input = document.getElementById("cmp-handle");
          send("chSetHandle", { handle: input ? input.value.trim() : "" });
          return;
        }
        if (act === "uploadTemplate") {
          const input = document.getElementById("config-upload");
          if (input) input.click();
          return;
        }
        if (act === "resetTemplate") {
          const textarea = document.getElementById("config-template");
          if (textarea) textarea.value = "";
          return;
        }
        if (act === "saveTemplate") {
          const language = document.getElementById("config-lang");
          const defaultLanguage = document.getElementById("config-default-lang");
          const textarea = document.getElementById("config-template");
          if (language && textarea) {
            state.config.templates[language.value] = textarea.value;
            state.config.defaultLanguage = defaultLanguage ? defaultLanguage.value : state.config.defaultLanguage;
            send("saveTemplate", {
              language: language.value,
              content: textarea.value,
              defaultLanguage: state.config.defaultLanguage
            });
          }
          return;
        }
        if (act === "addTest") {
          syncStateFromDom();
          state.tests.push({ input: "", expected_output: "" });
          send("persistTests", { tests: state.tests.slice() });
          render();
          return;
        }
        if (act === "deleteTest") {
          syncStateFromDom();
          state.tests.splice(Number(idx), 1);
          state.results = [];
          removeCollapsedTest(Number(idx));
          send("persistTests", { tests: state.tests.slice() });
          render();
          return;
        }
        if (act === "toggleTest") {
          syncStateFromDom();
          toggleTestCollapsed(Number(idx));
          render();
          return;
        }
        if (act === "setTab") {
          activeTab = el.getAttribute("data-tab") || "tests";
          persistUiState();
          if (activeTab === "solution") send("fetchSolution");
          render();
          return;
        }
        if (act === "toggleAccordion") {
          const which = el.getAttribute("data-accordion");
          if (!which) return;
          const body = document.querySelector('[data-accordion-body="' + which + '"]');
          if (body) body.classList.toggle("open");
          const arrow = el.querySelector(".acc-arrow");
          if (arrow) arrow.classList.toggle("closed");
          return;
        }
        if (act === "openUrl") {
          const href = el.getAttribute("data-href");
          if (href) send("openUrl", { url: href });
          return;
        }
        if (act === "chCreate") {
          const msg = document.getElementById("cmp-msg");
          if (!state.cf || !state.cf.handle) {
            if (msg) msg.textContent = "Open a Codeforces page (with the CPOS companion) so CPOS can detect your handle.";
            return;
          }
          const opp = competeMode === "public" ? "" : ((document.getElementById("cmp-opp") || {}).value || "");
          const problemMode = ((document.getElementById("cmp-problem-mode") || {}).value || "random");
          const prob = problemMode === "current"
            ? ((state.meta && state.meta.id) || "")
            : problemMode === "custom"
              ? (((document.getElementById("cmp-prob") || {}).value || ""))
              : "";
          if (competeMode === "friend" && !opp.trim()) {
            if (msg) msg.textContent = "Enter your friend's Codeforces handle.";
            return;
          }
          if (problemMode === "custom" && !prob.trim()) {
            if (msg) msg.textContent = "Enter a Codeforces problem ID or link.";
            return;
          }
          const rating = +((document.getElementById("cmp-rating") || {}).value || 1400);
          const durationMin = +((document.getElementById("cmp-dur") || {}).value || 60);
          if (msg) msg.textContent = "Sending…";
          send("chCreate", { opponent: opp.trim(), problem: prob.trim(), rating: rating, durationMin: durationMin });
          return;
        }
        if (act === "chAccept") { send("chAccept", { id: el.getAttribute("data-id") }); return; }
        if (act === "chAcceptPublic") { send("chAcceptPublic", { id: el.getAttribute("data-id") }); return; }
        if (act === "chDecline") { send("chDecline", { id: el.getAttribute("data-id") }); return; }
        if (act === "chRemove") { send("chRemove", { id: el.getAttribute("data-id") }); return; }
        if (act === "chTogglePublic") {
          const min = +((document.getElementById("cmp-min") || {}).value || 800);
          const max = +((document.getElementById("cmp-max") || {}).value || 3500);
          send("chSetPublic", { on: !el.classList.contains("on"), min: min, max: max });
          return;
        }
        if (act === "runSingle") { send("runSingle", { index: Number(idx), tests: collectTests() }); return; }
        if (act === "run") { send("run", { tests: collectTests() }); return; }
        send(act);
      };
    });
    const configLang = document.getElementById("config-lang");
    const configTemplate = document.getElementById("config-template");
    if (configLang && configTemplate) {
      configLang.onchange = () => {
        configTemplate.value = state.config.templates[configLang.value] || "";
      };
    }
    const configUpload = document.getElementById("config-upload");
    if (configUpload && configTemplate) {
      configUpload.onchange = async () => {
        const file = configUpload.files && configUpload.files[0];
        if (file) configTemplate.value = await file.text();
        configUpload.value = "";
      };
    }
    const problemMode = document.getElementById("cmp-problem-mode");
    if (problemMode) {
      const syncProblemFields = function () {
        const mode = problemMode.value;
        const custom = document.getElementById("cmp-custom-field");
        const rating = document.getElementById("cmp-rating-field");
        if (custom) custom.style.display = mode === "custom" ? "" : "none";
        if (rating) rating.style.display = mode === "random" ? "" : "none";
      };
      problemMode.onchange = syncProblemFields;
      syncProblemFields();
    }
    document.querySelectorAll("textarea.in").forEach((ta) => {
      ta.oninput = () => {
        syncInputLines(ta);
        schedulePersist();
      };
    });
    document.querySelectorAll("textarea.exp").forEach((ta) => {
      ta.oninput = () => {
        const card = ta.closest(".test");
        if (card) syncIoLines(card);
        schedulePersist();
        autoResizeTextareas(ta.closest(".test") || document);
      };
    });
    document.querySelectorAll(".test").forEach(function (card) {
      bindIoHover(card);
    });
    autoResizeTextareas(document);
  }

  function syncStateFromDom() {
    const collected = collectTests();
    if (collected.length === state.tests.length) state.tests = collected;
  }

  function applyTabCompression() {
    const container = document.querySelector(".tabs");
    if (!container) return;
    const tabs = Array.from(container.querySelectorAll(".tab[data-tab]"));
    tabs.forEach(function (tab) { tab.classList.remove("compact"); });

    const byCompressionPreference = tabs.slice().sort(function (a, b) {
      return (+a.getAttribute("data-priority") || 0) - (+b.getAttribute("data-priority") || 0);
    });
    let index = 0;
    while (container.scrollWidth > container.clientWidth + 1 && index < byCompressionPreference.length) {
      byCompressionPreference[index].classList.add("compact");
      index++;
    }
  }

  function applyHeaderCompression() {
    const row = document.querySelector(".head .row");
    if (!row) return;
    const tools = row.querySelector(".headtools");
    const brand = row.querySelector(".brandrow");
    if (!tools || !brand) return;
    const controls = Array.from(row.querySelectorAll(".headtools .iconbtn[data-prio]"));
    controls.forEach(function (control) {
      control.classList.remove("compact");
      control.classList.remove("squeezed");
    });
    controls.sort(function (a, b) {
      return (+a.getAttribute("data-prio") || 0) - (+b.getAttribute("data-prio") || 0);
    });
    const rowWidth = row.getBoundingClientRect().width;
    if (rowWidth <= 1) {
      tools.style.maxWidth = "";
      return;
    }
    const rowStyle = window.getComputedStyle(row);
    const gap = parseFloat(rowStyle.columnGap || rowStyle.gap || "8") || 8;
    const available = Math.max(0, rowWidth - brand.getBoundingClientRect().width - gap);
    tools.style.maxWidth = available + "px";
    function overflows() {
      return tools.scrollWidth > available + 1 || row.scrollWidth > row.clientWidth + 1;
    }
    let index = 0;
    while (overflows() && index < controls.length) {
      controls[index].classList.add("compact");
      index++;
    }
    index = 0;
    while (overflows() && index < controls.length) {
      controls[index].classList.add("squeezed");
      index++;
    }
  }

  function applyResponsiveChrome() {
    applyTabCompression();
    applyHeaderCompression();
  }

  let responsiveRAF = 0;
  let responsiveTimer = 0;
  function scheduleResponsiveChrome() {
    if (responsiveRAF) cancelAnimationFrame(responsiveRAF);
    if (responsiveTimer) clearTimeout(responsiveTimer);
    applyResponsiveChrome();
    responsiveRAF = requestAnimationFrame(function () {
      responsiveRAF = 0;
      applyResponsiveChrome();
    });
    responsiveTimer = setTimeout(function () {
      responsiveTimer = 0;
      applyResponsiveChrome();
    }, 80);
    setTimeout(applyResponsiveChrome, 240);
    setTimeout(applyResponsiveChrome, 700);
  }

  let themeFromHost = false;
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "state") {
      const incoming = msg.state;
      // Adopt the theme saved in the extension once (source of truth across restarts).
      if (!themeFromHost && incoming && typeof incoming.theme === "string" && incoming.theme) {
        themeFromHost = true;
        if (incoming.theme !== theme) {
          theme = incoming.theme;
          document.body.setAttribute("data-theme", theme);
          persistUiState();
        }
      }
      const sameFile = incoming.source === renderedSource && renderedSource !== undefined;
      state = incoming;
      const shown = state.tabs || { statement: true, solution: true, compete: true };
      if (
        (activeTab === "statement" && shown.statement === false) ||
        (activeTab === "solution" && shown.solution === false) ||
        (activeTab === "compete" && shown.compete === false)
      ) {
        activeTab = "tests";
        persistUiState();
      }
      if (sameFile && activeTab === "tests") patch();
      else render();
    }
  });

  window.addEventListener("resize", scheduleResponsiveChrome);
  window.addEventListener("focus", scheduleResponsiveChrome);
  window.addEventListener("pageshow", scheduleResponsiveChrome);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) scheduleResponsiveChrome();
  });
  try {
    const chromeResizeObserver = new ResizeObserver(scheduleResponsiveChrome);
    chromeResizeObserver.observe(document.documentElement);
    const app = document.getElementById("app");
    if (app) chromeResizeObserver.observe(app);
  } catch (_) {}

  send("ready");
</script>
</body>
</html>`;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
