import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs, existsSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import * as vscode from "vscode";

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

// Verdicts that can come back from an online judge for a real submission. This
// is a superset of the local-run Verdict (which only knows the sample-test
// outcomes): an actual judge can also report memory/idleness limits, partial
// scores, queued/judging states, etc.
type SubmissionVerdict =
  | "AC"      // Accepted
  | "WA"      // Wrong answer
  | "TLE"     // Time limit exceeded
  | "MLE"     // Memory limit exceeded
  | "ILE"     // Idleness limit exceeded
  | "RE"      // Runtime error
  | "CE"      // Compilation error
  | "PARTIAL" // Partial score (e.g. CSES / scored problems)
  | "REJECTED"
  | "PENDING" // Queued or still being judged
  | "UNKNOWN";

// A single submission to an online judge, shown in the Submissions tab.
type Submission = {
  // Stable submission id from the judge when known, otherwise a locally
  // generated id so freshly-queued submissions still render before a verdict.
  id: string;
  problemId: string;
  // ISO timestamp of when the submission was made.
  submittedAt: string;
  verdict: SubmissionVerdict;
  language?: string;
  // Optional extra detail (e.g. "test 14", "score 70") shown next to verdict.
  detail?: string;
};

type SubmissionState = {
  problemId: string;
  status: "loading" | "done" | "error";
  submissions: Submission[];
};

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

const PANEL_THEME_KEY = "cpos.panelTheme";

const runResults = new Map<string, RunResult[]>();
let runningFor: string | undefined;
let solutionData: SolutionState | undefined;
let submissionData: SubmissionState | undefined;

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
  java: { compile: "javac -d {dir} {source}", run: "java -cp {dir} Main", extension: "java" },
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
  java: "import java.util.*;\nimport java.io.*;\n\nclass Main {\n    public static void main(String[] args) throws IOException {\n        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));\n\n    }\n}\n",
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

  if (req.method === "POST" && req.url === "/capture/problem") {
    try {
      const body = await readJson<CapturedProblem>(req);
      const created = await captureProblem(body);
      sendJson(res, 200, { ok: true, name: body.name, tests: body.tests?.length ?? 0, solutionPath: created.solutionPath });
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
  // Java needs the file named after its public class (Main); anything else is fine.
  const base = lang === "java" ? "Main" : "cpos_run";
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

async function captureProblem(problem: CapturedProblem): Promise<ProblemMeta> {
  validateProblem(problem);
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
      await fs.writeFile(solutionPath, await templateFor(lang), "utf8");
    }
  }

  const tests = problem.tests ?? [];
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
    statementHtml: problem.statementHtml,
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
  const detail = attachToActive
    ? `${tests.length} sample(s) → ${path.basename(solutionPath)}`
    : `${tests.length} sample(s)`;
  vscode.window.showInformationMessage(`CPOS · ${problem.id} (${problem.name}) — ${detail}.`);
  await forwardCaptureToTui(problem, solutionPath);
  return lastProblem;
}

function activeEditorFilePath(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.uri.scheme === "file") return editor.document.uri.fsPath;
  return undefined;
}

