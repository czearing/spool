import assert from "node:assert/strict";
import net from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { runnerEndpoint } from "../../packages/bohemia-agent-tooling/src/index.js";
import { runnerStates } from "../health.mjs";
import { writeJson } from "../spool-store.mjs";
import { fixture } from "./fixtures.mjs";
import { trackPreparation } from "../preparation-progress.mjs";
import { callBohemia } from "../../packages/bohemia-pr-mcp/src/client.mjs";

for (const operation of ["health", "stop"]) {
  test(`a timed-out Windows ${operation} request releases its client process`, {
    skip: process.platform !== "win32",
  }, async t => {
    const f = fixture(t), root = path.join(f.root, "runners"), directory = path.join(root, "ci");
    mkdirSync(directory, { recursive: true });
    const entry = path.join(directory, "run.mjs");
    writeFileSync(entry, "");
    const record = { pid: process.pid, instanceId: "unresponsive", phase: "ready",
      lastScan: new Date().toISOString(), pollSeconds: 60 };
    writeJson(path.join(directory, ".runner", "pid.json"), record);
    writeJson(path.join(directory, ".runner", "status.json"), record);
    const sockets = new Set();
    const server = net.createServer({ pauseOnConnect: true }, socket => sockets.add(socket));
    await new Promise(resolve => server.listen(runnerEndpoint(entry), resolve));
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      return new Promise(resolve => server.close(resolve));
    });
    const script = operation === "health"
      ? `import {runnerStates} from ${JSON.stringify(new URL("../health.mjs", import.meta.url).href)};
         console.log(JSON.stringify((await runnerStates(["ci"], ${JSON.stringify(root)}))[0].connected));`
      : `import {requestRunnerStop} from ${JSON.stringify(new URL(
        "../../packages/bohemia-agent-tooling/src/runner-runtime.js", import.meta.url).href)};
         try { await requestRunnerStop(${JSON.stringify(entry)}, ${process.pid}); }
         catch(error) { console.log(error.message); }`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script],
      { timeout: 12_000, windowsHide: true });
    assert.equal(sockets.size, 1);
    if (operation === "health") assert.equal(stdout.trim(), "false");
    else assert.match(stdout, /timed out/);
  });
}

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

