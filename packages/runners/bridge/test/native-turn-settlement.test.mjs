import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finishedTurnObservation, settleCompletedNativeTurn } from "../native-turn-settlement.mjs";
import { CodespaceTransport } from "../../packages/repository-mcp/src/codespaces/transport.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-settlement-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileFile = path.join(root, "profile.json");
  const profile = { version: 1, purpose: "engineering", codespace: "assigned", githubAccount: "assigned",
    connector: process.execPath, nodeExecutable: process.execPath, workspace: root, azureCliDirectory: root,
    remoteRoot: "/workspaces/1JS", remoteTools: "/workspaces/.assigned-tools", minimumFreeGiB: 12,
    nativeProfile: { repoRoot: "/workspaces/1JS", toolchainRoot: "/workspaces/1JS",
      storageRoot: "/workspaces", baseBranch: "main", nodeExecutable: "/usr/bin/node" } };
  fs.writeFileSync(profileFile, JSON.stringify(profile));
  const provider = { command: "node", args: [path.join(root, "codespaces", "copilot.mjs"), "--config", profileFile],
    workingDirectory: "/workspaces/1JS" };
  fs.writeFileSync(path.join(root, "spool.json"), JSON.stringify({ copilotProviders: { perf: provider } }));
  const task = { id: "original", agent: "perf", workspace: root, status: "completed", error: null,
    session_id: "11111111-2222-3333-4444-555555555555", updated_at: "2026-10-24T21:00:00Z",
    provider: { pid: process.pid, token: "owned-provider" }, session_config: { provider },
    interaction: { phase: "running", messages: [{ status: "delivered" }] } };
  const records = path.join(root, ".runner-receipts");
  fs.mkdirSync(path.join(records, "native-creators"), { recursive: true });
  const publication = { verified: true, originKind: "spool", taskId: task.id,
    sessionId: task.session_id, workspace: root, agent: task.agent };
  const receipt = path.join(records, "native-creators", `${task.id}.json`);
  fs.writeFileSync(receipt, JSON.stringify(publication));
  const store = { root, records, metadata: () => ({ runner: "library-perf", source: "perf" }),
    isPaused: () => false, task: () => task };
  const calls = [], requests = [];
  const options = { store, config: { repositoryProfile: "1js", agentId: "perf" }, task, workspace: root,
    controls: { submit: input => requests.push(input) },
    observe: async (value, sessionId) => { calls.push({ value, sessionId }); return { idle: true, sessionId }; } };
  return { options, task, store, calls, requests, receipt, publication };
}

test("completed native turns receive one graceful status control without rewriting task state", async t => {
  const f = fixture(t), before = JSON.stringify(f.task);
  assert.match((await settleCompletedNativeTurn(f.options)).holding, /release its workspace/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].sessionId, f.task.session_id);
  assert.equal(f.requests[0].kind, "status");
  assert.equal(f.requests[0].status, "completed");
  assert.equal(f.requests[0].expectedStatus, "completed");
  assert.equal(JSON.stringify(f.task), before);
  await settleCompletedNativeTurn(f.options);
  assert.equal(f.calls.length, 1);
});

test("active, paused, contract-bearing, unowned and uncertain tasks never receive workflow changes", async t => {
  for (const change of [
    f => { f.task.status = "in_progress"; },
    f => { f.task.acceptance = { kind: "bundle-v2" }; },
    f => { f.task.interaction.phase = "stopping"; },
    f => { f.task.interaction.paused = true; },
    f => { f.options.config.repositoryProfile = "bohemia"; },
    f => { f.store.isPaused = () => true; },
    f => { f.task.interaction.messages[0].status = "queued"; },
    f => { f.task.interaction.messages[0].status = "delivery_uncertain"; },
    f => { f.store.metadata = () => ({ runner: "manual-dashboard" }); },
    f => { fs.unlinkSync(f.receipt); },
  ]) {
    const f = fixture(t); change(f);
    assert.equal(await settleCompletedNativeTurn(f.options), null);
    assert.deepEqual(f.calls, []);
  }
});

test("changed provider, publication or task state fails closed", async t => {
  const provider = fixture(t);
  provider.task.session_config.provider = { command: "another" };
  await assert.rejects(settleCompletedNativeTurn(provider.options), /ownership changed/);
  assert.deepEqual(provider.calls, []);
  const publication = fixture(t);
  fs.writeFileSync(publication.receipt, JSON.stringify({ ...publication.publication, sessionId: "different" }));
  assert.equal(await settleCompletedNativeTurn(publication.options), null);
  assert.deepEqual(publication.calls, []);
  const changed = fixture(t);
  changed.store.task = () => ({ ...changed.task, updated_at: "changed" });
  await settleCompletedNativeTurn(changed.options);
  assert.deepEqual(changed.calls, []);
});

test("busy native turns are retried without requesting any workflow change", async t => {
  const f = fixture(t);
  let count = 0;
  f.options.observe = async () => { count++; return { idle: false, holding: "Still busy" }; };
  assert.equal((await settleCompletedNativeTurn(f.options)).holding, "Still busy");
  await settleCompletedNativeTurn(f.options);
  assert.equal(count, 2);
  assert.deepEqual(f.requests, []);
});

test("default native observation always releases its SSH connection, including failed observations", async t => {
  const f = fixture(t);
  delete f.options.observe;
  let disposed = 0, failed = false;
  t.mock.method(CodespaceTransport.prototype, "environment", async () => {});
  t.mock.method(CodespaceTransport.prototype, "ssh", async () => {
    if (failed) throw new Error("Connection failed");
    return { stdout: '{"idle":false,"holding":"Still busy"}' };
  });
  t.mock.method(CodespaceTransport.prototype, "dispose", async () => { disposed++; });
  await settleCompletedNativeTurn(f.options);
  assert.equal(disposed, 1);
  failed = true;
  await assert.rejects(settleCompletedNativeTurn(f.options), /Connection failed/);
  assert.equal(disposed, 2);
  assert.deepEqual(f.requests, []);
});

test("remote observation verifies the held session without writing ACP input or sending signals", () => {
  const program = finishedTurnObservation({ remoteRoot: "/workspaces/1JS", remoteTools: "/workspaces/.tools" },
    "11111111-2222-3333-4444-555555555555");
  assert.match(program, /inuse\./);
  assert.match(program, /LOCK_EX\|fcntl.LOCK_NB/);
  assert.match(program, /time\.time\(\)-latest<30/);
  assert.match(program, /'idle':True/);
  assert.doesNotMatch(program, /session\/prompt|session\/cancel|os\.write|os\.kill|SIGTERM|SIGKILL/);
  assert.throws(() => finishedTurnObservation({}, "invalid"), /Invalid native session/);
});
