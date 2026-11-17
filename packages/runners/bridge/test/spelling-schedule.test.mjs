import assert from "node:assert/strict";
import { mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createSpellingScan } from "../spelling.mjs";
import { readJson, writeJson } from "../spool-store.mjs";
import { scannerVersion } from "../../scanners/spelling/check.mjs";
import { publicationVersion } from "../../scanners/spelling/publish.mjs";
import { fixture } from "./fixtures.mjs";

const start = "2026-10-12T23:25:49.772Z";
const due = "2026-10-19T23:25:49.772Z";

function scheduled(t) {
  const f = fixture(t), runtime = path.join(f.root, "reports");
  mkdirSync(runtime);
  const files = Object.fromEntries(["markdown", "html", "json"].map(type =>
    [type, path.join(runtime, `report.${type}`)]));
  const report = { scannerVersion, commit: "a".repeat(40), filesWithIssues: 1, issues: 1 };
  for (const file of Object.values(files)) writeJson(file, report);
  const stateFile = path.join(runtime, "state.json");
  const state = { version: 3, scannerVersion, publicationVersion, lastReportedAt: start,
    publicationPending: false, ...files };
  let clock = new Date(start), preparations = 0, scans = 0, publications = 0;
  const options = { store: f.store, workspace: f.workspace, runtime,
    config: { pollSeconds: 604800, publishAgent: "spelling" }, now: () => clock, support() {},
    call: async () => { preparations++; return { ...f.preparation, branch: "master" }; },
    check: async () => { scans++; return report; },
    report: () => { for (const file of Object.values(files)) writeJson(file, report); return files; },
    publish: async () => { publications++; return { created: 1 }; } };
  writeJson(stateFile, state);
  return { state, files, stateFile, options, save: () => writeJson(stateFile, state),
    advance: value => { clock = new Date(value); },
    scan: () => createSpellingScan(options)(),
    counts: () => [preparations, scans, publications] };
}

for (const change of ["scanner", "publisher", "legacy pending", "missing JSON", "missing HTML"]) {
  test(`weekly deadline survives restart with ${change}`, async t => {
    const f = scheduled(t);
    if (change === "scanner") f.state.scannerVersion--;
    if (change === "publisher") f.state.publicationVersion--;
    if (change === "legacy pending") {
      f.state.publicationPending = true;
      delete f.state.publicationVersion;
    }
    if (change.startsWith("missing")) unlinkSync(f.files[change.endsWith("JSON") ? "json" : "html"]);
    f.save();
    const persisted = readJson(f.stateFile);
    for (const at of [start, "2026-10-13T18:03:22.009Z", "2026-10-19T23:25:49.771Z"]) {
      f.advance(at);
      const result = await f.scan();
      assert.equal(result.nextScan, due);
      assert.match(result.holding, /next scheduled scan/);
      assert.deepEqual(f.counts(), [0, 0, 0]);
      assert.deepEqual(readJson(f.stateFile), persisted);
    }
    f.advance(due);
    await f.scan();
    assert.deepEqual(f.counts(), [1, 1, 1]);
  });
}

test("weekly pending publication cannot resume under a changed scanner or publisher policy", async t => {
  for (const key of ["scannerVersion", "publicationVersion"]) {
    const f = scheduled(t);
    f.state.publicationPending = true;
    f.state[key]--;
    f.save();
    assert.equal((await f.scan()).nextScan, due);
    assert.deepEqual(f.counts(), [0, 0, 0]);
    assert.equal(readJson(f.stateFile).publicationPending, true);
  }
});

test("weekly pending publication with a missing report waits instead of rescanning", async t => {
  const f = scheduled(t);
  f.state.publicationPending = true;
  f.save();
  unlinkSync(f.files.json);
  assert.match((await f.scan()).holding, /missing/);
  assert.deepEqual(f.counts(), [0, 0, 0]);
});

