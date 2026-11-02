import { spawn, type ChildProcess } from "node:child_process";

export type ProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeMs: number;
};

export type ProcessOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  timeoutMs: number;
};

/** How long to wait for pipes to close after a timeout kill before giving up on them. */
const KILL_GRACE_MS = 2000;

/**
 * Run a process and collect its output. On timeout the whole process tree is
 * killed, not just the top process, so programs started through a shell (or
 * that start children of their own) do not outlive the run.
 */
export function runProcess(file: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const isWindows = process.platform === "win32";
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        // On macOS and Linux this puts the command in its own process group,
        // so a timeout can signal the shell and everything it started at once.
        detached: !isWindows,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut, timeMs: Date.now() - start });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // A process that escaped the group can keep the pipes open and delay
      // "close" forever. Resolve anyway once the grace period ends.
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(child.exitCode);
      }, KILL_GRACE_MS);
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (graceTimer) clearTimeout(graceTimer);
      killTree(child);
      reject(error);
    });
    child.on("close", (code) => finish(code));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input);
  });
}

/** Kill a process and all of its descendants. Never throws. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.on("error", () => killDirect(child));
      killer.on("exit", (code) => {
        if (code !== 0) killDirect(child);
      });
    } catch {
      killDirect(child);
    }
    return;
  }
  try {
    // Negative pid signals the whole process group created by `detached`.
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group may already be gone, or the spawn was not detached.
    killDirect(child);
  }
}

function killDirect(child: ChildProcess): void {
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  } catch {
    // Already exited.
  }
}
