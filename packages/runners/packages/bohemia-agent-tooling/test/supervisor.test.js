import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertRunnerEntry,
  clearPidRecord,
  discoverRunners,
  isProcessAlive,
  readAllRunnerStates,
  readRunnerState,
  runtimePaths,
  writePidRecord,
} from "../src/supervisor.js";

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "supervisor-"));
}

function makeRunner(root, name, { entry = "run.mjs", withEntry = true } = {}) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "runner.json"), JSON.stringify({ name, entry }));
  if (withEntry) writeFileSync(join(directory, entry), "// runner\n");
  return directory;
}

test("discovers every manifest under the root and ignores dependency trees", () => {
  const root = makeRoot();
  makeRunner(root, "alpha");
  makeRunner(root, "beta");
  const buried = join(root, "gamma", "node_modules", "package");
  mkdirSync(buried, { recursive: true });
  writeFileSync(join(buried, "runner.json"), JSON.stringify({ name: "buried", entry: "run.mjs" }));

  const runners = discoverRunners(root);
  assert.deepEqual(runners.map((runner) => runner.name), ["alpha", "beta"]);
});

test("a manifest missing a name or an entry is not a runner", () => {
  const root = makeRoot();
  const directory = join(root, "broken");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "runner.json"), JSON.stringify({ name: "broken" }));
  assert.deepEqual(discoverRunners(root), []);
});

test("a manifest pointing at a missing entry fails loudly", () => {
  const root = makeRoot();
  makeRunner(root, "ghost", { withEntry: false });
  const [runner] = discoverRunners(root);
  assert.throws(() => assertRunnerEntry(runner), /missing entry/);
});

test("a runner with no pid record reads as not running", () => {
  const root = makeRoot();
  makeRunner(root, "idle");
  const [state] = readAllRunnerStates(root);
  assert.equal(state.running, false);
  assert.equal(state.pid, null);
  assert.equal(state.stale, false);
});

test("a live pid with a fresh scan reads as running and not stale", () => {
  const root = makeRoot();
  makeRunner(root, "live");
  const [runner] = discoverRunners(root);
  const { pidFile, statusFile } = runtimePaths(runner);
  writePidRecord(pidFile, { pid: 4242, startedAt: "2026-09-01T00:00:00.000Z", entry: runner.entry });
  mkdirSync(join(runner.directory, ".runner"), { recursive: true });
  writeFileSync(statusFile, JSON.stringify({
    pid: 4242,
    lastScan: "2026-09-01T00:00:30.000Z",
    pollSeconds: 20,
    nextScan: "2026-09-01T00:00:50.000Z",
    lastError: null,
  }));

  const state = readRunnerState(runner, {
    now: new Date("2026-09-01T00:00:40.000Z"),
    isAlive: () => true,
  });
  assert.equal(state.running, true);
  assert.equal(state.stale, false);
  assert.equal(state.pid, 4242);
  assert.equal(state.ageSeconds, 10);
});

test("a live pid that stopped scanning reads as running and stale", () => {
  const root = makeRoot();
  makeRunner(root, "wedged");
  const [runner] = discoverRunners(root);
  const { pidFile, statusFile } = runtimePaths(runner);
  writePidRecord(pidFile, { pid: 99, entry: runner.entry });
  writeFileSync(statusFile, JSON.stringify({ pid: 99, lastScan: "2026-09-01T00:00:00.000Z", pollSeconds: 20 }));

  const state = readRunnerState(runner, {
    now: new Date("2026-09-01T01:00:00.000Z"),
    isAlive: () => true,
  });
  assert.equal(state.running, true);
  assert.equal(state.stale, true);
});

test("a recorded pid whose process is gone reads as not running", () => {
  const root = makeRoot();
  makeRunner(root, "dead");
  const [runner] = discoverRunners(root);
  const { pidFile } = runtimePaths(runner);
  writePidRecord(pidFile, { pid: 1234, entry: runner.entry });

  const state = readRunnerState(runner, { isAlive: () => false });
  assert.equal(state.running, false);

  clearPidRecord(pidFile);
  assert.equal(readRunnerState(runner, { isAlive: () => false }).pid, null);
});

test("liveness reads an owned process, a foreign process and an impossible id", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  const permissionDenied = () => {
    const error = new Error("denied");
    error.code = "EPERM";
    throw error;
  };
  assert.equal(isProcessAlive(7, permissionDenied), true);
});
