import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fixture } from "./fixtures.mjs";
import { assertCanonicalSources, executePlan, releasePlan, sourceSnapshot } from "../../scripts/release-gate.mjs";

test("the release gate covers every package, both runtimes and the real MCP delivery binary", () => {
  assertCanonicalSources();
  const stages = releasePlan(path.resolve(import.meta.dirname, "..", "..", "..", "spool"));
  assert.equal(stages.length, 10);
  for (const label of ["Paperclip UI source parity", "Production monitor bundle", "Spool core tests", "Supervisor tests", "Shared tooling and dashboard",
    "Bohemia publisher and preparation", "All scanner engines", "All bridge consumers"]) {
    assert.ok(stages.some(stage => stage.name === label), label);
  }
  assert.ok(stages.at(-1).env.SPOOL_TEST_BINARY);
  assert.match(sourceSnapshot(path.resolve(import.meta.dirname, "..", "..")), /^[a-f0-9]{64}$/);
});

test("release validation stops on the first failure or process-launch error", () => {
  const plan = [{ name: "first", command: "fixture", args: [] }, { name: "second", command: "fixture", args: [] }];
  for (const failure of [{ status: 1 }, { error: new Error("cannot launch") }]) {
    let calls = 0;
    assert.throws(() => executePlan(plan, () => { calls++; return failure; }), /first failed/);
    assert.equal(calls, 1);
  }
});

test("stack installation defaults to login and includes the web UI without changing tasks in preview", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t), root = path.resolve(import.meta.dirname, "..", "..");
  writeFileSync(path.join(f.root, "start-spool.ps1"), "exit 0");
  const config = path.join(f.root, "config.json");
  writeFileSync(config, JSON.stringify({ spool_dir: f.root }));
  const result = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `& '${path.join(root, "install-stack.ps1")}' -Config '${config}' -WhatIf | ConvertTo-Json`,
  ], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const plans = JSON.parse(result.stdout);
  assert.equal(plans.length, 4);
  assert.deepEqual(plans.map(plan => plan.Component), ["Daemon", "Runners", "Dashboard", "WebUI"]);
  assert.ok(plans.every(plan => plan.Mode === "Logon"));
  assert.equal(plans[2].Script, path.join(root, "start-dashboard.ps1"));
  assert.equal(plans[3].Script, path.resolve(root, "..", "spool-web-ui", "scripts", "start-ui.ps1"));
});
