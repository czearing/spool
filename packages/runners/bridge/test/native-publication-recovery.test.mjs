import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recoverNativePublication } from "../native-publication-recovery.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-publication-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = "software-engineer-2";
  fs.mkdirSync(path.join(root, "agents"));
  fs.writeFileSync(path.join(root, "agents", `${agent}.md`), "Use normal MCP and preserve all checks.");
  const provider = { command: "node", workingDirectory: "/workspaces/1JS",
    args: [path.join(root, "codespaces", "copilot.mjs"), "--config", path.join(root, "profile.json")] };
  fs.writeFileSync(path.join(root, "spool.json"), JSON.stringify({ copilotProviders: { [agent]: provider } }));
  const metadata = { source: "backlog", runner: "library-backlog",
    handoff: { workItem: { id: 2, parent: 1, project: "OC" } } };
  const task = { id: "original", agent, workspace: root, status: "failed", error: "Publication environment failure",
    session_id: "original-session", updated_at: "2026-10-24T22:00:00Z", session_config: { provider } };
  const prepared = { ready: true, repoRoot: root, branch: "user/owner/original", commit: "a".repeat(40),
    updatedAt: "2026-10-24T22:01:00Z", configSha256: "original-config" };
  const report = { version: 1, taskId: task.id, workItemId: 2, outcome: "partial", scope: "environment",
    sourceCommit: prepared.commit, reason: "Normal push failed before PR creation", evidence: ["owned-job-log"] };
  const calls = [];
  const store = { root, records: path.join(root, "records"), metadata: () => metadata,
    workspaceIdentity: () => root, isPaused: () => false, submission: () => null, assertIdle() {} };
  const options = { store, task, workspace: root, entry: { itemId: 2 },
    config: { repositoryProfile: "1js", agentId: agent, parentWorkItem: 1, workItemProject: "OC",
      ado: { authorAccount: "owner@example.test" } },
    readProfile: () => ({ purpose: "engineering", remoteRoot: "/workspaces/1JS", workspace: root }),
    preparation: () => prepared, outcome: async () => report,
    client: { item: async () => ({ parentId: 1, project: "OC", assignedTo: "owner@example.test", relations: [] }), isOpen: async () => true },
    capacity: async () => ({ holding: null }),
    inspect: async () => ({ branch: prepared.branch, commit: prepared.commit, worktreeStatus: "" }),
    resume: async (_store, request) => calls.push(request) };
  return { options, store, task, prepared, report, calls };
}

test("fresh verified MCP recovery resumes only the original committed work with real preparation", async t => {
  const f = fixture(t);
  assert.match((await recoverNativePublication(f.options)).holding, /verified MCP environment recovery/);
  const request = f.calls[0];
  assert.equal(request.resumeId, f.task.id);
  assert.equal(request.expectedUpdatedAt, f.task.updated_at);
  assert.equal(request.metadata.independentWorkspace, false);
  assert.deepEqual(request.metadata.preparation, f.prepared);
  assert.deepEqual(request.metadata.handoff, f.store.metadata().handoff);
  assert.equal(request.prompt, "Preparation recovered; retry this original task's publication through repository MCP, " +
    "preserving its implementation and evidence.");
  f.store.submission = () => ({ accepted: true });
  assert.match((await recoverNativePublication(f.options)).holding, /already accepted/);
  assert.equal(f.calls.length, 1);
});

test("stale preparation, source changes, existing PRs, assignment and capacity changes hold the original work", async t => {
  for (const block of [
    f => { f.prepared.updatedAt = f.task.updated_at; },
    f => { f.prepared.updatedAt = "invalid"; },
    f => { f.prepared.ready = false; },
    f => { f.prepared.commit = "b".repeat(40); },
    f => { f.prepared.repoRoot = path.join(f.store.root, "other"); },
    f => { f.options.inspect = async () => null; },
    f => { f.options.inspect = async () => ({ ...f.prepared, worktreeStatus: " M source" }); },
    f => { f.options.inspect = async () => ({ ...f.prepared, branch: "other", worktreeStatus: "" }); },
    f => { f.options.inspect = async () => ({ ...f.prepared, commit: "b".repeat(40), worktreeStatus: "" }); },
    f => { f.options.client.isOpen = async () => false; },
    f => { f.options.client.item = async () => ({ parentId: 1, project: "OC", assignedTo: "owner@example.test",
      relations: [{ rel: "ArtifactLink", url: "vstfs:///Git/PullRequestId/existing" }] }); },
    f => { f.options.capacity = async () => ({ holding: "3/3" }); },
    f => { let count = 0; f.options.client.isOpen = async () => ++count === 1; },
  ]) {
    const f = fixture(t); block(f);
    assert.match((await recoverNativePublication(f.options)).holding, /requires fresh verified/);
    assert.deepEqual(f.calls, []);
  }
  const repeat = fixture(t);
  await recoverNativePublication(repeat.options);
  repeat.task.updated_at = "2026-10-24T22:02:00Z";
  assert.match((await recoverNativePublication(repeat.options)).holding, /requires fresh verified/);
  assert.equal(repeat.calls.length, 1);
});

