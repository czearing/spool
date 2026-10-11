import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { readArtifacts } from "../artifacts.mjs";
import { createInventory, createTodo } from "../report.mjs";
import { runScanner } from "../scanner.mjs";
import { artifactFixture, emitArtifacts, buildCall } from "./fixtures.js";

test("measures real client bytes and Brotli files, deduplicating URLs and respecting build exclusions", t => {
  const f = artifactFixture(t), { root } = emitArtifacts(f);
  const result = readArtifacts(f.repoRoot);
  assert.equal(result.assets.length, 3);
  assert.equal(result.excludedAssets.length, 1);
  for (const asset of result.assets) {
    assert.equal(asset.identityBytes, readFileSync(path.join(root, asset.name)).length);
    assert.equal(asset.brotliBytes, readFileSync(path.join(root, path.dirname(asset.name), `br.${path.basename(asset.name)}`)).length);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(result.groups[0].assets.length, 2, "duplicate URL counted once");
  assert.equal(result.totals.identityBytes, result.assets.reduce((sum, asset) => sum + asset.identityBytes, 0));
  assert.ok(result.groups.reduce((sum, group) => sum + group.identityBytes, 0) > result.totals.identityBytes,
    "Overlapping group sums are not the unique inventory");
});

test("missing Brotli is unknown, never zero or an assumed transfer size", t => {
  const f = artifactFixture(t), { root } = emitArtifacts(f);
  rmSync(path.join(root, "assets", "js", "br.index.abc.js"));
  const result = readArtifacts(f.repoRoot);
  assert.equal(result.totals.brotliBytes, null);
  assert.deepEqual(result.totals.missingBrotli, ["assets/js/index.abc.js"]);
});

for (const failure of ["size", "sidecar", "missing-group-asset", "traversal", "missing-root"]) {
  test(`rejects invalid artifact evidence: ${failure}`, t => {
    const f = artifactFixture(t), { root, analysis, stats } = emitArtifacts(f);
    if (failure === "size") stats.assets[0].size++;
    if (failure === "sidecar") writeFileSync(path.join(root, "assets", "js", "br.index.abc.js"), "invalid");
    if (failure === "missing-group-asset") stats.loopCustomStats.assetGroups[0].assets.push("missing.js");
    if (failure === "traversal") stats.assets[0].name = "../outside.js";
    if (failure === "missing-root") stats.loopCustomStats.assetGroups.shift();
    writeFileSync(path.join(analysis, "bundleStats.json"), JSON.stringify(stats));
    assert.throws(() => readArtifacts(f.repoRoot));
  });
}

test("first inventory has no fictional baseline, target, severity or savings", async t => {
  const f = artifactFixture(t);
  const result = await runScanner({ config: f.config, scan: f.scan, call: buildCall(f),
    get queue() { assert.fail("No queue access"); }, get prepare() { assert.fail("No task preparation"); } });
  assert.equal(result.dispatched, 0);
  const report = JSON.parse(readFileSync(path.join(f.config.runtimeDirectory, "inventory.json"), "utf8"));
  assert.equal(report.comparison, "first_inventory");
  assert.equal(report.baseline, null);
  for (const item of report.observations) {
    assert.equal(item.deltaBrotliBytes, null);
    assert.equal(item.target, undefined);
    assert.equal(item.severity, undefined);
    assert.equal(item.potentialSavings, null);
  }
  assert.match(readFileSync(f.config.todoPath, "utf8"), /No automatic handoff/);
  const todo = JSON.parse(readFileSync(f.config.todoJsonPath, "utf8"));
  assert.deepEqual(todo.todos, []);
  assert.equal(todo.status, "performance_validation_unavailable");
  assert.equal(report.todos, undefined);
  assert.doesNotMatch(readFileSync(path.join(f.config.runtimeDirectory, "inventory.md"), "utf8"), /\[ \]/);
  assert.deepEqual(f.calls, [{ tool: "bohemia_build", args: {
    repoRoot: f.repoRoot, packages: ["@fluidx/new-office"], productionArtifacts: true,
  } }]);
});

test("unchanged revisions reuse verified artifacts and keep the prior distinct baseline", async t => {
  const f = artifactFixture(t), call = buildCall(f);
  await runScanner({ config: f.config, scan: f.scan, call });
  await runScanner({ config: f.config, scan: f.scan, call });
  assert.equal(f.calls.length, 1);
  const oldCommit = f.scan.commit;
  writeFileSync(path.join(f.repoRoot, "source.txt"), "next source\n");
  f.git("add", "."); f.git("commit", "-qm", "next");
  f.scan.commit = f.git("rev-parse", "HEAD");
  const nextCall = buildCall(f, Array.from({ length: 1000 }, (_, i) => `export const value${i} = ${i};`).join("\n"));
  await runScanner({ config: f.config, scan: f.scan, call: nextCall });
  await runScanner({ config: f.config, scan: f.scan, call: nextCall });
  assert.equal(f.calls.length, 2);
  const report = JSON.parse(readFileSync(path.join(f.config.runtimeDirectory, "inventory.json"), "utf8"));
  assert.equal(report.baseline.commit, oldCommit);
  assert.equal(report.comparison, "previous_successful_revision");
  assert.equal(report.observations[0].kind, "artifact_increase");
  assert.ok(report.observations[0].deltaBrotliBytes > 0);
  assert.deepEqual(JSON.parse(readFileSync(f.config.todoJsonPath, "utf8")).todos, [],
    "Even a large, real byte increase is not proof of a runtime performance defect");
});

test("failed builds and modified cached artifacts preserve the last good report", async t => {
  const f = artifactFixture(t);
  await runScanner({ config: f.config, scan: f.scan, call: buildCall(f) });
  const saved = readFileSync(f.config.todoJsonPath, "utf8");
  const inventoryPath = path.join(f.config.runtimeDirectory, "inventory.json");
  const savedInventory = readFileSync(inventoryPath, "utf8");
  writeFileSync(path.join(f.app, "dist", "client", "assets", "js", "index.abc.js"), "changed");
  await assert.rejects(runScanner({ config: f.config, scan: f.scan, call: buildCall(f) }), /does not match/);
  assert.equal(readFileSync(f.config.todoJsonPath, "utf8"), saved);
  assert.equal(readFileSync(inventoryPath, "utf8"), savedInventory);
  writeFileSync(path.join(f.repoRoot, "source.txt"), "next\n");
  f.git("add", "."); f.git("commit", "-qm", "next");
  f.scan.commit = f.git("rev-parse", "HEAD");
  await assert.rejects(runScanner({ config: f.config, scan: f.scan, call: async () => { throw new Error("build failed"); } }), /build failed/);
  assert.equal(readFileSync(f.config.todoJsonPath, "utf8"), saved);
  assert.equal(readFileSync(inventoryPath, "utf8"), savedInventory);
});

test("legacy unvalidated todos are removed even if the next production build fails", async t => {
  const f = artifactFixture(t);
  const { publishTodoBoundary } = await import("../scanner.mjs");
  publishTodoBoundary(f.config);
  writeFileSync(f.config.todoJsonPath, JSON.stringify({ version: 2, todos: [{ title: "Defer a large asset" }] }));
  writeFileSync(f.config.todoPath, "# Old performance tasks\n- [ ] Defer a large asset\n");
  await assert.rejects(runScanner({
    config: f.config, scan: f.scan, call: async () => { throw new Error("build failed"); },
  }), /build failed/);
  assert.deepEqual(JSON.parse(readFileSync(f.config.todoJsonPath, "utf8")).todos, []);
  assert.doesNotMatch(readFileSync(f.config.todoPath, "utf8"), /Defer a large asset/);
});

test("artifact observations and self-asserted verification cannot populate performance todos", () => {
  const todo = createTodo({ validated: true, todos: [{ title: "Supposed performance issue" }] });
  assert.deepEqual(todo.todos, []);
  assert.equal(todo.automaticDispatch, false);
  assert.equal(todo.status, "performance_validation_unavailable");
});

test("incompatible environments are not reported as regressions", async t => {
  const f = artifactFixture(t);
  await runScanner({ config: f.config, scan: f.scan, call: buildCall(f) });
  const { current } = JSON.parse(readFileSync(path.join(f.config.runtimeDirectory, "artifact-history.json"), "utf8"));
  const previous = { ...current, build: { ...current.build, platform: "other" } };
  const report = createInventory(current, previous);
  assert.equal(report.comparison, "incompatible_baseline");
  assert.ok(report.observations.every(item => item.deltaBrotliBytes === null));
});

test("deduplication never hides distinct baseline changes for groups sharing current assets", async t => {
  const f = artifactFixture(t);
  await runScanner({ config: f.config, scan: f.scan, call: buildCall(f) });
  const { current } = JSON.parse(readFileSync(path.join(f.config.runtimeDirectory, "artifact-history.json"), "utf8"));
  const root = current.groups[0];
  const shared = { ...current, groups: [root, { ...root, name: "route:/alias" }] };
  const previous = { ...current, groups: [
    { ...root, brotliBytes: root.brotliBytes - 1 },
    { ...root, name: "route:/alias", brotliBytes: root.brotliBytes - 5 },
  ] };
  assert.deepEqual(createInventory(shared, previous).observations.map(todo => todo.deltaBrotliBytes), [5, 1]);
});

test("measurement CLI requires a receipt and reproduces verified artifact sizes", async t => {
  const f = artifactFixture(t);
  await runScanner({ config: f.config, scan: f.scan, call: buildCall(f) });
  const script = path.resolve(import.meta.dirname, "..", "measure.js");
  const run = args => spawnSync(process.execPath, [script, ...args], {
    cwd: f.repoRoot, encoding: "utf8", windowsHide: true,
  });
  assert.notEqual(run([]).status, 0);
  const result = run(["--receipt", path.join(f.config.runtimeDirectory, "artifact-build.json")]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).build.commit, f.scan.commit);
  assert.equal(JSON.parse(result.stdout).totals.brotliBytes, readArtifacts(f.repoRoot).totals.brotliBytes);
});

test("no maintenance routing or wrong-revision build result can produce a report", async t => {
  const f = artifactFixture(t);
  await assert.rejects(runScanner({ config: { ...f.config, defectOwnerAgentId: "manager" }, scan: f.scan }), /handoffs are disabled/);
  await assert.rejects(runScanner({ config: f.config, scan: f.scan,
    call: async () => ({ ready: true, ...f.scan, commit: "a".repeat(40), productionArtifacts: true }) }), /did not confirm/);
});
