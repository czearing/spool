import assert from "node:assert/strict";
import net from "node:net";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runnerEndpoint } from "../../packages/bohemia-agent-tooling/src/index.js";
import { runnerSnapshot } from "../runner-snapshot.mjs";
import { writeJson } from "../spool-store.mjs";
import { fixture } from "./fixtures.mjs";

test("snapshot separates verified connection, failed attempts and disabled runners without leaking status data", async t => {
  const f = fixture(t), root = path.join(f.root, "runners"), directory = path.join(root, "livesite");
  mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, "run.mjs"); writeFileSync(entry, "");
  const lastRun = new Date().toISOString(), lastSuccess = "2026-01-01T00:00:00Z";
  const record = { pid: process.pid, instanceId: "snapshot", phase: "degraded", lastAttempt: lastRun,
    lastScan: lastSuccess, lastError: "PRIVATE_COMMAND", pollSeconds: 60, privateToken: "PRIVATE_TOKEN" };
  writeJson(path.join(directory, ".runner", "pid.json"), record);
  writeJson(path.join(directory, ".runner", "status.json"), record);
  const server = net.createServer(socket => socket.on("data", () => socket.end(JSON.stringify({
    pid: process.pid, instanceId: "snapshot", stopping: false,
  }))));
  await new Promise(resolve => server.listen(runnerEndpoint(entry), resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = { spool_dir: f.root, livesite: { enabled: true }, pr_updater: { enabled: false },
    docs: { enabled: true }, slop: { enabled: true }, perf: { enabled: true }, pr_updater_2: { enabled: true } };
  const snapshot = await runnerSnapshot(config, f.root, root);
  assert.equal(snapshot.configured, true);
  assert.deepEqual(snapshot.runners.map(row => row.id).sort(), ["livesite", "pr-updater"]);
  const livesite = snapshot.runners.find(row => row.id === "livesite");
  assert.equal(livesite.connected, true);
  assert.equal(livesite.running, true);
  assert.equal(livesite.healthy, false);
  assert.equal(livesite.lastRunFailed, true);
  assert.equal(livesite.lastRunAt, lastRun);
  assert.equal(livesite.lastSuccessAt, lastSuccess);
  assert.equal(snapshot.runners.find(row => row.id === "pr-updater").enabled, false);
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE"), false);
  const other = path.join(f.root, "other"); mkdirSync(other);
  assert.deepEqual((await runnerSnapshot(config, other, root)).runners, []);
  writeJson(path.join(directory, ".runner", "status.json"), { ...record, instanceId: "stale-instance" });
  assert.equal((await runnerSnapshot(config, f.root, root)).runners.find(row => row.id === "livesite").connected, false);
});

test("a native canonical config path and a Windows short project path identify the same project", async t => {
  const f = fixture(t), canonical = realpathSync.native(f.root);
  const snapshot = await runnerSnapshot({ spool_dir: canonical, livesite: { enabled: false } }, f.root,
    path.join(f.root, "runners"));
  assert.equal(snapshot.configured, true);
  assert.deepEqual(snapshot.runners.map(row => row.id), ["livesite"]);
});