test("live providers, contracts, pending input, pauses, other outcomes and wrong ownership cannot retry publication", async t => {
  for (const block of [
    f => { f.task.provider = { pid: 123 }; },
    f => { f.task.acceptance = { required: true }; },
    f => { f.task.interaction = { paused: true }; },
    f => { f.task.interaction = { messages: [{ status: "queued" }] }; },
    f => { f.store.isPaused = () => true; },
    f => { f.options.config.repositoryProfile = "bohemia"; },
    f => { f.store.metadata().handoff.workItem.project = "other"; },
    f => { f.report.outcome = "blocked"; },
    f => { f.report.scope = "work-item"; },
    f => { f.options.outcome = async () => null; },
  ]) {
    const f = fixture(t); block(f);
    assert.equal(await recoverNativePublication(f.options), null);
    assert.deepEqual(f.calls, []);
  }
  const invalid = fixture(t); invalid.report.workItemId = 3;
  await assert.rejects(recoverNativePublication(invalid.options), /Invalid partial/);
  const owner = fixture(t); owner.task.session_config.provider = { command: "another" };
  await assert.rejects(recoverNativePublication(owner.options), /ownership changed/);
});

test("publication retry migrates a project alias only to its verified assigned workspace", async t => {
  const f = fixture(t), assigned = path.join(f.store.root, "assigned");
  fs.mkdirSync(assigned);
  f.store.workspaceIdentity = () => assigned;
  f.options.readProfile = () => ({ purpose: "engineering", remoteRoot: "/workspaces/1JS", workspace: assigned });
  f.prepared.repoRoot = assigned;
  await recoverNativePublication(f.options);
  assert.equal(f.calls[0].workspace, assigned);
  assert.equal(f.calls[0].metadata.preparation.repoRoot, assigned);
  assert.deepEqual(f.calls[0].metadata.workspaceMigration, { reason: "assigned_agent_workspace",
    previousWorkspace: f.task.workspace, originalWorkspace: f.task.workspace, assignedWorkspace: assigned });
});

function queuedFixture(t) {
  const f = fixture(t), metadata = f.store.metadata();
  const id = "11111111-2222-4333-8444-555555555555";
  metadata.key = `${metadata.runner}:publication-recovery:original`;
  metadata.retryOf = f.task.id;
  metadata.retryFailedAt = f.task.updated_at;
  metadata.preparation = structuredClone(f.prepared);
  f.task.updated_at = "2026-10-24T22:02:00Z";
  f.task.interaction = { messages: [{ id, status: "queued" }] };
  f.task.error = `Failed to write task file ${JSON.stringify(
    path.join(f.store.root, "queues", "in_progress", `${f.task.id}.json`))}: Access is denied. (os error 5)`;
  f.accepted = { phase: "published", taskId: f.task.id, nativeMessageId: id };
  f.options.receipt = () => f.accepted;
  f.admissions = [];
  f.options.controls = { receipt: () => null, submit: input => f.admissions.push(input) };
  return f;
}

test("an accepted but still queued original input gets one normal admission after its owned atomic write fails", async t => {
  const f = queuedFixture(t);
  assert.match((await recoverNativePublication(f.options)).holding, /original verified queued input/);
  assert.equal(f.admissions.length, 1);
  assert.deepEqual({ ...f.admissions[0], id: undefined }, {
    id: undefined, kind: "status", taskId: f.task.id, status: "in_progress", expectedStatus: "failed",
  });
  assert.deepEqual(f.calls, []);
  f.options.controls.receipt = () => ({ status: "completed" });
  f.task.updated_at = "2026-10-24T22:03:00Z";
  assert.match((await recoverNativePublication(f.options)).holding, /already attempted/);
  assert.equal(f.admissions.length, 1);
});

test("uncertain input, unaccepted or different commands, unrelated failures and changed preparation are never replayed", async t => {
  for (const block of [
    f => { f.task.error = "Access is denied"; },
    f => { f.task.error = f.task.error.replace("in_progress", "unrelated"); },
    f => { f.task.interaction.messages[0].status = "delivering"; },
    f => { f.task.interaction.messages.push({ id: "another", status: "queued" }); },
    f => { f.accepted.phase = "pending"; },
    f => { f.accepted.taskId = "another"; },
    f => { f.accepted.nativeMessageId = "another"; },
    f => { f.store.metadata().key = "another-runner"; },
  ]) {
    const f = queuedFixture(t); block(f);
    assert.equal(await recoverNativePublication(f.options), null);
    assert.deepEqual(f.admissions, []);
  }
  for (const field of ["commit", "branch", "updatedAt", "configSha256", "repoRoot"]) {
    const f = queuedFixture(t);
    f.store.metadata().preparation[field] = "changed";
    assert.match((await recoverNativePublication(f.options)).holding, /requires fresh verified/);
    assert.deepEqual(f.admissions, []);
  }
});
