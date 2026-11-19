import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./fixtures.mjs";
import { readJson, samePath, writeJson } from "../spool-store.mjs";
import { createMonitorControls } from "../monitor-controls.mjs";
import { createWorkspaceReadiness, stageWorkspaceTask, taskWorkspaceRequirement } from "../workspace-readiness.mjs";

function setup(t, { review = true, prepareError, verificationError } = {}) {
  const f = fixture(t), agent = "perf", configFile = path.join(f.root, "provider.json");
  const mcpConfig = path.join(f.root, "repository-mcp.json"), sha = "b".repeat(40);
  const profile = { purpose: review ? "review" : "engineering", workspace: f.workspace,
    remoteRoot: "/workspaces/1JS" };
  writeJson(configFile, profile);
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { [agent]: { command: process.execPath, args: ["--config", configFile],
      workingDirectory: profile.remoteRoot } },
    ...(!review ? { workspacePreparations: { [agent]: {
      repo: "customer-repository", mcpConfig, input: { operation: "setup", repoRoot: f.workspace },
    } } } : {}),
  });
  mkdirSync(path.join(f.root, ".runner", "automation"), { recursive: true });
  writeJson(path.join(f.root, ".runner", "automation", "spool-runners.json"), {
    repository_profile: "1js", repository_mcp_config: mcpConfig, codespace_review_config: configFile,
  });
  mkdirSync(path.join(f.root, "controls"), { recursive: true });
  writeJson(path.join(f.root, "controls", "capabilities.json"), { version: 1, interactive: true,
    taskControl: true, statusControl: true, updatedAt: new Date().toISOString() });
  const prepared = { ...f.preparation, commit: sha, sourceCommit: sha, status: "ready",
    branch: "review/pr-123-bbbbbbbbbbbb", pr: { id: 123 }, prId: 123,
    execution: { kind: "codespace", configFile, ...(review ? {} : { purpose: "engineering" }) } };
  const calls = { prepared: [], verified: [], closed: 0 };
  const close = async () => { calls.closed++; };
  const readiness = createWorkspaceReadiness(f.store, {
    readReview: async (file, id) => {
      assert.equal(file, configFile);
      assert.equal(id, 123);
      return { id, sourceCommit: sha };
    },
    createReviewer: config => {
      assert.equal(config.repositoryMcpConfig, mcpConfig);
      return { prepare: async input => {
        calls.prepared.push(input);
        if (prepareError) throw prepareError;
        writeJson(path.join(f.workspace, "preparation.json"), prepared);
        return prepared;
      }, dispose: close };
    },
    prepareSession: async (repo, input, options) => {
      assert.equal(repo, "customer-repository");
      assert.equal(options.env.REPOSITORY_MCP_CONFIG, mcpConfig);
      calls.prepared.push(input);
      if (prepareError) throw prepareError;
      return { result: { structuredContent: prepared }, close };
    },
    verify: async value => {
      calls.verified.push(value);
      if (verificationError) throw verificationError;
    },
  });
  const controls = createMonitorControls(f.store, { readiness,
    prepare: () => assert.fail("Declared preparation must use repository MCP, not local Bohemia setup") });
  const create = { id: randomUUID(), kind: "create", agent, title: "Review requested work",
    prompt: "Please review https://office.visualstudio.com/Office/_git/1JS/pullrequest/123" };
  return { ...f, agent, configFile, prepared, calls, controls, create };
}

for (const kind of ["create", "status", "message"]) for (const escaped of [false, true])
test(`configured readiness prepares before ${kind} with ${escaped ? "escaped" : "plain"} PR URLs publishes a native launch`, async t => {
  const f = setup(t);
  if (escaped) f.create.prompt = f.create.prompt.replace("/_git/", "/\\_git/");
  writeJson(path.join(f.workspace, "preparation.json"), {
    ...f.prepared, ready: false, status: "stopped", ownerPid: process.pid, pr: { id: 999 }, prId: 999,
  });
  if (kind !== "create") f.put({ id: "original", agent: f.agent, prompt: f.create.prompt }, "failed");
  const command = kind === "create" ? f.create : kind === "status"
    ? { id: randomUUID(), kind, taskId: "original", status: "in_progress", expectedStatus: "failed" }
    : { id: randomUUID(), kind, taskId: "original", message: "Continue the original request." };
  f.controls.submit(command);
  const file = path.join(f.root, "controls", "requests", `${command.id}.json`);
  assert.equal(existsSync(file), false);
  await f.controls.jobs();
  assert.equal(f.controls.receipt(command.id).status, "submitted");
  assert.deepEqual(f.calls.prepared, [{ prId: 123, sourceCommit: f.prepared.commit, repoRoot: f.workspace }]);
  assert.deepEqual(f.calls.verified, [f.prepared]);
  assert.ok(samePath(readJson(file).workspace, f.workspace));
  assert.equal(f.calls.closed, 0, "The preparation owner must survive native acceptance");
  await f.controls.jobs();
  assert.equal(f.calls.prepared.length, 1, "Repeated scans must not prepare or submit twice");
  assert.equal(f.calls.closed, 0, "Do not release preparation before the engine accepts it");
});

