import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureProductionBrowser } from "../browser-runner.mjs";
import { artifactFixture } from "./fixtures.js";

test("the real Node worker rejects malformed requests rather than silently exiting successfully", () => {
  const file = fileURLToPath(new URL("../browser-runner.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [file, "--request", "{}"], {
    encoding: "utf8", windowsHide: true, timeout: 10000,
  });
  assert.equal(result.status, 1, `${result.error ?? ""}\n${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /path|absolute/i);
});

test("worker and owned-server startup failures reach callers without hanging or returning fake evidence", async t => {
  await assert.rejects(captureProductionBrowser({ repoRoot: "relative" }), /absolute/);
  const f = artifactFixture(t);
  await assert.rejects(captureProductionBrowser({ repoRoot: f.repoRoot, label: "baseline", commit: f.scan.commit }),
    /Production server exited|Cannot find module|ENOENT/);
});