function validateProblem(problem: CapturedProblem): void {
  for (const key of ["platform", "id", "name", "url"] as const) {
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
    return applyPlatformRun(absolutizeConfig({ compile: tui.compile, run: tui.run, extension: tui.extension }));
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
  return path.join(dir, `${solutionBaseName(problem)}.${extension}`);
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
      return path.join(path.dirname(primary), `${slug}-${safeId(problem.id)}.${extension}`);
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

function solutionBaseName(problem: CapturedProblem | ProblemMeta): string {
  if (isCsesPlatform(problem.platform)) {
    const slug = slugFromName(problem.name);
    if (slug) return slug;
  }
  return safeId(problem.id);
}

function activeNameMatchesProblem(activePath: string, problem: CapturedProblem): boolean {
  const base = path.parse(activePath).name.toLowerCase();
  const id = safeId(problem.id).toLowerCase();
  if (base === id) return true;
  if (isCsesPlatform(problem.platform)) {
    const slug = slugFromName(problem.name).toLowerCase();
    if (slug && (base === slug || base === `${slug}-${id}`)) return true;
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

async function templateFor(lang: string): Promise<string> {
  // Prefer an explicit VS Code template, then the template configured in the
  // CPOS TUI, then the built-in starter.
  const templateFile = (userSetting<string>("templateFile") ?? tuiConfig().templateFile ?? "").trim();
  if (templateFile) {
    try {
      return await fs.readFile(expandHome(templateFile), "utf8");
    } catch (error) {
      OUTPUT.appendLine(`Could not read template file: ${String(error)}`);
    }
  }
  return DEFAULT_TEMPLATES[lang] ?? "";
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

// Submissions are stored per problem id so they survive across files, panel
// reloads, and VS Code restarts. Each problem gets its own JSON file under the
// data dir keyed by a hash of the problem id.
function submissionsPathFor(problemId: string): string {
  return path.join(dataDir(), "submissions", `${hashPath(problemId)}.json`);
}

async function loadSubmissions(problemId: string): Promise<Submission[]> {
  try {
    const raw = await fs.readFile(submissionsPathFor(problemId), "utf8");
    const parsed = JSON.parse(raw) as Submission[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveSubmissions(problemId: string, submissions: Submission[]): Promise<void> {
  await fs.mkdir(path.join(dataDir(), "submissions"), { recursive: true });
  await fs.writeFile(
    submissionsPathFor(problemId),
    JSON.stringify(submissions, null, 2),
    "utf8"
  );
}

// Merge new submissions into the stored list, de-duplicating by id (a later
// entry for the same id wins so verdicts can be upgraded from PENDING), then
// keep them newest-first.
async function recordSubmission(problemId: string, incoming: Submission): Promise<Submission[]> {
  const existing = await loadSubmissions(problemId);
  const byId = new Map<string, Submission>();
  for (const s of existing) byId.set(s.id, s);
  byId.set(incoming.id, incoming);
  const merged = Array.from(byId.values()).sort(
    (a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt)
  );
  await saveSubmissions(problemId, merged);
  return merged;
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
  else if (/^\d+[A-Za-z]\d*$/.test(id)) platform = "codeforces";

  if (!platform) return undefined;

  if (platform === "cses" && !/^\d+$/.test(id)) {
    return undefined;
  }

  const url = platform === "codeforces" ? codeforcesProblemUrl(id) : `https://cses.fi/problemset/task/${id}`;
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
  const timeoutMs = config().get<number>("runTimeoutMs", 5000);

  const targets = indices && indices.length > 0 ? indices : tests.map((_, i) => i);
  const existing = runResults.get(source) ?? [];

  runningFor = source;
  refreshActions();

  try {
    if (compileConfig.compile) {
      const compileCommand = expandCommand(compileConfig.compile, source, outputName, buildDir);
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
      const runCommand = expandCommand(compileConfig.run, source, outputName, buildDir);
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
  const code =
    editor?.document.uri.fsPath === source ? editor.document.getText() : await fs.readFile(source, "utf8");
  if (!code.trim()) {
    vscode.window.showWarningMessage("The active solution file is empty.");
    return;
  }

  const lang = languageForFile(source);
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
  await recordQueuedSubmission(meta.id, lang);
  void showSubmitQueuedStatus(meta.id, submitUrl, pendingSubmit);
}

// Log a locally-known submission the moment the user submits, before any
// verdict is available, so the Submissions tab reflects the attempt right away.
// The verdict starts as PENDING and is upgraded later when the judge reports
// back (see fetchAndCacheSubmissions).
async function recordQueuedSubmission(problemId: string, language: string): Promise<void> {
  const now = new Date();
  const submission: Submission = {
    id: `local-${now.getTime()}`,
    problemId,
    submittedAt: now.toISOString(),
    verdict: "PENDING",
    language
  };
  const merged = await recordSubmission(problemId, submission);
  submissionData = { problemId, status: "done", submissions: merged };
  refreshActions();
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

function expandCommand(command: string, source: string, outputName: string, buildDir: string): string {
  const classname = path.parse(source).name;
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
    .replaceAll("{classname}", outputName === classname ? outputName : quoteShellPath(classname));
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
  const platformKey = meta.platform.toLowerCase();
  const platformLabel =
    platformKey === "codeforces" || platformKey === "cf"
      ? "Codeforces"
      : platformKey === "cses"
        ? "CSES"
        : meta.platform;
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
  submissions?: SubmissionState;
};

async function currentState(): Promise<PanelState> {
  const source = await activeSolutionPath();
  const meta = source ? await loadProblemMetaForFile(source) : await loadProblemMeta();
  const tests = source ? await loadSamples(source) : [];
  const results = source ? runResults.get(source) ?? [] : [];
  const solution = meta && solutionData?.problemId === meta.id ? solutionData : undefined;
  const submissions = meta && submissionData?.problemId === meta.id ? submissionData : undefined;
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
    submissions
  };
}

function refreshActions(): void {
  actionsProvider?.refresh();
}

function buildSolutionQuery(meta: ProblemMeta): string {
  const platform = meta.platform.toLowerCase();
  if (platform === "codeforces" || platform === "cf") {
    return `codeforces ${meta.id} ${meta.name} editorial solution`;
  }
  if (platform === "cses") {
    return `cses ${meta.name} solution tutorial`;
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

// Map a Codeforces API verdict string to our compact SubmissionVerdict.
function mapCfVerdict(verdict: string | undefined): SubmissionVerdict {
  switch (verdict) {
    case "OK": return "AC";
    case "WRONG_ANSWER": return "WA";
    case "TIME_LIMIT_EXCEEDED": return "TLE";
    case "MEMORY_LIMIT_EXCEEDED": return "MLE";
    case "IDLENESS_LIMIT_EXCEEDED": return "ILE";
    case "RUNTIME_ERROR": return "RE";
    case "COMPILATION_ERROR": return "CE";
    case "PARTIAL": return "PARTIAL";
    case "REJECTED":
    case "CHALLENGED": return "REJECTED";
    case "TESTING":
    case "SUBMITTED":
    case undefined:
    case "":
      return "PENDING";
    default: return "UNKNOWN";
  }
}

type CfSubmission = {
  id: number;
  creationTimeSeconds: number;
  programmingLanguage?: string;
  verdict?: string;
  passedTestCount?: number;
  problem?: { contestId?: number; index?: string };
};

// Pull the user's recent submissions for this problem from the public
// Codeforces API and merge real verdicts into the stored submission list.
// Requires a configured handle; only Codeforces problems are supported.
async function fetchCodeforcesSubmissions(meta: ProblemMeta): Promise<Submission[] | undefined> {
  const platform = meta.platform.toLowerCase();
  if (platform !== "codeforces" && platform !== "cf") return undefined;
  const handle = config().get<string>("codeforcesHandle", "").trim();
  if (!handle) return undefined;
  const cf = parseCodeforcesId(meta.id);
  if (!cf.contest) return undefined;

  // Pull a large window so we surface every submission to this problem, not
  // just the most recent handful across all problems.
  const url = `https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}&from=1&count=10000`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return undefined;
    const json = (await resp.json()) as { status?: string; result?: CfSubmission[] };
    if (json.status !== "OK" || !Array.isArray(json.result)) return undefined;
    return json.result
      .filter((s) =>
        String(s.problem?.contestId ?? "") === cf.contest &&
        (!cf.index || (s.problem?.index ?? "").toUpperCase() === cf.index))
      .map((s) => {
        const verdict = mapCfVerdict(s.verdict);
        const detail = verdict !== "AC" && typeof s.passedTestCount === "number"
          ? `passed ${s.passedTestCount}`
          : undefined;
        return {
          id: String(s.id),
          problemId: meta.id,
          submittedAt: new Date(s.creationTimeSeconds * 1000).toISOString(),
          verdict,
          language: s.programmingLanguage,
          detail
        } as Submission;
      });
  } catch {
    return undefined;
  }
}

// Refresh the Submissions tab: start from locally-recorded submissions, then
// fold in real verdicts fetched from the judge (when a handle is configured).
async function fetchAndCacheSubmissions(): Promise<void> {
  const source = await activeSolutionPath();
  const meta = source ? await loadProblemMetaForFile(source) : await loadProblemMeta();
  if (!meta) return;

  submissionData = {
    problemId: meta.id,
    status: "loading",
    submissions: await loadSubmissions(meta.id)
  };
  refreshActions();

  const fetched = await fetchCodeforcesSubmissions(meta);
  let merged: Submission[];
  if (fetched && fetched.length > 0) {
    // The judge is authoritative once it reports submissions: take its full
    // history (real verdicts) and drop our local "pending" placeholders so a
    // submission never stays stuck on Pending or shows up twice.
    merged = fetched
      .slice()
      .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
    await saveSubmissions(meta.id, merged);
  } else {
    // No handle configured, judge unreachable, or nothing fetched yet: fall
    // back to whatever we recorded locally.
    merged = await loadSubmissions(meta.id);
  }
  submissionData = { problemId: meta.id, status: "done", submissions: merged };
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
  }): Promise<void> {
    switch (message.type) {
      case "ready":
        await this.postState();
        break;
      case "saveTheme":
        if (message.theme) await extContext?.globalState.update(PANEL_THEME_KEY, message.theme);
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
      case "fetchSubmissions":
        void fetchAndCacheSubmissions();
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

  .head { padding: 11px 12px; margin-bottom: 10px; }
  .head .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .brandrow { display: flex; align-items: center; gap: 7px; }
  .logo {
    width: 16px; height: 16px; border-radius: 4px; flex-shrink: 0;
    display: block; object-fit: contain;
  }
  .title { font-weight: 700; font-size: 13px; color: var(--fg); letter-spacing: 0.08em; }
  .rule { height: 1px; background: var(--border-soft); margin: 9px 0; }

  /* header icon buttons */
  .headtools { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; }
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
  }
  .iconbtn:hover { border-color: var(--accent-dim); }
  .iconbtn svg { width: 12px; height: 12px; flex-shrink: 0; }
  .iconbtn.gh {
    background: #0d1117;
    border-color: #30363d;
    color: #f0f6fc;
  }
  .iconbtn.gh:hover { background: #161b22; border-color: #484f58; color: #fff; }
  .iconbtn.icononly { padding: 4px; justify-content: center; }
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
  /* Submission verdicts (superset of the local-run verdicts above). */
  .verdict.MLE, .verdict.ILE, .verdict.PARTIAL { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 50%, var(--border)); }
  .verdict.REJECTED { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 50%, var(--border)); }
  .verdict.PENDING { color: var(--accent); border-color: var(--accent-dim); }
  .verdict.UNKNOWN { color: var(--dim); border-color: var(--border); }
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
  .tabs { flex: 0 0 auto; display: flex; gap: 4px; margin-bottom: 10px; border-bottom: 1px solid var(--border-soft); overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
  .tabs::-webkit-scrollbar { height: 4px; }
  .tab { flex: 0 0 auto; white-space: nowrap; padding: 6px 12px; border: none; background: transparent; color: var(--dim); cursor: pointer; border-bottom: 2px solid transparent; font-size: 11px; font-family: var(--mono); text-transform: uppercase; letter-spacing: 0.05em; }
  .tab.active { color: var(--fg); border-bottom-color: var(--accent); font-weight: 700; }
  .tab:hover:not(.active) { color: var(--fg); }
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
  .sub-head-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 2px 0 10px;
  }
  .sub-head {
    font-size: 11px;
    font-weight: 700;
    color: var(--fg);
    letter-spacing: 0.04em;
  }
  .sub-refresh { flex: 0 0 auto; }
  .sub-list { display: flex; flex-direction: column; gap: 8px; }
  .sub-card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--panel) 88%, transparent);
    padding: 9px 11px;
  }
  .sub-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .sub-id { font-size: 12px; font-weight: 700; color: var(--fg); }
  .sub-meta {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    margin-top: 6px; font-size: 10px; color: var(--dim);
  }
  .sub-time { color: var(--dim); }
  .sub-lang { color: var(--fg); opacity: 0.8; }
  .sub-detail { color: var(--warn); }
  .sub-empty { font-size: 11px; color: var(--dim); line-height: 1.5; }
  .sub-empty code {
    font-family: var(--mono);
    background: var(--highlight);
    padding: 1px 4px;
    border-radius: 3px;
    color: var(--fg);
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
  const vscode = acquireVsCodeApi();
  let state = { tests: [], results: [], source: null };
  let renderedSource = undefined;
  const saved = vscode.getState() || {};
  let theme = saved.theme || 'cpos';
  let activeTab = saved.activeTab || 'tests';
  let themesOpen = false;
  let ioSplit = typeof saved.ioSplit === 'number' ? saved.ioSplit : 68;
  let collapsedTests = saved.collapsedTests && typeof saved.collapsedTests === 'object' ? saved.collapsedTests : {};
  document.body.setAttribute('data-theme', theme);

  function persistUiState() {
    vscode.setState(Object.assign({}, vscode.getState(), { theme, ioSplit, activeTab, collapsedTests }));
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
        + '<div class="pname">open a Codeforces/CSES problem in your browser to capture it</div>';
    }
    const file = state.fileName
      ? '<span class="link" data-act="openSource">' + esc(state.fileName) + '</span>'
      : '<span class="muted">no file open</span>';
    const tests = state.tests.length + ' test' + (state.tests.length === 1 ? '' : 's');
    return '<div class="box head header">'
      + '<div class="row">'
      + '<span class="brandrow"><img class="logo" src="' + CPOS_LOGO + '" alt="CPOS" /><span class="title">CPOS</span></span>'
      + '<span class="headtools">'
      + '<button class="iconbtn sponsor" data-act="openSponsor" title="Sponsor CPOS — keep it free and local-first">' + HEART_ICON + 'Sponsor</button>'
      + '<button class="iconbtn gh icononly" data-act="openGithub" title="CPOS on GitHub" aria-label="CPOS on GitHub">' + GH_ICON + '</button>'
      + '<button class="iconbtn theme" data-act="toggleThemes" title="Themes">◑ theme</button>'
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
    if (!state.meta) return '';
    const tabs = [{ id: 'tests', label: 'Tests' }];
    if (state.meta.statementHtml) tabs.push({ id: 'statement', label: 'Statement' });
    tabs.push({ id: 'submissions', label: 'Submissions' });
    // Solution tab is hidden while the problem's contest is still running.
    if (!state.solutionBlocked) tabs.push({ id: 'solution', label: 'Solution' });
    return '<div class="tabs" role="tablist">'
      + tabs.map(function(t) {
        return '<button role="tab" aria-selected="' + (activeTab === t.id ? "true" : "false")
          + '" tabindex="0" class="tab ' + (activeTab === t.id ? "active" : "")
          + '" data-act="setTab" data-tab="' + t.id + '">' + t.label + '</button>';
      }).join('')
      + '</div>';
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
    const isCses = String(state.meta.platform || "").toLowerCase() === "cses";
    if (isCses && state.meta.name) {
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
      videoContent = '<div class="sol-empty">Could not auto-load videos — use the links below to search manually.</div>';
    }

    // ── Links accordion content ──
    const pid  = String(m.id   || '');
    const pname = String(m.name || '');
    const plat  = String(m.platform || '').toLowerCase();
    const isCf  = plat === 'codeforces' || plat === 'cf';
    const ytQ = encodeURIComponent((isCf ? 'codeforces ' : '') + pid + ' ' + pname + ' editorial solution');
    const gQ  = encodeURIComponent((isCf ? 'Codeforces ' : '') + pid + ' ' + pname + ' editorial solution');

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
      + accordion('videos', 'Video Solutions', videoContent, true)
      + accordion('links',  'Editorials &amp; Links', linksHtml, true)
      + '</div>';
  }

  // Human label shown inside the verdict badge for each submission.
  function verdictLabel(v) {
    switch (v) {
      case 'AC': return 'Accepted';
      case 'WA': return 'Wrong Answer';
      case 'TLE': return 'Time Limit';
      case 'MLE': return 'Memory Limit';
      case 'ILE': return 'Idleness Limit';
      case 'RE': return 'Runtime Error';
      case 'CE': return 'Compile Error';
      case 'PARTIAL': return 'Partial';
      case 'REJECTED': return 'Rejected';
      case 'PENDING': return 'Pending';
      default: return 'Unknown';
    }
  }

  function formatSubmissionTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function submissionsSection() {
    const sub = state.submissions;
    const status = sub ? sub.status : 'loading';
    const list = (sub && sub.submissions) ? sub.submissions : [];

    let body;
    if (status === 'loading' && list.length === 0) {
      body = '<div class="sol-spinner">&#9680; Loading submissions…</div>';
    } else if (list.length === 0) {
      body = '<div class="sub-empty">No submissions yet. Submit from CPOS, or set '
        + '<code>cpos.codeforcesHandle</code> to pull your judge verdicts.</div>';
    } else {
      // Newest first; show every submission to this problem. The list scrolls
      // inside the wrapper when it grows long.
      const rows = list.map(function(s, i) {
        const num = list.length - i;
        const v = s.verdict || 'UNKNOWN';
        const detail = s.detail ? '<span class="sub-detail">' + esc(s.detail) + '</span>' : '';
        const lang = s.language ? '<span class="sub-lang">' + esc(s.language) + '</span>' : '';
        return '<div class="sub-card">'
          + '<div class="sub-row">'
          + '<span class="sub-id">#' + num + '</span>'
          + '<span class="verdict ' + esc(v) + '">' + esc(verdictLabel(v)) + '</span>'
          + '</div>'
          + '<div class="sub-meta">'
          + '<span class="sub-time">' + esc(formatSubmissionTime(s.submittedAt)) + '</span>'
          + lang + detail
          + '</div>'
          + '</div>';
      }).join('');
      body = '<div class="sub-list">' + rows + '</div>';
    }
    return '<div class="sol-wrapper">'
      + '<div class="sub-head-row">'
      + '<span class="sub-head">Submissions</span>'
      + '<button class="ghost sub-refresh" data-act="fetchSubmissions" title="Refresh verdicts">&#8635; refresh</button>'
      + '</div>'
      + body + '</div>';
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
      } else if (activeTab === "submissions" && state.meta) {
        body = submissionsSection();
      } else if (activeTab === "solution" && state.meta && !state.solutionBlocked) {
        body = solutionSection();
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
  }

  // Update verdicts/results without wiping in-progress textarea edits (same file).
  function patch() {
    const app = document.getElementById("app");
    // patch() only knows how to update the Tests view in place (to preserve
    // in-progress textarea edits). For Statement/Submissions/Solution a state
    // update must do a full render, otherwise their content goes stale (e.g.
    // submission verdicts never refresh after a fetch).
    if (activeTab !== "tests") { render(); return; }
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
  }

  function bind() {
    document.querySelectorAll("[data-act]").forEach((el) => {
      el.onclick = () => {
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
          if (activeTab === "submissions") send("fetchSubmissions");
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
        if (act === "runSingle") { send("runSingle", { index: Number(idx), tests: collectTests() }); return; }
        if (act === "run") { send("run", { tests: collectTests() }); return; }
        send(act);
      };
    });
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
      if (sameFile) patch();
      else render();
    }
  });

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
