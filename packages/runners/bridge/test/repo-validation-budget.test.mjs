import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import "../../packages/dedicated-runners/tests/compat-entrypoints.test.mjs";
import "../../packages/bohemia-pr-mcp/src/ci-dedupe.test.cjs";

test("canonical validation keeps CI commands and scope-specific bounded deadlines", { skip: process.platform !== "win32" }, () => {
  const script = fileURLToPath(new URL("../../packages/dedicated-runners/tests/repo-check-launcher.tests.ps1", import.meta.url));
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script], {
    encoding: "utf8", windowsHide: true, timeout: 30_000,
  });

  assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Repository check launcher regression tests passed/);
});

test("canonical publication pins the source and refreshes the target", { skip: process.platform !== "win32" }, () => {
  const script = fileURLToPath(new URL("../../packages/dedicated-runners/tests/publication-routing.tests.ps1", import.meta.url));
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script], {
    encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Publication routing and target refresh regression tests passed/);
});