test("desktop staging recognizes a Markdown-escaped PR URL without changing the original instructions", t => {
  const f = setup(t);
  const prompt = f.create.prompt.replace("/_git/", "/\\_git/");
  assert.equal(taskWorkspaceRequirement(f.root, f.agent, f.workspace, prompt).reviewConfig, f.configFile);
});

for (const review of [true, false])
test(`configured ${review ? "review" : "engineering"} setup failures stay out of Copilot startup`, async t => {
  const f = setup(t, { review, prepareError: new Error("Required package build failed") });
  f.controls.submit(f.create);
  await f.controls.jobs();
  assert.equal(f.controls.receipt(f.create.id).result.status, "failed");
  assert.match(f.controls.receipt(f.create.id).result.error, /Required package build failed/);
  assert.equal(existsSync(path.join(f.root, "controls", "requests", `${f.create.id}.json`)), false);
  assert.equal(existsSync(path.join(f.root, "controls", "workspace-holds", `${f.create.id}.json`)), false);
});

test("declared preparation is repository-agnostic and keeps its owner through task pickup and execution", async t => {
  const f = setup(t, { review: false });
  f.controls.submit(f.create);
  await f.controls.jobs();
  assert.equal(f.controls.receipt(f.create.id).status, "submitted");
  assert.equal(f.calls.prepared.length, 1);
  assert.equal(f.calls.closed, 0);
  const taskId = `manual-${f.create.id}`;
  writeJson(path.join(f.root, "controls", "results", `${f.create.id}.json`),
    { result: { status: "accepted" } });
  f.put({ id: taskId, agent: f.agent }, "incoming");
  await f.controls.jobs();
  assert.equal(f.calls.closed, 0);
  unlinkSync(path.join(f.root, "queues", "incoming", `${taskId}.json`));
  f.put({ id: taskId, agent: f.agent }, "in_progress");
  await f.controls.jobs();
  assert.equal(f.calls.closed, 0);
  unlinkSync(path.join(f.root, "queues", "in_progress", `${taskId}.json`));
  f.put({ id: taskId, agent: f.agent }, "completed");
  await f.controls.jobs();
  assert.equal(f.calls.closed, 1);
});

test("new launches wait through an existing build and reuse its verified result", async t => {
  const f = setup(t);
  writeJson(path.join(f.workspace, "preparation.json"),
    { ready: false, status: "preparing", stage: "exact-revision-setup-and-build" });
  f.controls.submit(f.create);
  await f.controls.jobs();
  assert.equal(f.controls.receipt(f.create.id).status, "waiting");
  assert.match(f.controls.receipt(f.create.id).detail, /exact-revision-setup-and-build/);
  assert.equal(f.calls.prepared.length, 0);
  writeJson(path.join(f.workspace, "preparation.json"), f.prepared);
  await f.controls.jobs();
  assert.equal(f.controls.receipt(f.create.id).status, "submitted");
  assert.equal(f.calls.prepared.length, 0);
  assert.deepEqual(f.calls.verified, [f.prepared]);
});

test("failed fresh verification never launches or overwrites the existing preparation", async t => {
  const f = setup(t, { verificationError: new Error("PR source branch moved") });
  writeJson(path.join(f.workspace, "preparation.json"), f.prepared);
  f.controls.submit(f.create);
  await f.controls.jobs();
  assert.match(f.controls.receipt(f.create.id).result.error, /PR source branch moved/);
  assert.equal(f.calls.prepared.length, 0);
  assert.equal(existsSync(path.join(f.root, "controls", "requests", `${f.create.id}.json`)), false);
  assert.deepEqual(readJson(path.join(f.workspace, "preparation.json")), f.prepared);
});