test("live file progress is healthy without fabricating a completed scan and expires when stalled", async t => {
  const f = fixture(t), root = path.join(f.root, "runners"), directory = path.join(root, "spelling");
  mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, "run.mjs");
  writeFileSync(entry, "");
  const oldScan = "2020-01-01T00:00:00Z";
  const record = { pid: process.pid, instanceId: "file-progress", phase: "scanning", lastScan: oldScan,
    pollSeconds: 60, scanProgress: { filesScanned: 5, currentFile: "docs/guide.md", progressAt: new Date().toISOString() } };
  writeJson(path.join(directory, ".runner", "pid.json"), record);
  const server = net.createServer(socket => socket.on("data", () => socket.end(
    JSON.stringify({ pid: process.pid, instanceId: "file-progress", stopping: false }))));
  await new Promise(resolve => server.listen(runnerEndpoint(entry), resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  writeJson(path.join(directory, ".runner", "status.json"), record);
  const active = (await runnerStates(["spelling"], root))[0];
  assert.equal(active.healthy, true);
  assert.equal(active.lastScan, oldScan);
  assert.match(active.healthReason, /File scan active/);
  for (const progressAt of [oldScan, new Date(Date.now() + 60_000).toISOString(), undefined]) {
    record.scanProgress.progressAt = progressAt;
    writeJson(path.join(directory, ".runner", "status.json"), record);
    assert.equal((await runnerStates(["spelling"], root))[0].healthy, false);
  }
});

test("preparation progress forwards only actual MCP notices and clears on failure", async () => {
  const updates = [], lifecycle = { status: { pullRequests: [{ id: 7, branch: "topic" }] },
    observe: update => updates.push(update) };
  const call = trackPreparation(async (_name, _args, options) => {
    assert.equal(updates[0].preparation.progressAt, null);
    options.onProgress({ message: "Actual MCP heartbeat", pid: 123 });
    throw new Error("Gate failed");
  }, () => lifecycle);
  await assert.rejects(call("bohemia_prepare", { repoRoot: "fixture", branch: "topic" }), /Gate failed/);
  assert.equal(updates[1].preparation.prId, 7);
  assert.equal(updates[1].preparation.message, "Actual MCP heartbeat");
  assert.equal(updates[1].preparation.pid, 123);
  assert.ok(updates[1].preparation.progressAt);
  assert.deepEqual(updates[2], { preparation: null });
});

test("publication health requires real recent file progress and a responsive control identity", async t => {
  const f = fixture(t), root = path.join(f.root, "runners"), directory = path.join(root, "spelling");
  mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, "run.mjs");
  writeFileSync(entry, "");
  const oldScan = "2020-01-01T00:00:00Z";
  const record = { pid: process.pid, instanceId: "publication-progress", phase: "scanning", lastScan: oldScan,
    pollSeconds: 60, publicationProgress: { stage: "planning", filesProcessed: 5,
      currentFile: "packages/a/readme.md", progressAt: new Date().toISOString() } };
  writeJson(path.join(directory, ".runner", "pid.json"), record);
  writeJson(path.join(directory, ".runner", "status.json"), record);
  assert.equal((await runnerStates(["spelling"], root))[0].healthy, false);
  const server = net.createServer(socket => socket.on("data", () => socket.end(
    JSON.stringify({ pid: process.pid, instanceId: "publication-progress", stopping: false }))));
  await new Promise(resolve => server.listen(runnerEndpoint(entry), resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const active = (await runnerStates(["spelling"], root))[0];
  assert.equal(active.healthy, true);
  assert.equal(active.lastScan, oldScan);
  assert.match(active.healthReason, /Publication planning active/);
  for (const update of [
    { progressAt: oldScan }, { progressAt: new Date(Date.now() + 60_000).toISOString() },
    { progressAt: undefined }, { stage: "unknown" }, { filesProcessed: -1 }, { currentFile: "" },
  ]) {
    writeJson(path.join(directory, ".runner", "status.json"),
      { ...record, publicationProgress: { ...record.publicationProgress, ...update } });
    assert.equal((await runnerStates(["spelling"], root))[0].healthy, false);
  }
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

test("repository calls report the actual subprocess identity without changing their result", async t => {
  const f = fixture(t), notices = [];
  const expected = { ok: true, ready: true, repoRoot: f.workspace, commit: "a".repeat(40) };
  const script = `
    const result = ${JSON.stringify(expected)};
    let input = "", rpc = false;
    process.stdin.on("data", chunk => {
      input += chunk;
      while (input.includes("\\n")) {
        const index = input.indexOf("\\n"), message = JSON.parse(input.slice(0, index));
        input = input.slice(index + 1);
        rpc = true;
        if (message.id) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
          result: message.id === 1 ? {} : { structuredContent: result } }) + "\\n");
      }
    });
    process.stdin.on("end", () => { if (!rpc) process.stdout.write(JSON.stringify({ result })); });
  `;
  let child;
  const result = await callBohemia("bohemia_prepare", { repoRoot: f.workspace, operation: "setup" }, {
    spawn: () => (child = spawn(process.execPath, ["-e", script],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })),
    onProgress: notice => notices.push(notice),
  });
  assert.deepEqual(result, expected);
  assert.ok(notices.some(notice => notice.pid === child.pid));
});

test("quiet canonical work is healthy only with a real live subprocess inside its deadline", async t => {
  const f = fixture(t), root = path.join(f.root, "runners"), directory = path.join(root, "spelling");
  mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, "run.mjs");
  writeFileSync(entry, "");
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"],
    { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => { child.stdin.end(); await closed; });
  const oldScan = "2020-01-01T00:00:00Z";
  const record = { pid: process.pid, instanceId: "quiet-process", phase: "scanning",
    lastScan: oldScan, pollSeconds: 60, preparation: { operation: "bohemia_check", pid: child.pid,
      startedAt: new Date().toISOString(), progressAt: oldScan } };
  writeJson(path.join(directory, ".runner", "pid.json"), record);
  const server = net.createServer(socket => socket.on("data", () => socket.end(
    JSON.stringify({ pid: process.pid, instanceId: "quiet-process", stopping: false }))));
  await new Promise(resolve => server.listen(runnerEndpoint(entry), resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  writeJson(path.join(directory, ".runner", "status.json"), record);
  const active = (await runnerStates(["spelling"], root))[0];
  assert.equal(active.healthy, true);
  assert.equal(active.lastScan, oldScan);
  assert.equal(active.preparation.progressAt, oldScan);
  for (const update of [
    { pid: undefined }, { pid: process.pid }, { startedAt: oldScan },
    { startedAt: new Date(Date.now() + 60_000).toISOString() }, { operation: "unknown" },
  ]) {
    writeJson(path.join(directory, ".runner", "status.json"),
      { ...record, preparation: { ...record.preparation, ...update } });
    assert.equal((await runnerStates(["spelling"], root))[0].healthy, false);
  }
  child.stdin.end();
  await closed;
  writeJson(path.join(directory, ".runner", "status.json"), record);
  assert.equal((await runnerStates(["spelling"], root))[0].healthy, false);
});