test("weekly compatible publication retries the saved run without advancing its scan deadline", async t => {
  const f = scheduled(t);
  f.state.publicationPending = true;
  f.save();
  assert.equal((await f.scan()).nextScan, due);
  assert.equal(readJson(f.stateFile).lastReportedAt, start);
  assert.equal(readJson(f.stateFile).publicationPending, false);
  await f.scan();
  assert.deepEqual(f.counts(), [0, 0, 1]);
});

test("weekly scan persists publication policy before an interrupted publication", async t => {
  const f = scheduled(t);
  f.advance(due);
  f.options.publish = async () => { throw new Error("publication interrupted"); };
  await assert.rejects(f.scan(), /publication interrupted/);
  assert.equal(readJson(f.stateFile).publicationVersion, publicationVersion);
  assert.equal(readJson(f.stateFile).publicationPending, true);
});

test("busy publication preserves the fresh report and retries it without rescanning or losing its deadline", async t => {
  const f = scheduled(t);
  f.advance(due);
  let attempts = 0;
  f.options.publish = async () => {
    attempts++;
    throw new Error('Step "Repository" failed (execution error): Workspace/agent is owned by Spool task original; preparation held');
  };
  const fresh = await f.scan();
  assert.equal(fresh.publicationPending, true);
  assert.match(fresh.holding, /owned by Spool task original/);
  assert.equal(readJson(f.stateFile).lastReportedAt, due);
  assert.equal(readJson(f.stateFile).publicationPending, true);
  const retry = await f.scan();
  assert.equal(retry.publicationPending, true);
  assert.equal(retry.nextScan, fresh.nextScan);
  assert.equal(attempts, 2);
  assert.deepEqual(f.counts(), [1, 1, 0]);
  f.options.publish = async () => { attempts++; return { created: 1 }; };
  assert.equal((await f.scan()).created, 1);
  assert.equal(readJson(f.stateFile).publicationPending, false);
  assert.equal(readJson(f.stateFile).lastReportedAt, due);
  assert.equal(attempts, 3);
  assert.deepEqual(f.counts(), [1, 1, 0]);
});

test("publication ownership is checked before invoking the publisher", async t => {
  const f = scheduled(t);
  f.advance(due);
  f.options.config.publicationRoot = f.options.workspace;
  f.options.store.assertIdle = () => { throw new Error("Spool agent spelling is paused by operator"); };
  assert.match((await f.scan()).holding, /paused by operator/);
  assert.deepEqual(f.counts(), [1, 1, 0]);
  assert.equal(readJson(f.stateFile).publicationPending, true);
  f.options.store.assertIdle = () => {};
  await f.scan();
  assert.deepEqual(f.counts(), [1, 1, 1]);
  assert.equal(readJson(f.stateFile).publicationPending, false);
});

test("publication defers known admission contention but never masks unverified work or execution failures", async t => {
  const f = scheduled(t);
  f.state.publicationPending = true;
  f.save();
  for (const message of [
    "Workspace/agent is reserved for original; preparation held",
    "Spelling publication held: Another runner is scanning or preparing this agent/workspace",
  ]) {
    f.options.publish = async () => { throw new Error(message); };
    assert.equal((await f.scan()).publicationPending, true);
  }
  for (const message of ["Existing spelling PR has unverified newer work; update held", "Gate failed"]) {
    f.options.publish = async () => { throw new Error(message); };
    await assert.rejects(f.scan(), error => error.message === message);
  }
  assert.equal(readJson(f.stateFile).publicationPending, true);
  assert.equal(readJson(f.stateFile).lastReportedAt, start);
});

test("weekly schedule rejects corrupt timestamps rather than publishing another batch", async t => {
  const f = scheduled(t);
  f.state.lastReportedAt = "not-a-date";
  f.save();
  await assert.rejects(f.scan(), /Invalid Spelling report schedule/);
  assert.deepEqual(f.counts(), [0, 0, 0]);
});