test("operator continuations preserve their session and workspace without preparing an old PR revision", async t => {
  for (const change of ["missing identity", "source moved"]) {
    const f = setup(t), session = randomUUID();
    f.put({ id: "original", agent: f.agent, prompt: f.create.prompt, session_id: session,
      ...(change === "source moved" ? { runner_metadata: {
        preparation: { ...f.prepared, commit: "a".repeat(40) },
      } } : {}),
    }, "failed");
    const command = { id: randomUUID(), kind: "message", taskId: "original", message: "Continue." };
    f.controls.submit(command);
    await f.controls.jobs();
    assert.equal(f.controls.receipt(command.id).status, "submitted");
    assert.equal(f.calls.prepared.length, 0);
    assert.equal(f.calls.verified.length, 0);
    const delivered = readJson(path.join(f.root, "controls", "requests", `${command.id}.json`));
    assert.equal(delivered.taskId, command.taskId);
    assert.equal(delivered.workspace, f.workspace);
    assert.equal(delivered.metadata, undefined);
    assert.equal(f.store.task(command.taskId).session_id, session);
    assert.equal(existsSync(path.join(f.workspace, "preparation.json")), false);
  }
});

test("workspace ownership prevents preparation from changing another active task's checkout", async t => {
  const f = setup(t);
  f.put({ id: "active", agent: "software-engineer" }, "in_progress");
  f.controls.submit(f.create);
  await f.controls.jobs();
  assert.equal(f.controls.receipt(f.create.id).status, "waiting");
  assert.match(f.controls.receipt(f.create.id).detail, /owned by Spool task active/);
  assert.equal(f.calls.prepared.length, 0);
  assert.equal(existsSync(path.join(f.root, "controls", "requests", `${f.create.id}.json`)), false);
});

test("controller shutdown never releases a reused runner-owned preparation", async t => {
  const f = setup(t);
  writeJson(path.join(f.workspace, "preparation.json"), f.prepared);
  f.controls.submit(f.create);
  await f.controls.jobs();
  await f.controls.stop();
  assert.equal(f.calls.closed, 0);
  assert.equal(f.calls.prepared.length, 0);
  assert.deepEqual(readJson(path.join(f.workspace, "preparation.json")), f.prepared);
});

test("the desktop preparation handoff publishes the original task only after verified setup", async t => {
  const f = setup(t), requestId = f.create.id, id = `manual-${requestId}`;
  const task = { id, agent: f.agent, title: f.create.title, prompt: f.create.prompt, model: "preferred-model",
    workspace: f.workspace, independent_workspace: false, status: "incoming", session_id: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), error: null,
    comments: [], cost: {}, turns: 0, interaction: { applied_requests: [requestId] }, provider: null };
  const receipt = path.join(f.root, "controls", "ui-submissions", `${requestId}.json`);
  mkdirSync(path.dirname(receipt), { recursive: true });
  writeJson(receipt, { taskId: id, fingerprint: "a".repeat(64), phase: "preparing", task });
  await stageWorkspaceTask(f.root, { requestId, ...f.create });
  assert.equal(f.store.task(id), null);
  assert.equal(readJson(path.join(f.root, "controls", "manual", `${requestId}.json`)).requiresPreparation, true);
  await f.controls.jobs();
  assert.equal(f.calls.prepared.length, 1);
  assert.equal(f.calls.verified.length, 1);
  assert.equal(f.calls.closed, 0);
  const published = f.store.task(id);
  assert.equal(published.model, task.model);
  assert.equal(published.prompt, task.prompt);
  assert.deepEqual(published.runner_metadata.preparation, f.prepared);
  assert.deepEqual(published.interaction.applied_requests, [requestId]);
  assert.equal(readJson(receipt).phase, "published");
  assert.equal(existsSync(path.join(f.root, "controls", "requests", `${requestId}.json`)), false);
  await f.controls.jobs();
  assert.equal(f.calls.prepared.length, 1);
  assert.equal(f.calls.closed, 0, "Pickup must not release the runner's live MCP ownership");
  assert.equal(f.store.tasks().length, 1);
});
