import assert from "node:assert/strict";
import net from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runnerEndpoint } from "../../packages/bohemia-agent-tooling/src/index.js";
import { runnerStates } from "../health.mjs";
import { writeJson } from "../spool-store.mjs";
import { fixture } from "./fixtures.mjs";
import { trackPreparation } from "../preparation-progress.mjs";

test("health checks live instance identity, not just a fresh status file", async t => {
  const f = fixture(t), root = path.join(f.root, "runners"), directory = path.join(root, "pr-reviewer");
  mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, "run.mjs");
  writeFileSync(entry, "");
  const record = { pid: process.pid, instanceId: "fixture", phase: "ready",
    lastScan: new Date().toISOString(), pollSeconds: 60, lastError: null };
  writeJson(path.join(directory, ".runner", "pid.json"), record);
  writeJson(path.join(directory, ".runner", "status.json"), record);
  assert.equal((await runnerStates(["pr-reviewer"], root))[0].healthy, false);
  let instanceId = "fixture", stopping = false;
  const server = net.createServer(socket => {
    socket.on("data", () => socket.end(JSON.stringify({ pid: process.pid, instanceId, stopping })));
  });
  await new Promise(resolve => server.listen(runnerEndpoint(entry), resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal((await runnerStates(["pr-reviewer"], root))[0].healthy, true);
  assert.equal((await runnerStates(["pr-reviewer"], root))[0].connected, true);
  stopping = true;
  const draining = (await runnerStates(["pr-reviewer"], root))[0];
  assert.equal(draining.connected, true);
  assert.equal(draining.healthy, false);
  assert.match(draining.healthReason, /draining/);
  stopping = false;
  instanceId = "different-process-instance";
  assert.equal((await runnerStates(["pr-reviewer"], root))[0].healthy, false);
  assert.equal((await runnerStates(["pr-reviewer"], root))[0].connected, false);
});

test("health only includes selected runners and reports explicit scan failures", async t => {
  const f = fixture(t), root = path.join(f.root, "runners"), directory = path.join(root, "livesite");
  mkdirSync(directory, { recursive: true });
  writeJson(path.join(directory, ".runner", "status.json"), { lastError: "Dependency install failed", phase: "degraded" });
  const rows = await runnerStates(["livesite"], root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runner, "livesite");
  assert.equal(rows[0].healthy, false);
  assert.equal(rows[0].lastError, "Dependency install failed");
});

test("real preparation progress keeps a responsive long scan live without inventing a completed pass", async t => {
  const f = fixture(t), root = path.join(f.root, "runners"), directory = path.join(root, "pr-updater");
  mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, "run.mjs");
  writeFileSync(entry, "");
  const oldScan = "2020-01-01T00:00:00Z";
  const record = { pid: process.pid, instanceId: "progress", phase: "scanning", lastScan: oldScan,
    pollSeconds: 60, preparation: { progressAt: new Date().toISOString(), message: "Checks running" } };
  writeJson(path.join(directory, ".runner", "pid.json"), record);
  writeJson(path.join(directory, ".runner", "status.json"), record);
  assert.equal((await runnerStates(["pr-updater"], root))[0].healthy, false);
  const server = net.createServer(socket => socket.on("data", () => socket.end(
    JSON.stringify({ pid: process.pid, instanceId: "progress", stopping: false }))));
  await new Promise(resolve => server.listen(runnerEndpoint(entry), resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const active = (await runnerStates(["pr-updater"], root))[0];
  assert.equal(active.healthy, true);
  assert.equal(active.lastScan, oldScan);
  record.preparation.progressAt = oldScan;
  writeJson(path.join(directory, ".runner", "status.json"), record);
  assert.equal((await runnerStates(["pr-updater"], root))[0].healthy, false);
  record.preparation.progressAt = new Date().toISOString();
  record.lastError = "Install failed";
  writeJson(path.join(directory, ".runner", "status.json"), record);
  assert.equal((await runnerStates(["pr-updater"], root))[0].healthy, false);
  assert.equal((await runnerStates(["pr-updater"], root))[0].connected, true);
});

test("preparation progress forwards only actual MCP notices and clears on failure", async () => {
  const updates = [], lifecycle = { status: { pullRequests: [{ id: 7, branch: "topic" }] },
    observe: update => updates.push(update) };
  const call = trackPreparation(async (_name, _args, options) => {
    assert.equal(updates[0].preparation.progressAt, null);
    options.onProgress({ message: "Actual MCP heartbeat" });
    throw new Error("Gate failed");
  }, () => lifecycle);
  await assert.rejects(call("bohemia_prepare", { repoRoot: "fixture", branch: "topic" }), /Gate failed/);
  assert.equal(updates[1].preparation.prId, 7);
  assert.equal(updates[1].preparation.message, "Actual MCP heartbeat");
  assert.ok(updates[1].preparation.progressAt);
  assert.deepEqual(updates[2], { preparation: null });
});

test("unscoped build progress never borrows the first PR's identity", async () => {
  const updates = [], lifecycle = { status: { pullRequests: [{ id: 1 }, { id: 2 }] },
    observe: update => updates.push(update) };
  const call = trackPreparation(async (_name, _args, options) => {
    options.onProgress({ message: "Building" });
    return { ready: true };
  }, () => lifecycle);
  await call("bohemia_build", { repoRoot: "fixture" });
  assert.equal(updates[0].preparation.prId, undefined);
  assert.equal(updates[1].preparation.prId, undefined);
  assert.deepEqual(updates[2], { preparation: null });
});
