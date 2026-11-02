import assert from "node:assert/strict";
import test from "node:test";
import { runProcess } from "./process";

const posix = process.platform !== "win32";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

test("collects output and exit code from a normal run", { skip: !posix }, async () => {
  const result = await runProcess("/bin/sh", ["-c", "cat; echo err >&2; exit 3"], {
    cwd: process.cwd(),
    env: process.env,
    input: "hello\n",
    timeoutMs: 5000
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 3);
  assert.equal(result.stdout, "hello\n");
  assert.equal(result.stderr, "err\n");
});

test("timeout kills the shell and the child processes it started", { skip: !posix }, async () => {
  const result = await runProcess("/bin/sh", ["-c", "sleep 37 & echo $!; wait"], {
    cwd: process.cwd(),
    env: process.env,
    input: "",
    timeoutMs: 300
  });
  assert.equal(result.timedOut, true);
  const childPid = Number(result.stdout.trim());
  assert.ok(Number.isInteger(childPid) && childPid > 0, `expected a child pid, got ${JSON.stringify(result.stdout)}`);
  assert.ok(result.timeMs < 2000, `run should end soon after the timeout, took ${result.timeMs}ms`);
  assert.ok(await waitUntilGone(childPid, 2000), `child ${childPid} is still running after timeout`);
});

test("timeout resolves even when a child escapes the process group", { skip: !posix }, async () => {
  // perl's setsid moves the grandchild into a new session, out of reach of
  // the group kill, while it keeps stdout open. The run must still resolve.
  let escapedPid: number | undefined;
  try {
    const result = await runProcess(
      "/bin/sh",
      ["-c", "perl -e 'use POSIX; if (my $p = fork) { print \"$p\\n\"; exit 0 } POSIX::setsid(); sleep 37' & wait; sleep 37"],
      { cwd: process.cwd(), env: process.env, input: "", timeoutMs: 300 }
    );
    escapedPid = Number(result.stdout.trim()) || undefined;
    assert.equal(result.timedOut, true);
    assert.ok(result.timeMs < 5000, `run should resolve after the grace period, took ${result.timeMs}ms`);
  } finally {
    if (escapedPid) {
      try {
        process.kill(escapedPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});
