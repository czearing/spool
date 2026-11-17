import test from "node:test";
import assert from "node:assert/strict";
import { windowsProcesses } from "../src/windows-processes.js";

test("Windows ownership inventory retains all process identities with a bounded cold-start deadline", () => {
  const processes = [
    { ProcessId: 42, Name: "copilot.exe", CommandLine: "copilot --session active-review" },
    { ProcessId: 43, Name: "node.exe", CommandLine: "node runner.mjs" },
  ];
  const actual = windowsProcesses((command, args, options) => {
    assert.equal(command, "powershell.exe");
    assert.ok(args.includes("-NoProfile"));
    assert.ok(args.includes("-NonInteractive"));
    assert.match(args.at(-1), /Get-CimInstance Win32_Process/);
    assert.equal(options.timeout, 90_000);
    assert.equal(options.windowsHide, true);
    return Buffer.from(JSON.stringify(processes)).toString("base64");
  });
  assert.deepEqual(actual, processes);
});

test("a timed-out Windows inventory remains an error, never an empty ownership result", () => {
  const failure = Object.assign(new Error("Windows inventory timed out"), { code: "ETIMEDOUT" });
  assert.throws(() => windowsProcesses(() => { throw failure; }), error => error === failure);
});

test("invalid Windows inventory cannot pass as an idle workspace", () => {
  assert.throws(() => windowsProcesses(() => Buffer.from("incomplete").toString("base64")), SyntaxError);
});
