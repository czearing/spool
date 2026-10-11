import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { migrateRunnerInstallation } from "../migration.mjs";

test("migrates configuration and journals once, preserving old evidence paths without copying state", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "spool-runner-migration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "legacy"), project = path.join(root, "project"), config = path.join(home, "spool-runners.json");
  mkdirSync(project); mkdirSync(path.join(home, "runners", "pr-reviewer", ".runner"), { recursive: true });
  const state = path.join(home, "runners", "pr-reviewer", ".runner", "state.json");
  writeFileSync(state, '{"previousEvent":"must-not-replay"}');
  const original = JSON.stringify({ spool_dir: project, pr_reviewer: { enabled: true }, ado: { project: "preserve" } });
  writeFileSync(config, original);
  await migrateRunnerInstallation(home, config, [{ root: project }]);
  const runtime = path.join(project, ".runner", "automation");
  assert.equal(readFileSync(path.join(runtime, "spool-runners.json"), "utf8"), original);
  assert.equal(realpathSync(path.join(home, "runners")), realpathSync(path.join(runtime, "runners")));
  assert.equal(readFileSync(state, "utf8"), '{"previousEvent":"must-not-replay"}');
  await migrateRunnerInstallation(home, config, [{ root: project }]);
  assert.equal(readFileSync(config, "utf8"), original);
});
