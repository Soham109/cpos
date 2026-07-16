import assert from "node:assert/strict";
import test from "node:test";
import { expandCommand, quoteShellPath } from "./command";

test("keeps a Windows user-profile output path with spaces as one argument", () => {
  const command = expandCommand(
    "g++ -std=c++17 -O2 -o {output}.exe {source}",
    "C:\\Users\\Ronit Dama\\Problems\\A.cpp",
    "A",
    "C:\\Users\\Ronit Dama\\.cpos-vscode\\build",
    "A",
    "win32"
  );

  assert.equal(
    command,
    'g++ -std=c++17 -O2 -o "C:\\Users\\Ronit Dama\\.cpos-vscode\\build\\A.exe" "C:\\Users\\Ronit Dama\\Problems\\A.cpp"'
  );
  assert.doesNotMatch(command, /-o C:\\Users\\Ronit /);
});

test("does not add literal quotes to simple Windows paths", () => {
  assert.equal(quoteShellPath("C:\\cpos\\build\\A.exe", "win32"), "C:\\cpos\\build\\A.exe");
});
