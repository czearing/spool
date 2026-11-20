import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./fixtures.mjs";
import { readJson, writeJson } from "../spool-store.mjs";
import { createMonitorControls, pendingMessages } from "../monitor-controls.mjs";
import { createMonitorHandler } from "../monitor.mjs";
import { renderSpoolTaskPrompt } from "../queue.mjs";
import { withAdmission } from "../admission.mjs";
import { nativeControls } from "./native-controls-fixture.mjs";
import { CodespaceRequests } from "../../packages/repository-mcp/src/codespaces/github-requests.mjs";

function setup(t) {
  const f = fixture(t);
  mkdirSync(path.join(f.root, "controls"), { recursive: true });
  writeJson(path.join(f.root, "controls", "capabilities.json"),
    { version: 1, statusControl: true, taskControl: true, interactive: false, updatedAt: new Date().toISOString() });
  return { ...f, controls: createMonitorControls(f.store) };
}
const input = (taskId, status, expectedStatus) => ({ id: randomUUID(), kind: "status", taskId, status, expectedStatus });

for (const priorityMessageVersion of [undefined, 1])
test(`active user input requests priority delivery with daemon support ${priorityMessageVersion ?? "legacy"}`, t => {
  const f = setup(t);
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, priorityMessageVersion, updatedAt: new Date().toISOString(),
  });
  f.put({ id: "original", session_id: "original-session", provider: { pid: process.pid, token: "fixture" } }, "in_progress");
  const request = { id: randomUUID(), kind: "message", taskId: "original", message: "Read this now." };
  f.controls.submit(request);
  const message = readJson(path.join(f.root, "controls", "requests", `${request.id}.json`));
  assert.equal(message.message, request.message);
  const interruptFile = path.join(f.root, "controls", "requests", `${request.id}-interrupt.json`);
  assert.equal(existsSync(interruptFile), priorityMessageVersion !== 1);
  if (priorityMessageVersion !== 1) {
    const interrupt = readJson(interruptFile);
    assert.equal(interrupt.kind, "interrupt");
    assert.equal(interrupt.taskId, request.taskId);
    assert.ok(Date.parse(interrupt.createdAt) < Date.parse(message.createdAt));
    writeJson(path.join(f.root, "controls", "results", `${request.id}-interrupt.json`), {
      result: { status: "accepted" },
    });
    unlinkSync(interruptFile);
    f.controls.submit(request);
    assert.equal(existsSync(interruptFile), false, "Retry must not interrupt a later turn again");
  }
});

test("admission rechecks a receipt accepted while refreshing processes", async t => {
  const f = setup(t), agent = "perf";
  writeJson(path.join(f.root, "spool.json"), { copilotProviders: {
    [agent]: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" },
  } });
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, updatedAt: new Date().toISOString(),
  });
  f.put({ id: "original", agent, session_id: randomUUID() }, "completed");
  const request = { id: randomUUID(), kind: "message", taskId: "original", message: "Only once." };
  const accepted = { id: request.id, result: { status: "accepted", taskId: request.taskId } };
  const controls = createMonitorControls(f.store, { refreshProcesses: async () => {
    writeJson(path.join(f.root, "controls", "results", `${request.id}.json`), accepted);
    unlinkSync(path.join(f.root, "queues", "completed", "original.json"));
    f.put({ id: "original", agent, session_id: randomUUID() }, "failed");
  } });
  controls.submit(request);
  await controls.jobs();
  assert.deepEqual(controls.receipt(request.id), accepted);
  assert.deepEqual(readdirSync(path.join(f.root, "controls", "requests")), []);
});

for (const matching of [true, false])
test(`persisted false failure reconciles only the exact applied message: ${matching}`, async t => {
  const f = setup(t), agent = "perf", session_id = randomUUID();
  writeJson(path.join(f.root, "spool.json"), { copilotProviders: {
    [agent]: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" },
  } });
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, updatedAt: new Date().toISOString(),
  });
  f.put({ id: "original", agent, session_id }, "completed");
  const request = { id: randomUUID(), kind: "message", taskId: "original", message: "Preserve my message." };
  f.controls.submit(request);
  const jobFile = path.join(f.root, "controls", "native-resumes", `${request.id}.json`);
  writeJson(jobFile, { ...readJson(jobFile), status: "failed", detail: "Task state changed" });
  writeJson(path.join(f.root, "controls", "results", `${request.id}.json`), {
    id: request.id, result: { status: "failed", error: "Task state changed" },
  });
  f.put({ ...f.store.task("original"), interaction: { applied_requests: [request.id],
    messages: [{ id: request.id, text: matching ? request.message : "Different input", status: "delivered" }] } }, "completed");
  await f.controls.jobs();
  assert.equal(f.controls.receipt(request.id).result.status, matching ? "accepted" : "failed");
  assert.deepEqual(readdirSync(path.join(f.root, "controls", "requests")), []);
  assert.equal(f.store.task("original").interaction.messages.length, 1);
  assert.equal(existsSync(jobFile), !matching);
});

test("pending message projection does not initialize controls, queues or workspace preparation", t => {
  const f = fixture(t), root = path.join(f.root, "read-only");
  mkdirSync(root);
  assert.deepEqual(pendingMessages(root, { id: "one" }), []);
  assert.deepEqual(readdirSync(root), []);
  const directory = path.join(root, "controls", "native-resumes"), id = randomUUID();
  mkdirSync(directory, { recursive: true });
  writeJson(path.join(directory, `${id}.json`), { status: "waiting",
    request: { id, kind: "message", taskId: "one", message: "Saved", createdAt: "2026-11-03T10:00:00Z" } });
  assert.deepEqual(pendingMessages(root, { id: "one" }), [{
    id, text: "Saved", created_at: "2026-11-03T10:00:00Z", status: "queued",
  }]);
  assert.deepEqual(readdirSync(path.join(root, "controls")), ["native-resumes"]);
});

for (const state of ["incoming", "completed"])
test(`offline ${state} messages survive controller restart and are applied exactly once`, async t => {
  const f = setup(t), session_id = state === "completed" ? randomUUID() : null;
  f.put({ id: "original", session_id }, state);
  unlinkSync(path.join(f.root, "controls", "capabilities.json"));
  const message = { id: randomUUID(), kind: "message", taskId: "original", message: "Keep going exactly once." };
  f.controls.submit(message);
  f.controls.submit(message);
  assert.equal(readdirSync(path.join(f.root, "controls", "requests")).length, 0);
  const controls = createMonitorControls(f.store, { prepare: () => assert.fail("Do not prepare ordinary local chat") });
  await controls.jobs();
  assert.equal(readdirSync(path.join(f.root, "controls", "requests")).length, 0);
  assert.equal(controls.pendingMessages(f.store.task("original")).length, 1);
  const processRequests = nativeControls(t, f.root);
  await controls.jobs();
  assert.equal(controls.receipt(message.id).status, "submitted");
  processRequests();
  assert.equal(controls.receipt(message.id).result.status, "accepted");
  controls.submit(message);
  await controls.jobs();
  const task = f.store.task("original");
  assert.equal(task.interaction.messages.filter(saved => saved.id === message.id).length, 1);
  assert.equal(controls.pendingMessages(task).length, 0);
});

for (const changed of ["agent", "workspace", "session_id"])
test(`offline messages do not follow changed ${changed} ownership`, async t => {
  const f = setup(t);
  f.put({ id: "original", session_id: "original-session" }, "completed");
  unlinkSync(path.join(f.root, "controls", "capabilities.json"));
  const message = { id: randomUUID(), kind: "message", taskId: "original", message: "Stay in this conversation." };
  f.controls.submit(message);
  const values = { agent: "perf", workspace: f.root, session_id: "different-session" };
  f.put({ ...f.store.task("original"), [changed]: values[changed] }, "completed");
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, messageContinuationVersion: 1, updatedAt: new Date().toISOString(),
  });
  await f.controls.jobs();
  assert.match(f.controls.receipt(message.id).result.error, /ownership changed/);
  assert.equal(readdirSync(path.join(f.root, "controls", "requests")).length, 0);
  assert.equal(f.controls.pendingMessages(f.store.task("original"))[0].status, "failed");
});

test("partial publication retains the original saved session before its admission job exists", async t => {
  const f = setup(t);
  f.put({ id: "original", session_id: "original-session" }, "completed");
  unlinkSync(path.join(f.root, "controls", "capabilities.json"));
  const message = { id: randomUUID(), kind: "message", taskId: "original", message: "Only the original session." };
  f.controls.stage(message);
  f.put({ ...f.store.task("original"), session_id: "different-session" }, "completed");
  const restarted = createMonitorControls(f.store);
  restarted.submit(message);
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, messageContinuationVersion: 1, updatedAt: new Date().toISOString(),
  });
  await restarted.jobs();
  assert.match(restarted.receipt(message.id).result.error, /ownership changed/);
  assert.equal(readdirSync(path.join(f.root, "controls", "requests")).length, 0);
});

test("offline historical messages retain the daemon continuation compatibility guard", async t => {
  const f = setup(t);
  f.put({ id: "original", session_id: randomUUID() }, "completed");
  unlinkSync(path.join(f.root, "controls", "capabilities.json"));
  const message = { id: randomUUID(), kind: "message", taskId: "original", message: "Continue safely." };
  f.controls.submit(message);
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, updatedAt: new Date().toISOString(),
  });
  f.controls.submit(message);
  await f.controls.jobs();
  assert.equal(readdirSync(path.join(f.root, "controls", "requests")).length, 0);
  assert.match(f.controls.receipt(message.id).detail, /continuation support/);
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, messageContinuationVersion: 1, updatedAt: new Date().toISOString(),
  });
  await f.controls.jobs();
  assert.equal(readJson(path.join(f.root, "controls", "requests", `${message.id}.json`)).message, message.message);
});

test("offline follow-ups enter the native queue in submission order, not UUID order", async t => {
  const f = setup(t);
  f.put({ id: "original" });
  unlinkSync(path.join(f.root, "controls", "capabilities.json"));
  let time = Date.now();
  const controls = createMonitorControls(f.store, { now: () => time });
  const first = { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", kind: "message", taskId: "original", message: "First" };
  const second = { ...first, id: "00000000-0000-4000-8000-000000000001", message: "Second" };
  controls.submit(first);
  time++;
  controls.submit(second);
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, updatedAt: new Date(time).toISOString(),
  });
  await controls.jobs();
  assert.deepEqual(readdirSync(path.join(f.root, "controls", "requests")), [`${first.id}.json`]);
  const processRequests = nativeControls(t, f.root);
  assert.deepEqual(f.store.task("original").interaction.messages.map(message => message.text), ["First"]);
  time = Date.now();
  await controls.jobs();
  processRequests();
  assert.deepEqual(f.store.task("original").interaction.messages.map(message => message.text), ["First", "Second"]);
});

for (const delivery of ["queued", "delivering", "delivery_uncertain"])
test(`lost publication and receipt recovery preserve ${delivery} native input without replay`, async t => {
  const f = setup(t);
  f.put({ id: "original" });
  const processRequests = nativeControls(t, f.root);
  const message = { id: randomUUID(), kind: "message", taskId: "original", message: "One operator input." };
  f.controls.stage(message);
  f.controls.submit(message);
  unlinkSync(path.join(f.root, "controls", "requests", `${message.id}.json`));
  await f.controls.jobs();
  processRequests();
  const task = f.store.task("original");
  f.put({ ...task, interaction: { ...task.interaction,
    messages: task.interaction.messages.map(message => ({ ...message, status: delivery })) } }, task.status);
  unlinkSync(path.join(f.root, "controls", "results", `${message.id}.json`));
  await f.controls.jobs();
  processRequests();
  assert.equal(f.store.task("original").interaction.messages.length, 1);
  assert.equal(f.store.task("original").interaction.messages[0].status, delivery);
  const rejected = { ...message, id: randomUUID(), message: "A genuinely rejected message." };
  f.controls.submit(rejected);
  writeJson(path.join(f.root, "controls", "results", `${rejected.id}.json`), {
    id: rejected.id, result: { status: "failed", error: "Original workspace ownership changed" },
  });
  await f.controls.jobs();
  await f.controls.jobs();
  assert.deepEqual(f.controls.pendingMessages(f.store.task("original")).map(saved => [saved.id, saved.status]),
    [[rejected.id, "failed"]]);
});

test("native recovery breaks circular waiting reservations without admitting both conversations", async t => {
  const f = setup(t), agent = "software-engineer";
  writeJson(path.join(f.root, "spool.json"), { copilotProviders: {
    [agent]: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" },
  } });
  for (const id of ["first", "second"]) {
    f.put({ id, agent, session_id: randomUUID(), interaction: { phase: "waiting_preparation",
      messages: [{ id: randomUUID(), text: id, status: "queued" }] } }, "failed");
  }
  await f.controls.jobs();
  const requests = readdirSync(path.join(f.root, "controls", "requests"));
  assert.equal(requests.length, 1, "Exactly one original conversation must make progress");
  const holds = readdirSync(path.join(f.root, "controls", "workspace-holds"));
  assert.equal(holds.length, 1);
  const hold = readJson(path.join(f.root, "controls", "workspace-holds", holds[0]));
  assert.equal(hold.ready, true, "Waiting jobs must not retain circular reservations");
  assert.equal(hold.taskId, readJson(path.join(f.root, "controls", "requests", requests[0])).taskId);
  await f.controls.jobs();
  assert.equal(readdirSync(path.join(f.root, "controls", "requests")).length, 1);
});

test("native recovery resumes already-queued input with an implicit project workspace", async t => {
  const f = setup(t), agent = "software-engineer", session = randomUUID();
  const message = { id: randomUUID(), text: "Explain the caching decision.", status: "queued" };
  writeJson(path.join(f.root, "spool.json"), { copilotProviders: {
    [agent]: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" },
  } });
  f.put({ id: "original", agent, workspace: null, session_id: session,
    session_config: { workspace: f.root }, interaction: { phase: "waiting_preparation", messages: [message] } }, "failed");
  await f.controls.jobs();
  const requests = readdirSync(path.join(f.root, "controls", "requests"));
  assert.equal(requests.length, 1);
  const request = readJson(path.join(f.root, "controls", "requests", requests[0]));
  assert.equal(request.kind, "status");
  assert.equal(request.taskId, "original");
  assert.equal(request.workspace, f.root);
  assert.equal(f.store.task("original").session_id, session);
  assert.equal(f.store.task("original").workspace, null);
  assert.deepEqual(f.store.task("original").interaction.messages, [message]);
  await f.controls.jobs();
  assert.equal(readdirSync(path.join(f.root, "controls", "requests")).length, 1);
});

for (const legacyQueued of [false, true])
test(`native messages resume an implicit project workspace: legacy queue ${legacyQueued}`, async t => {
  const f = setup(t), agent = "software-engineer", session = randomUUID();
  writeJson(path.join(f.root, "spool.json"), { copilotProviders: {
    [agent]: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" },
  } });
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, taskControl: true, statusControl: true, updatedAt: new Date().toISOString(),
  });
  f.put({ id: "original", agent, workspace: null, session_id: session,
    session_config: { workspace: f.root }, interaction: { phase: "ended", messages: [] } }, "completed");
  const request = { id: randomUUID(), kind: "message", taskId: "original",
    message: "Why did we choose that instead of caching?" };
  f.controls.submit(request);
  const file = path.join(f.root, "controls", "native-resumes", `${request.id}.json`);
  assert.equal(readJson(file).request.workspace, f.root);
  if (legacyQueued) {
    const job = readJson(file);
    writeJson(file, { ...job, request: { ...job.request, workspace: null } });
  }
  await f.controls.jobs();
  assert.equal(f.controls.receipt(request.id).status, "submitted");
  const published = readJson(path.join(f.root, "controls", "requests", `${request.id}.json`));
  assert.equal(published.taskId, request.taskId);
  assert.equal(published.message, request.message);
  assert.equal(published.workspace, f.root);
  assert.equal(f.store.task("original").session_id, session);
  assert.equal(f.store.task("original").workspace, null, "Do not migrate the original conversation");
  await f.controls.jobs();
  assert.equal(readdirSync(path.join(f.root, "controls", "requests")).length, 1);
});

test("failed opening reviewer chat retries its original assignment once without requiring an unrelated PR", async t => {
  const f = setup(t), request = randomUUID(), id = `manual-${request}`, agent = "pr-reviewer";
  const configFile = path.join(f.root, "reviewer.json");
  writeJson(configFile, { purpose: "review", workspace: f.workspace });
  writeJson(path.join(f.root, ".runner", "automation", "spool-runners.json"), {
    repository_profile: "1js", repository_mcp_config: path.join(f.root, "repository-mcp.json"),
    codespace_review_config: configFile,
  });
  writeJson(path.join(f.root, "spool.json"), { copilotProviders: {
    [agent]: { command: process.execPath, args: ["--config", configFile], workingDirectory: "/workspaces/1JS" },
  } });
  const original = { id, agent, turns: 0, session_id: null, updated_at: "2026-11-03T00:00:00Z",
    error: "Copilot ACP startup failed: Codespace preparation is not ready: Copilot ACP closed its output",
    interaction: { phase: "ended", applied_requests: [request], messages: [] } };
  f.put(original, "failed");
  writeJson(path.join(f.root, "controls", "ui-submissions", `${request}.json`), {
    taskId: id, phase: "published", fingerprint: "a".repeat(64),
  });
  const controls = createMonitorControls(f.store, {
    verifyNativePreparation: () => assert.fail("Conversation is not an assigned PR review"),
    prepare: () => assert.fail("Native chat must not perform local repository setup"),
  });
  await controls.jobs();
  await controls.jobs();
  const requests = readdirSync(path.join(f.root, "controls", "requests"));
  assert.equal(requests.length, 1);
  assert.equal(readJson(path.join(f.root, "controls", "requests", requests[0])).taskId, id);
  assert.equal(f.store.task(id).session_id, null);
  assert.equal(f.store.task(id).interaction.messages.length, 0, "Never invent or duplicate user input");
  f.put({ ...original, updated_at: "2026-11-03T01:00:00Z", runner_metadata: { runner: "pr-reviewer" } }, "failed");
  await controls.jobs();
  assert.equal(readdirSync(path.join(f.root, "controls", "requests")).length, 1, "Assigned reviews remain runner-owned");
});

for (const recovery of ["healthy", "ownership-changed", "permission-denied"])
test(`native first-session admission persists its message across connection backoff: ${recovery}`, async t => {
  const f = setup(t), configFile = path.join(f.root, "reviewer.json"), session = null;
  writeJson(configFile, { purpose: "review" });
  writeJson(path.join(f.root, "spool.json"), { copilotProviders: {
    "pr-reviewer": { command: process.execPath, args: ["--config", configFile], workingDirectory: "/workspaces/1JS" },
  } });
  writeJson(path.join(f.workspace, "preparation.json"), f.preparation);
  f.put({ id: "original", agent: "pr-reviewer", session_id: session }, "failed");
  let time = Date.now(), attempts = 0;
  const capabilities = () => writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, taskControl: true, statusControl: true, updatedAt: new Date(time).toISOString(),
  });
  capabilities();
  const options = { now: () => time, verifyNativePreparation: async () => {
    attempts++;
    if (recovery === "permission-denied") throw new Error("Permission denied (publickey)");
    if (attempts === 1) throw Object.assign(new Error("Connection reset by peer"),
      { retryAt: new Date(time + 60_000).toISOString() });
  } };
  const controls = createMonitorControls(f.store, options);
  const request = { id: randomUUID(), kind: "message", taskId: "original", message: "Keep my exact message." };
  controls.submit(request);
  await controls.jobs();
  if (recovery === "permission-denied") {
    assert.match(controls.receipt(request.id).result.error, /Permission denied/);
    return;
  }
  assert.equal(controls.receipt(request.id).status, "waiting");
  assert.match(controls.receipt(request.id).detail, /Reconnecting/);
  assert.equal(existsSync(path.join(f.root, "controls", "results", `${request.id}.json`)), false);
  assert.equal(readdirSync(path.join(f.root, "controls", "workspace-holds")).length, 0);
  const restarted = createMonitorControls(f.store, options);
  time += 30_000; capabilities();
  await restarted.jobs();
  assert.equal(attempts, 1, "Persisted retry deadline must survive controller restarts");
  if (recovery === "ownership-changed")
    f.put({ ...f.store.task("original"), session_id: randomUUID() }, "failed");
  time += 30_001; capabilities();
  await restarted.jobs();
  if (recovery === "ownership-changed") {
    assert.match(restarted.receipt(request.id).result.error, /ownership changed/);
    assert.equal(attempts, 1);
    return;
  }
  assert.equal(restarted.receipt(request.id).status, "submitted");
  const published = readJson(path.join(f.root, "controls", "requests", `${request.id}.json`));
  assert.equal(published.message, request.message);
  assert.equal(published.taskId, request.taskId);
  assert.equal(f.store.task("original").session_id, session);
  await restarted.jobs();
  assert.equal(attempts, 2);
  assert.equal(readdirSync(path.join(f.root, "controls", "requests")).length, 1);
});

for (const state of ["completed", "failed"])
test(`explicit native ${state} session continuation needs no preparation receipt or original PR revision`, async t => {
  const f = setup(t), agent = "pr-reviewer", session = randomUUID();
  const configFile = path.join(f.root, "reviewer.json");
  writeJson(configFile, { purpose: "review", workspace: f.workspace, remoteRoot: "/workspaces/1JS" });
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { [agent]: { command: process.execPath, args: ["--config", configFile],
      workingDirectory: "/workspaces/1JS" } },
    workspacePreparations: { [agent]: { repo: "1js", input: { repoRoot: f.workspace }, mcpConfig: configFile } },
  });
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, updatedAt: new Date().toISOString(),
  });
  f.put({ id: "original-review", agent, session_id: session,
    runner_metadata: { runner: "pr-reviewer", preparation: f.preparation } }, state);
  const controls = createMonitorControls(f.store, {
    prepare: () => assert.fail("An operator continuation must not prepare or reset the checkout"),
    verifyNativePreparation: () => assert.fail("An operator continuation must not require old preparation"),
    readiness: { releaseIdle: async () => {}, ensure: () => assert.fail("Do not pin reconnection to an old PR revision") },
  });
  const request = { id: randomUUID(), kind: "message", taskId: "original-review", message: "Continue with direct commands." };
  controls.submit(request);
  await controls.jobs();
  assert.equal(controls.receipt(request.id).status, "submitted");
  const delivered = readJson(path.join(f.root, "controls", "requests", `${request.id}.json`));
  assert.equal(delivered.taskId, request.taskId);
  assert.equal(delivered.message, request.message);
  assert.equal(delivered.metadata, undefined);
  assert.equal(f.store.task(request.taskId).session_id, session);
  assert.equal(existsSync(path.join(f.workspace, "preparation.json")), false);
});

test("accepted reviewer operator input finishes workspace admission without preparing its old PR", async t => {
  const f = setup(t), agent = "pr-reviewer", session = randomUUID();
  const configFile = path.join(f.root, "reviewer.json");
  writeJson(configFile, { purpose: "review", workspace: f.workspace, remoteRoot: "/workspaces/1JS" });
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { [agent]: { command: process.execPath, args: ["--config", configFile],
      workingDirectory: "/workspaces/1JS" } },
    workspacePreparations: { [agent]: { repo: "1js", input: { repoRoot: f.workspace }, mcpConfig: configFile } },
  });
  f.put({ id: "original-review", agent, session_id: session,
    runner_metadata: { runner: "pr-reviewer", preparation: f.preparation },
    interaction: { phase: "waiting_preparation", chat_return: { status: "completed" },
      messages: [{ id: randomUUID(), text: "Continue with direct commands.", status: "queued" }] } }, "failed");
  const controls = createMonitorControls(f.store, {
    prepare: () => assert.fail("Accepted operator input must not reset its checkout"),
    verifyNativePreparation: () => assert.fail("Accepted operator input needs no stale PR receipt"),
    readiness: { releaseIdle: async () => {}, ensure: () => assert.fail("Do not re-prepare the old PR") },
  });
  await controls.jobs();
  const files = readdirSync(path.join(f.root, "controls", "requests"));
  assert.equal(files.length, 1);
  const request = readJson(path.join(f.root, "controls", "requests", files[0]));
  assert.equal(request.kind, "status");
  assert.equal(request.taskId, "original-review");
  assert.equal(request.metadata.dashboardPrepared, true);
  assert.equal(f.store.task(request.taskId).session_id, session);
  assert.equal(existsSync(path.join(f.workspace, "preparation.json")), false);
});

for (const arrival of ["before-scan", "during-scan"])
for (const resource of ["independent", "same-agent", "same-workspace"])
test(`slow admission preserves ${resource} scheduling for ${arrival} arrivals`, { timeout: 10000 }, async t => {
  const f = setup(t), nativeWorkspace = path.join(f.root, "native-workspace");
  mkdirSync(nativeWorkspace);
  const configFile = path.join(f.root, "reviewer.json");
  writeJson(configFile, { purpose: "review" });
  writeJson(path.join(f.workspace, "preparation.json"), f.preparation);
  writeJson(path.join(f.root, "spool.json"), { copilotProviders: {
    "pr-reviewer": { command: process.execPath, args: ["--config", configFile], workingDirectory: "/workspaces/1JS" },
    perf: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" },
  } });
  f.put({ id: "slow", agent: "pr-reviewer" }, "failed");
  f.put({ id: "fast", agent: resource === "same-agent" ? "pr-reviewer" : "perf",
    workspace: resource === "same-workspace" ? f.workspace : nativeWorkspace }, "failed");
  let release, entered;
  const preparing = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const controls = createMonitorControls(f.store, { verifyNativePreparation: async () => {
    entered();
    await blocked;
  } });
  const slow = { ...input("slow", "in_progress", "failed"), id: "00000000-0000-4000-8000-000000000001" };
  const fast = { ...input("fast", "in_progress", "failed"), id: "ffffffff-ffff-4fff-8fff-ffffffffffff" };
  controls.submit(slow);
  if (arrival === "before-scan") controls.submit(fast);
  const scanning = controls.jobs();
  let followup;
  try {
    await Promise.race([preparing, scanning.then(() => assert.fail(JSON.stringify(controls.receipt(slow.id))))]);
    if (arrival === "during-scan") {
      controls.submit(fast);
      followup = controls.jobs();
    }
    if (resource === "independent") {
      const deadline = Date.now() + 1500;
      while (!existsSync(path.join(f.root, "controls", "requests", `${fast.id}.json`)) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 10));
    } else await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(controls.receipt(slow.id).status, "preparing");
    assert.equal(controls.receipt(fast.id).status, resource === "independent" ? "submitted" : "waiting",
      "Only independent agents and workspaces may bypass an unfinished admission");
  } finally { release(); await Promise.all([scanning, followup]); }
});

test("completed admissions do not release another scan's planning lock", { timeout: 10000 }, async t => {
  const f = setup(t), configFile = path.join(f.root, "reviewer.json");
  writeJson(configFile, { purpose: "review" });
  writeJson(path.join(f.workspace, "preparation.json"), f.preparation);
  writeJson(path.join(f.root, "spool.json"), { copilotProviders: {
    "pr-reviewer": { command: process.execPath, args: ["--config", configFile], workingDirectory: "/workspaces/1JS" },
  } });
  f.put({ id: "slow", agent: "pr-reviewer" }, "failed");
  let releaseAdmission, enteredAdmission, releasePlanning, enteredPlanning, releases = 0;
  const admission = new Promise(resolve => { releaseAdmission = resolve; });
  const preparing = new Promise(resolve => { enteredAdmission = resolve; });
  const planning = new Promise(resolve => { releasePlanning = resolve; });
  const scanning = new Promise(resolve => { enteredPlanning = resolve; });
  const controls = createMonitorControls(f.store, {
    readiness: { releaseIdle: async () => {
      if (++releases === 2) { enteredPlanning(); await planning; }
    } },
    verifyNativePreparation: async () => { enteredAdmission(); await admission; },
  });
  const request = input("slow", "in_progress", "failed");
  controls.submit(request);
  const first = controls.jobs();
  let second;
  try {
    await Promise.race([preparing, first.then(() => assert.fail(JSON.stringify(controls.receipt(request.id))))]);
    second = controls.jobs();
    await scanning;
    releaseAdmission();
    await first;
    await controls.jobs();
    assert.equal(releases, 2, "Finishing an older admission must not unlock an active planning scan");
    assert.equal(controls.receipt(request.id).status, "submitted");
  } finally {
    releaseAdmission();
    releasePlanning();
    await Promise.all([first, second]);
  }
  assert.equal(readdirSync(path.join(f.root, "controls", "requests")).length, 1);
});

test("temporary native startup failures retry existing input through shared admission without replay or duplicate commands", async t => {
  for (const cause of [
    "error getting ssh server details: failed to start SSH server",
    "[Copilot ACP setup] CODESPACE_UNAVAILABLE retryAt=2026-11-03T21:51:19.878Z",
    "[Copilot ACP setup] CODESPACE_SHUTTING_DOWN retryAt=2026-11-03T21:51:19.878Z",
    "[Copilot ACP setup] GITHUB_RATE_LIMITED retryAt=2026-11-03T21:51:19.878Z",
    "error connecting to codespace: timed out while waiting for the codespace to start",
  ]) for (const session of [null, randomUUID()]) {
    const f = setup(t), agent = "software-engineer-2";
    writeJson(path.join(f.root, "spool.json"), {
      copilotProviders: { [agent]: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
    });
    const message = { id: randomUUID(), text: "Keep going", status: "queued" };
    const error = `Copilot ACP startup failed: ${cause}: Copilot ACP closed its output`;
    f.put({ id: "original-fix", agent, session_id: session, error, updated_at: "2026-11-03T20:00:00Z",
      interaction: { phase: "ended", messages: [message] } }, "failed");
    const controls = createMonitorControls(f.store, { prepare: () => assert.fail("Use the existing native handoff") });
    await controls.jobs();
    const commands = path.join(f.root, "controls", "commands"), [first] = readdirSync(commands);
    assert.ok(first);
    writeJson(path.join(f.root, "controls", "results", first), { result: { status: "accepted" } });
    await controls.jobs();
    assert.equal(readdirSync(commands).length, 1, "An unchanged failed snapshot must not retry twice");
    f.put({ ...f.store.task("original-fix"), updated_at: "2026-11-03T20:01:00Z" }, "failed");
    await controls.jobs();
    await controls.jobs();
    const names = readdirSync(commands);
    assert.equal(names.length, 2, "A new temporary startup failure must not strand the same queued input");
    for (const name of names) {
      const request = readJson(path.join(f.root, "controls", "requests", name));
      assert.equal(request.kind, "status");
      assert.equal(request.taskId, "original-fix");
      assert.equal(request.message, undefined);
    }
    assert.equal(f.store.task("original-fix").session_id, session);
    assert.deepEqual(f.store.task("original-fix").interaction.messages, [message]);
  }
});

for (const matching of [true, false])
test(`reviewer lease startup recovery preserves accepted input without a chat-return flag: ${matching}`, async t => {
  const f = setup(t), agent = "pr-reviewer", session = randomUUID();
  const configFile = path.join(f.root, "reviewer.json");
  writeJson(configFile, { purpose: "review", workspace: f.workspace, remoteRoot: "/workspaces/1JS" });
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { [agent]: { command: process.execPath, args: ["--config", configFile],
      workingDirectory: "/workspaces/1JS" } },
    workspacePreparations: { [agent]: { repo: "1js", input: { repoRoot: f.workspace }, mcpConfig: configFile } },
  });
  const message = { id: randomUUID(), text: "Try again", status: "queued" };
  const error = "Copilot ACP startup failed: [Copilot ACP setup] Codespace workspace is busy with another operation; retry after it finishes. Log: lease.log: Copilot ACP closed its output";
  f.put({ id: "original-review", agent, session_id: session, error, updated_at: "2026-11-03T20:00:00Z",
    runner_metadata: { runner: "pr-reviewer", preparation: f.preparation },
    interaction: { phase: "ended", messages: [message], applied_requests: [message.id] } }, "failed");
  writeJson(path.join(f.root, "controls", "commands", `${message.id}.json`), {
    input: { id: message.id, kind: "message", taskId: "original-review", message: matching ? message.text : "Different input" },
    request: { kind: "message", taskId: "original-review", agent, workspace: f.workspace },
    conversation: { sessionId: session },
  });
  const controls = createMonitorControls(f.store, {
    prepare: () => assert.fail("Recovery must not reset the original checkout"),
    verifyNativePreparation: () => assert.fail("Accepted operator input does not require the old PR receipt"),
    readiness: { releaseIdle: async () => {}, ensure: () => assert.fail("Do not re-prepare the old PR") },
  });
  await controls.jobs();
  const directory = path.join(f.root, "controls", "requests");
  const files = readdirSync(directory);
  assert.equal(files.length, matching ? 1 : 0);
  if (matching) {
    const request = readJson(path.join(directory, files[0]));
    assert.equal(request.kind, "status");
    assert.equal(request.taskId, "original-review");
    assert.equal(request.metadata.dashboardPrepared, true);
    writeJson(path.join(f.root, "controls", "results", files[0]), { result: { status: "accepted" } });
    await controls.jobs();
    assert.equal(readdirSync(directory).length, 1, "An unchanged startup failure must not create another recovery");
  }
  assert.equal(f.store.task("original-review").session_id, session);
  assert.equal(f.store.task("original-review").prompt, "Fixture work");
  assert.deepEqual(f.store.task("original-review").interaction.messages, [message]);
});

test("native runner and operator admission both wait for shared connection recovery", async t => {
  const f = setup(t), agent = "software-engineer-2", configFile = path.join(f.root, "engineering.json");
  writeJson(configFile, { purpose: "engineering", githubAccount: "fixture", codespace: "owned", workspace: f.workspace });
  writeJson(path.join(f.root, "spool.json"), { copilotProviders: {
    [agent]: { command: process.execPath, args: ["--config", configFile], workingDirectory: "/workspaces/1JS" },
  } });
  f.put({ id: "original-fix", agent, session_id: randomUUID() }, "failed");
  let blocked = true;
  t.mock.method(CodespaceRequests.prototype, "check", () => {
    if (blocked) throw Object.assign(new Error("Waiting for Codespace SSH recovery"), { code: "CODESPACE_UNAVAILABLE" });
  });
  const command = input("original-fix", "in_progress", "failed");
  f.controls.submit(command);
  await f.controls.jobs();
  assert.equal(f.controls.receipt(command.id).status, "waiting");
  assert.equal(existsSync(path.join(f.root, "controls", "requests", `${command.id}.json`)), false);
  blocked = false;
  await f.controls.jobs();
  assert.equal(f.controls.receipt(command.id).status, "submitted");
  assert.equal(readJson(path.join(f.root, "controls", "requests", `${command.id}.json`)).taskId, "original-fix");
});

test("native initial-start recovery admits an unset workspace without creating another assignment", async t => {
  const f = setup(t), agent = "software-engineer-2";
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { [agent]: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });
  f.put({ id: "original-fix", agent, workspace: null, session_id: null,
    error: "Copilot ACP startup failed: Node.js v22.23.0: Copilot ACP closed its output",
    interaction: { phase: "ended", messages: [] } }, "failed");
  const processControls = nativeControls(t, f.root);
  const controls = createMonitorControls(f.store, { prepare: () => assert.fail("Use the registered native provider") });
  const command = input("original-fix", "in_progress", "failed");
  controls.submit(command);
  await controls.jobs();
  assert.equal(controls.receipt(command.id).status, "submitted");
  processControls();
  const saved = f.store.task("original-fix");
  assert.equal(saved.status, "incoming");
  assert.equal(saved.session_id, null);
  assert.equal(saved.prompt, "Fixture work");
  assert.deepEqual(saved.interaction.messages, []);
  assert.equal(f.store.tasks().length, 1);
});

test("empty native restores recover the original task once through workspace admission", async t => {
  const f = setup(t), agent = "software-engineer-2", session = randomUUID();
  const error = "Restored session has no pending message; original assignment will not be replayed";
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, taskControl: true, statusControl: true, updatedAt: new Date().toISOString(),
  });
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { [agent]: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });
  const message = { id: randomUUID(), text: "Previously delivered input", status: "delivered" };
  f.put({ id: "original-fix", agent, session_id: session, error,
    interaction: { phase: "ended", messages: [message] } }, "failed");
  writeJson(path.join(f.workspace, "repository-mcp.lock"), { pid: process.pid });
  await f.controls.jobs();
  const jobs = path.join(f.root, "controls", "manual"), [name] = readdirSync(jobs);
  assert.ok(name, "A failed empty restore must not be stranded without pending input");
  assert.match(readJson(path.join(jobs, name)).detail, /Waiting for repository MCP operation/);
  unlinkSync(path.join(f.workspace, "repository-mcp.lock"));
  await f.controls.jobs();
  const request = readJson(path.join(f.root, "controls", "requests", name));
  assert.equal(request.kind, "status");
  assert.equal(request.taskId, "original-fix");
  assert.equal(request.status, "in_progress");
  assert.equal(request.expectedStatus, "failed");
  assert.equal(f.store.task("original-fix").session_id, session);
  assert.deepEqual(f.store.task("original-fix").interaction.messages, [message]);
  writeJson(path.join(f.root, "controls", "results", name), { result: { status: "accepted" } });
  await f.controls.jobs();
  const original = f.store.task("original-fix");
  f.put({ ...original, updated_at: new Date(Date.now() + 1000).toISOString() }, "failed");
  await createMonitorControls(f.store).jobs();
  assert.equal(readdirSync(jobs).length, 0, "A repeated empty restore in the same session must not loop");
  assert.equal(readdirSync(path.join(f.root, "controls", "commands")).length, 1);
});

test("empty-restore recovery preserves pauses, delivery uncertainty, contracts and reviewer ownership", async t => {
  const f = setup(t), agent = "software-engineer-2";
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, taskControl: true, statusControl: true, updatedAt: new Date().toISOString(),
  });
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { [agent]: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });
  const error = "Restored session has no pending message; original assignment will not be replayed";
  for (const [id, change] of Object.entries({
    paused: { interaction: { phase: "ended", paused: true } },
    uncertain: { interaction: { phase: "ended", messages: [{ status: "delivery_uncertain" }] } },
    rejected: { interaction: { phase: "ended", messages: [{ status: "failed" }] } },
    live: { provider: { pid: process.pid } },
    contract: { acceptance: { required: true } },
    reviewer: { runner_metadata: { runner: "pr-reviewer" } },
    unrelated: { error: "Application authentication required" },
  })) {
    f.put({ id, agent, session_id: randomUUID(), error, interaction: { phase: "ended" }, ...change }, "failed");
  }
  await f.controls.jobs();
  assert.equal(readdirSync(path.join(f.root, "controls", "manual")).length, 0);
  assert.equal(readdirSync(path.join(f.root, "controls", "requests")).length, 0);
});

test("native empty-restore admission queues the existing continuation cue without replaying the assignment", async t => {
  const f = setup(t), agent = "software-engineer-2", session = randomUUID();
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { [agent]: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });
  f.put({ id: "original-fix", agent, session_id: session,
    error: "Restored session has no pending message; original assignment will not be replayed",
    interaction: { phase: "ended", messages: [] } }, "failed");
  const processControls = nativeControls(t, f.root);
  await f.controls.jobs();
  processControls();
  const saved = f.store.task("original-fix");
  assert.equal(saved.status, "incoming");
  assert.equal(saved.session_id, session);
  assert.equal(saved.prompt, "Fixture work");
  assert.equal(saved.interaction.messages.length, 1);
  assert.equal(saved.interaction.messages[0].status, "queued");
  assert.equal(saved.interaction.messages[0].text, "Continue the interrupted task from its current session context.");
  await f.controls.jobs();
  assert.equal(f.store.tasks().length, 1);
  assert.equal(f.store.task("original-fix").interaction.messages.length, 1);
});

test("native operator input waits for workspace admission and resumes without duplicating its message", async t => {
  const f = setup(t), agent = "software-engineer-2", session = randomUUID();
  const message = { id: randomUUID(), text: "Fix the message", status: "queued" };
  f.put({ id: "original-fix", agent, session_id: session,
    interaction: { phase: "waiting_preparation", messages: [message] } }, "failed");
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { [agent]: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });
  writeJson(path.join(f.workspace, "repository-mcp.lock"), { pid: process.pid });
  await f.controls.jobs();
  const jobs = path.join(f.root, "controls", "manual");
  const [name] = readdirSync(jobs);
  const waiting = readJson(path.join(jobs, name));
  assert.match(waiting.detail, /Waiting for repository MCP operation/);
  assert.equal(readdirSync(path.join(f.root, "controls", "requests")).length, 0);
  assert.throws(() => f.store.assertIdle(agent, f.workspace, "another-task"), /reserved/);
  unlinkSync(path.join(f.workspace, "repository-mcp.lock"));
  await f.controls.jobs();
  const request = readJson(path.join(f.root, "controls", "requests", name));
  assert.equal(request.kind, "status");
  assert.equal(request.taskId, "original-fix");
  assert.equal(request.expectedStatus, "failed");
  assert.deepEqual(f.store.task("original-fix").interaction.messages, [message]);
  writeJson(path.join(f.root, "controls", "results", name), { result: { status: "accepted" } });
  await f.controls.jobs();
  assert.equal(readdirSync(jobs).length, 0, "Accepted recovery must not loop on old queued input");
  assert.equal(readdirSync(path.join(f.root, "controls", "workspace-holds")).length, 0);
});

test("unchanged admission waits do not rewrite journals, while changed blockers and admission still persist", async t => {
  const f = setup(t), agent = "software-engineer-2";
  let clock = Date.now();
  const controls = createMonitorControls(f.store, { now: () => clock });
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { [agent]: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });
  f.put({ id: "original", agent, session_id: randomUUID() }, "failed");
  const command = input("original", "in_progress", "failed");
  const lock = path.join(f.workspace, "repository-mcp.lock");
  writeJson(lock, { pid: process.pid });
  controls.submit(command);
  await controls.jobs();
  const file = path.join(f.root, "controls", "manual", `${command.id}.json`);
  const waiting = readJson(file);
  assert.match(waiting.detail, /Waiting for repository MCP operation/);
  clock += 1000;
  await controls.jobs();
  assert.deepEqual(readJson(file), waiting, "An unchanged wait must not create another journal update");
  unlinkSync(lock);
  writeJson(path.join(f.workspace, "application.json"), { ready: true, ownerPid: process.pid });
  await controls.jobs();
  const application = readJson(file);
  assert.match(application.detail, /Waiting for application lifecycle/);
  assert.equal(application.updatedAt, new Date(clock).toISOString());
  writeJson(path.join(f.workspace, "application.json"), { ready: false });
  clock += 1000;
  await controls.jobs();
  assert.equal(readJson(file).status, "submitted");
  assert.equal(readJson(file).updatedAt, new Date(clock).toISOString());
  assert.equal(readJson(path.join(f.root, "controls", "requests", `${command.id}.json`)).taskId, "original");
});

test("native input recovery preserves reviewer ownership and uncertain-delivery holds", async t => {
  const f = setup(t), agent = "software-engineer-2";
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { [agent]: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });
  for (const phase of ["stopping", "cleanup_blocked", "ended"]) {
    f.put({ id: phase, agent, session_id: randomUUID(), runner_metadata: { runner: "pr-updater" },
      interaction: { phase, messages: [{ id: randomUUID(), text: "Continue", status: "queued" },
        { id: randomUUID(), text: "Uncertain", status: "delivery_uncertain" }] } }, "failed");
  }
  f.put({ id: "review", agent, session_id: randomUUID(), runner_metadata: { runner: "pr-reviewer" },
    interaction: { phase: "ended", messages: [{ id: randomUUID(), text: "Review", status: "queued" }] } }, "failed");
  await f.controls.jobs();
  assert.equal(readdirSync(path.join(f.root, "controls", "manual")).length, 0);
  assert.equal(readdirSync(path.join(f.root, "controls", "workspace-holds")).length, 0);
});

for (const status of ["failed", "completed"])
test(`operator messages reach a live provider even after its work item reports ${status}`, async t => {
  const f = setup(t), agent = "software-engineer", session = randomUUID();
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { [agent]: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, taskControl: true, statusControl: true, updatedAt: new Date().toISOString(),
  });
  const provider = { pid: process.pid, token: `spool-provider-${randomUUID()}` };
  f.store.processes = () => [{ Name: "node.exe", CommandLine: `node --acp --log-dir ${provider.token}` }];
  f.put({ id: "original", agent, session_id: session, provider }, status);
  writeJson(path.join(f.workspace, "repository-mcp.lock"), { pid: process.pid });
  const command = { id: randomUUID(), kind: "message", taskId: "original", message: "Finish and yield naturally." };
  f.controls.submit(command);
  assert.equal(readJson(path.join(f.root, "controls", "requests", `${command.id}.json`)).message, command.message);
  assert.equal(readJson(path.join(f.root, "controls", "native-resumes", `${command.id}.json`)).status, "submitted");
  writeJson(path.join(f.root, "controls", "results", `${command.id}.json`), {
    id: command.id, result: { status: "accepted" },
  });
  unlinkSync(path.join(f.root, "controls", "requests", `${command.id}.json`));

  f.put({ id: "original", agent, session_id: session, provider: null }, status);
  const waiting = { ...command, id: randomUUID() };
  f.controls.submit(waiting);
  await f.controls.jobs();
  assert.match(f.controls.receipt(waiting.id).detail, /repository MCP operation/);
  assert.equal(existsSync(path.join(f.root, "controls", "requests", `${waiting.id}.json`)), false);
  f.put({ id: "original", agent, session_id: session, provider }, status);
  await f.controls.jobs();
  assert.equal(readJson(path.join(f.root, "controls", "requests", `${waiting.id}.json`)).message, waiting.message);
  assert.equal(f.store.task("original").session_id, session);
  assert.equal(f.store.task("original").status, status, "The native owner commits its own state transition");
});

test("runner-prepared reviewer continuation publishes under its existing admission and live MCP lease", async t => {
  const f = setup(t), session = randomUUID();
  f.put({ id: "original-review", agent: "pr-reviewer", session_id: session }, "failed");
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { "pr-reviewer": { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });
  writeJson(path.join(f.root, "controls", "capabilities.json"), { version: 1, interactive: true,
    taskControl: true, statusControl: true, preparedMessageVersion: 1, updatedAt: new Date().toISOString() });
  writeJson(path.join(f.workspace, "repository-mcp.lock"), { pid: process.pid });
  let verified = 0;
  const controls = createMonitorControls(f.store, { verifyNativePreparation: async prepared => {
    assert.deepEqual(prepared, f.preparation);
    verified++;
  } });
  const command = { id: randomUUID(), kind: "message", taskId: "original-review", message: "Review this exact PR.",
    metadata: { agent: "pr-reviewer", workspace: f.workspace, sessionId: session,
      expectedUpdatedAt: f.store.task("original-review").updated_at,
      metadata: { runner: "pr-reviewer", preparation: f.preparation } } };
  await withAdmission(f.root, "pr-reviewer", () => controls.submitPreparedMessage(command), f.workspace);
  assert.equal(verified, 1);
  assert.deepEqual(readJson(path.join(f.root, "controls", "requests", `${command.id}.json`)).metadata, command.metadata);
  assert.equal(existsSync(path.join(f.root, "controls", "native-resumes", `${command.id}.json`)), false);
  assert.equal(f.store.task("original-review").status, "failed", "Only the native engine commits the continuation");
  const rejected = createMonitorControls(f.store, { verifyNativePreparation: async () => {
    throw new Error("Preparation changed");
  } });
  const stale = { ...command, id: randomUUID() };
  await assert.rejects(rejected.submitPreparedMessage(stale), /Preparation changed/);
  assert.equal(existsSync(path.join(f.root, "controls", "requests", `${stale.id}.json`)), false);
});

test("runner-prepared engineering update uses existing admission and verifies its original session and conflicted revision", async t => {
  const f = setup(t), session = randomUUID(), agent = "software-engineer-2";
  f.put({ id: "original-fix", agent, session_id: session }, "completed");
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { [agent]: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });
  writeJson(path.join(f.root, "controls", "capabilities.json"), { version: 1, interactive: true,
    taskControl: true, statusControl: true, preparedMessageVersion: 1, updatedAt: new Date().toISOString() });
  const preparation = { ...f.preparation, merge: { conflicted: true },
    execution: { kind: "codespace", purpose: "engineering" } };
  let verified = 0;
  const controls = createMonitorControls(f.store, { verifyEngineeringPreparation: async value => {
    assert.deepEqual(value, preparation);
    verified++;
  } });
  const command = { id: randomUUID(), kind: "message", taskId: "original-fix", message: "Resolve this PR.",
    metadata: { agent, workspace: f.workspace, sessionId: session,
      expectedUpdatedAt: f.store.task("original-fix").updated_at,
      metadata: { runner: "pr-updater", preparation } } };
  await withAdmission(f.root, agent, () => controls.submitPreparedMessage(command), f.workspace);
  assert.equal(verified, 1);
  assert.equal(existsSync(path.join(f.root, "controls", "native-resumes", `${command.id}.json`)), false);
  assert.deepEqual(readJson(path.join(f.root, "controls", "requests", `${command.id}.json`)).metadata, command.metadata);
  for (const change of [{ sessionId: "wrong-session" }, { expectedUpdatedAt: "stale" }, { workspace: path.join(f.root, "other") }]) {
    const changed = { ...command, id: randomUUID(), metadata: { ...command.metadata, ...change } };
    await assert.rejects(controls.submitPreparedMessage(changed), /must preserve/);
    assert.equal(existsSync(path.join(f.root, "controls", "requests", `${changed.id}.json`)), false);
  }
  const stale = { ...command, id: randomUUID() };
  const rejected = createMonitorControls(f.store, { verifyEngineeringPreparation: async () => {
    throw new Error("Prepared Codespace branch or working revision changed");
  } });
  await assert.rejects(rejected.submitPreparedMessage(stale), /revision changed/);
  assert.equal(existsSync(path.join(f.root, "controls", "requests", `${stale.id}.json`)), false);
});

test("queued engineering update cannot adopt the next PR's prepared branch", async t => {
  const f = setup(t), agent = "software-engineer-2";
  f.put({ id: "old-fix", agent, session_id: randomUUID() }, "completed");
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { [agent]: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });

  writeJson(path.join(f.root, "controls", "capabilities.json"), { version: 1, interactive: true,
    taskControl: true, statusControl: true, preparedMessageVersion: 1, updatedAt: new Date().toISOString() });
  const preparation = { ...f.preparation, execution: { kind: "codespace", purpose: "engineering" } };
  writeJson(path.join(f.workspace, "preparation.json"), { ...preparation, branch: "another-pr" });
  const command = { id: randomUUID(), kind: "message", taskId: "old-fix", message: "Fix original PR.",
    metadata: { workspace: f.workspace, metadata: { runner: "pr-updater", preparation } } };
  f.controls.submit(command);
  await f.controls.jobs();
  assert.match(f.controls.receipt(command.id).result.error, /Prepared review changed/);
  assert.equal(existsSync(path.join(f.root, "controls", "requests", `${command.id}.json`)), false);
});
test("native engine accepts the prepared update before the updater releases its existing admission", async t => {
  const f = fixture(t), agent = "software-engineer-2", session = randomUUID();
  f.put({ id: "original-fix", agent, session_id: session, workspace: f.root }, "completed");
  writeJson(path.join(f.root, "spool.json"), {
    version: 1, defaultModel: "fixture-model",
    copilotProviders: { [agent]: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });
  const processControls = nativeControls(t, f.root);
  const preparation = { ...f.preparation, execution: { kind: "codespace", purpose: "engineering" } };
  const key = "prepared-conflict-fix";
  const command = { id: randomUUID(), kind: "message", taskId: "original-fix", message: "Resolve existing PR.",
    metadata: { key, agent, workspace: f.workspace, sessionId: session,
      expectedUpdatedAt: f.store.task("original-fix").updated_at,
      metadata: { runner: "pr-updater", preparation,
        workspaceMigration: { reason: "assigned_agent_workspace", previousWorkspace: f.root, assignedWorkspace: f.workspace },
        contract: { submissionId: key, identifier: "original-fix",
        agent, cwd: f.workspace, branch: preparation.branch, fingerprint: "conflict-v1" } } } };
  const controls = createMonitorControls(f.store, { verifyEngineeringPreparation: async () => {} });
  await withAdmission(f.root, agent, async () => {
    await controls.submitPreparedMessage(command);
    processControls();
    assert.equal(controls.receipt(command.id).result.status, "accepted", JSON.stringify(controls.receipt(command.id)));
    const task = f.store.task("original-fix");
    assert.equal(task.session_id, session);
    assert.equal(task.workspace, f.workspace);
    assert.equal(task.runner_metadata.key, key);
    assert.equal(task.status, "incoming");
  }, f.workspace);
});

test("queued reviewer input never adopts another PR's preparation", async t => {
  const f = setup(t);
  f.put({ id: "old-review", agent: "pr-reviewer", session_id: randomUUID() }, "failed");
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { "pr-reviewer": { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });
  writeJson(path.join(f.root, "controls", "capabilities.json"), { version: 1, interactive: true,
    taskControl: true, statusControl: true, preparedMessageVersion: 1, updatedAt: new Date().toISOString() });
  const preparation = { ...f.preparation, prId: 1, leaseToken: "original-lease" };
  writeJson(path.join(f.workspace, "preparation.json"), { ...preparation, prId: 2 });
  const command = { id: randomUUID(), kind: "message", taskId: "old-review", message: "Review PR 1.",
    metadata: { metadata: { runner: "pr-reviewer", preparation } } };
  f.controls.submit(command);
  await f.controls.jobs();
  assert.match(f.controls.receipt(command.id).result.error, /Prepared review changed/);
  assert.equal(existsSync(path.join(f.root, "controls", "requests", `${command.id}.json`)), false);
});

test("cold native messages durably wait for MCP preparation and automatically hand off without another operator action", async t => {
  const f = setup(t), session = randomUUID();
  f.put({ id: "original", agent: "software-engineer", session_id: session }, "failed");
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { "software-engineer": { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });
  writeJson(path.join(f.root, "controls", "capabilities.json"), { version: 1, interactive: true,
    taskControl: true, statusControl: true, preparedMessageVersion: 1, updatedAt: new Date().toISOString() });
  const lock = path.join(f.workspace, "repository-mcp.lock");
  writeJson(lock, { pid: process.pid });
  const controls = createMonitorControls(f.store, { prepare: () => assert.fail("Native setup belongs to repository MCP") });
  const command = { id: randomUUID(), kind: "message", taskId: "original", message: "Correct the production implementation." };
  controls.submit(command);
  assert.equal(existsSync(path.join(f.root, "controls", "manual", `${command.id}.json`)), false,
    "Already-loaded legacy controllers must not consume new native continuation jobs");
  await controls.jobs();
  assert.equal(controls.receipt(command.id).status, "waiting");
  assert.match(controls.receipt(command.id).detail, /repository MCP operation/);
  const request = path.join(f.root, "controls", "requests", `${command.id}.json`);
  assert.equal(existsSync(request), false);
  unlinkSync(lock);
  const restarted = createMonitorControls(f.store, { prepare: () => assert.fail("Do not repeat setup after readiness") });
  await restarted.jobs();
  assert.equal(restarted.receipt(command.id).status, "submitted");
  const delivered = readJson(request);
  assert.equal(delivered.taskId, command.taskId);
  assert.equal(delivered.message, command.message);
  assert.equal(delivered.metadata, undefined, "Plain operator messages must not become prepared runner envelopes");
  assert.equal(f.store.task("original").session_id, session);
  await restarted.jobs();
  assert.deepEqual(readJson(request), delivered);
  const envelope = { key: "original-feedback", agent: "software-engineer", workspace: f.workspace,
    sessionId: session, expectedUpdatedAt: f.store.task("original").updated_at,
    metadata: { runner: "original-runner", preparation: f.preparation } };
  const prepared = { ...command, id: randomUUID(), metadata: envelope };
  restarted.submit(prepared);
  await restarted.jobs();
  assert.deepEqual(readJson(path.join(f.root, "controls", "requests", `${prepared.id}.json`)).metadata, envelope,
    "Prepared runner continuations must preserve the native envelope rather than flattening it");
});

for (const kind of ["status", "message"]) {
  test(`native ${kind} recovery waits for a live application lifecycle before admitting the original task`, async t => {
    const f = setup(t), session = kind === "message" ? randomUUID() : null;
    f.put({ id: "original", agent: "perf", session_id: session }, "failed");
    writeJson(path.join(f.root, "spool.json"), {
      copilotProviders: { perf: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
    });
    writeJson(path.join(f.root, "controls", "capabilities.json"), { version: 1, interactive: true,
      taskControl: true, statusControl: true, updatedAt: new Date().toISOString() });
    const application = path.join(f.workspace, "application.json");
    const owner = { ready: true, ownerPid: process.pid };
    writeJson(application, owner);
    const controls = createMonitorControls(f.store, { prepare: () => assert.fail("Native setup belongs to repository MCP") });
    const command = kind === "status" ? input("original", "in_progress", "failed")
      : { id: randomUUID(), kind, taskId: "original", message: "Continue the original work." };
    controls.submit(command);
    await controls.jobs();
    assert.equal(controls.receipt(command.id).status, "waiting");
    assert.match(controls.receipt(command.id).detail, /application lifecycle/);
    const request = path.join(f.root, "controls", "requests", `${command.id}.json`);
    assert.equal(existsSync(request), false);
    assert.deepEqual(readJson(application), owner);
    unlinkSync(application);
    await controls.jobs();
    assert.equal(controls.receipt(command.id).status, "submitted");
    assert.equal(readJson(request).taskId, "original");
    assert.equal(f.store.task("original").session_id, session);
  });
}

test("cold native messages serialize behind a live task while messages to that running task remain immediate", async t => {
  const f = setup(t);
  f.put({ id: "queued", agent: "software-engineer", session_id: randomUUID() }, "failed");
  f.put({ id: "running", agent: "software-engineer", session_id: randomUUID() }, "in_progress");
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { "software-engineer": { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });
  writeJson(path.join(f.root, "controls", "capabilities.json"), { version: 1, interactive: true,
    taskControl: true, statusControl: true, preparedMessageVersion: 1, updatedAt: new Date().toISOString() });
  const command = { id: randomUUID(), kind: "message", taskId: "queued", message: "Next original task." };
  f.controls.submit(command);
  await f.controls.jobs();
  assert.equal(f.controls.receipt(command.id).status, "waiting");
  const hot = { ...command, id: randomUUID(), taskId: "running", message: "Continue the current work." };
  f.controls.submit(hot);
  assert.equal(readJson(path.join(f.root, "controls", "requests", `${hot.id}.json`)).message, hot.message);
  unlinkSync(path.join(f.root, "queues", "in_progress", "running.json"));
  await f.controls.jobs();
  assert.equal(f.controls.receipt(command.id).status, "submitted");
});

test("queued operator input follows its original session when the PR updater resumes it first", async t => {
  const f = setup(t), session = randomUUID();
  f.put({ id: "original", agent: "software-engineer", session_id: session }, "failed");
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { "software-engineer": { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });
  writeJson(path.join(f.root, "controls", "capabilities.json"), { version: 1, interactive: true,
    taskControl: true, statusControl: true, updatedAt: new Date().toISOString() });
  const command = { id: randomUUID(), kind: "message", taskId: "original", message: "Publish the production correction." };
  f.controls.submit(command);
  f.put({ id: "original", agent: "software-engineer", session_id: session }, "in_progress");
  await f.controls.jobs();
  assert.equal(f.controls.receipt(command.id).status, "submitted");
  assert.equal(readJson(path.join(f.root, "controls", "requests", `${command.id}.json`)).message, command.message);
  assert.equal(f.store.task("original").session_id, session);
});

for (const status of ["in_progress", "failed"])
for (const change of ["registered workspace", "other workspace", "other session"]) {
  test(`queued native input recognizes ${change} while its task is ${status}`, async t => {
    const f = setup(t), session = randomUUID(), configFile = path.join(f.root, "engineering.json");
    const provider = { command: process.execPath,
      args: [path.join(f.root, "codespaces", "copilot.mjs"), "--config", configFile],
      workingDirectory: "/workspaces/1JS" };
    writeJson(configFile, { purpose: "engineering", remoteRoot: provider.workingDirectory, workspace: f.workspace });
    writeJson(path.join(f.root, "spool.json"), { copilotProviders: { "software-engineer": provider } });
    writeJson(path.join(f.root, "controls", "capabilities.json"), { version: 1, interactive: true,
      taskControl: true, statusControl: true, updatedAt: new Date().toISOString() });
    f.put({ id: "original", agent: "software-engineer", workspace: f.root, session_id: session,
      session_config: { provider } }, "failed");
    const command = { id: randomUUID(), kind: "message", taskId: "original", message: "Publish the original correction." };
    f.controls.submit(command);
    f.put({ id: "original", agent: "software-engineer",
      workspace: change === "other workspace" ? path.join(f.root, "unrelated") : f.workspace,
      session_id: change === "other session" ? randomUUID() : session,
      session_config: { provider } }, status);
    await f.controls.jobs();
    const receipt = f.controls.receipt(command.id);
    assert.equal(receipt.result?.status ?? receipt.status, change === "registered workspace" ? "submitted" : "failed");
    assert.equal(existsSync(path.join(f.root, "controls", "requests", `${command.id}.json`)),
      change === "registered workspace");
  });
}

test("prepared reviewer restart retains its runner lease and bypasses redundant preparation", async t => {
  const f = setup(t), prId = 123;
  const prepared = { ...f.preparation, prId, leaseToken: "verified-owner",
    execution: { kind: "codespace" } };
  f.put({ id: "prepared-review", agent: "pr-reviewer", session_id: null,
    runner_metadata: { runner: "pr-reviewer", preparation: prepared } }, "failed");
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { "pr-reviewer": { command: process.execPath, args: [] } },
  });
  let verified = 0;
  const controls = createMonitorControls(f.store, {
    prepare: () => assert.fail("Canonical preparation is already runner-owned"),
    verifyNativePreparation: async value => { assert.deepEqual(value, prepared); verified++; },
    readiness: { ensure: () => assert.fail("Never reprepare a verified restart"),
      releaseIdle: async () => {}, dispose: async () => {} },
  });
  const command = input("prepared-review", "in_progress", "failed");
  await controls.submitPreparedReviewerRestart(command, prepared);
  await controls.jobs();
  assert.equal(verified, 1);
  assert.equal(f.store.task("prepared-review").status, "failed", "Only the normal daemon changes task status");
  assert.deepEqual(readJson(path.join(f.root, "controls", "requests", `${command.id}.json`)).metadata.preparation, prepared);
  assert.equal(readJson(path.join(f.root, "controls", "manual", `${command.id}.json`)).status, "submitted");
  assert.equal(readJson(path.join(f.root, "controls", "workspace-holds", `${command.id}.json`)).ready, true);
});

test("prepared reviewer restart rejects changed revisions, live owners and changed tasks", async t => {
  for (const change of ["revision", "live owner", "during verification"]) {
    const f = setup(t), prepared = { ...f.preparation, prId: 123, execution: { kind: "codespace" } };
    f.put({ id: "pinned-review", agent: "pr-reviewer", session_id: null,
      ...(change === "live owner" ? { provider: { token: "live", pid: 123 } } : {}),
      runner_metadata: { runner: "pr-reviewer", preparation: prepared } }, "failed");
    writeJson(path.join(f.root, "spool.json"), {
      copilotProviders: { "pr-reviewer": { command: process.execPath, args: [] } },
    });
    const controls = createMonitorControls(f.store, {
      verifyNativePreparation: async () => {
        assert.equal(change, "during verification");
        f.put({ ...f.store.task("pinned-review"), updated_at: "2026-11-10T00:00:00Z" }, "failed");
      },
    });
    const command = input("pinned-review", "in_progress", "failed");
    await assert.rejects(controls.submitPreparedReviewerRestart(command,
      change === "revision" ? { ...prepared, commit: "b".repeat(40) } : prepared),
    /exact PR revision|changed while its preparation/);
    assert.equal(existsSync(path.join(f.root, "controls", "requests", `${command.id}.json`)), false);
  }
});

test("native reviewer restart freshly verifies and records its existing canonical preparation", async t => {
  const f = setup(t);
  f.put({ id: "review-startup", agent: "pr-reviewer", session_id: null }, "failed");
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { "pr-reviewer": { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });
  const configFile = path.join(f.root, "review-config.json");
  writeJson(configFile, { purpose: "review" });
  const prepared = { ...f.preparation, execution: { kind: "codespace", configFile } };
  writeJson(path.join(f.workspace, "preparation.json"), prepared);
  let verified = 0;
  const controls = createMonitorControls(f.store, {
    prepare: () => assert.fail("Reviewer restart must reuse its owned MCP preparation"),
    verifyNativePreparation: async value => { assert.deepEqual(value, prepared); verified++; },
  });
  const command = input("review-startup", "in_progress", "failed");
  controls.submit(command);
  await controls.jobs();
  assert.equal(verified, 1);
  assert.deepEqual(readJson(path.join(f.root, "controls", "requests", `${command.id}.json`)).metadata.preparation, prepared);
});

test("native reviewer restart waits through an in-flight receipt before verifying or publishing admission", async t => {
  const f = setup(t), configFile = path.join(f.root, "review-config.json");
  f.put({ id: "waiting-review", agent: "pr-reviewer", session_id: randomUUID() }, "failed");
  writeJson(configFile, { purpose: "review" });
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { "pr-reviewer": { command: process.execPath, args: ["--config", configFile],
      workingDirectory: "/workspaces/1JS" } },
  });
  const receiptFile = path.join(f.workspace, "preparation.json");
  writeJson(receiptFile, { ready: false, stage: "exact-revision-setup-and-build" });
  let verified = 0;
  const controls = createMonitorControls(f.store, {
    prepare: () => assert.fail("Only the dedicated runner prepares this reviewer"),
    verifyNativePreparation: async value => { assert.equal(value.ready, true); verified++; },
  });
  const command = input("waiting-review", "incoming", "failed");
  controls.submit(command);
  await controls.jobs();
  assert.equal(verified, 0);
  assert.equal(controls.receipt(command.id).status, "waiting");
  assert.equal(existsSync(path.join(f.root, "controls", "requests", `${command.id}.json`)), false);
  assert.equal(existsSync(path.join(f.root, "controls", "workspace-holds", `${command.id}.json`)), false);
  const prepared = { ...f.preparation, execution: { kind: "codespace", configFile } };
  writeJson(receiptFile, prepared);
  await controls.jobs();
  assert.equal(verified, 1);
  assert.deepEqual(readJson(path.join(f.root, "controls", "requests", `${command.id}.json`)).metadata.preparation, prepared);
});

test("native manual creation uses control storage without local repository preparation", async t => {
  const f = setup(t);
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { perf: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });
  const controls = createMonitorControls(f.store, { prepare: () => assert.fail("Native tasks must not run local preparation") });
  const command = { id: randomUUID(), kind: "create", agent: "perf", title: "Native task", prompt: "Original work" };
  controls.submit(command);
  await controls.jobs();
  const request = readJson(path.join(f.root, "controls", "requests", `${command.id}.json`));
  assert.equal(request.workspace, f.root);
  assert.equal(request.prompt, renderSpoolTaskPrompt(command.prompt, command.agent));
  assert.equal(request.metadata.preparation, undefined);
  assert.equal(controls.receipt(command.id).status, "submitted");
  assert.throws(() => controls.submit({ ...command, id: randomUUID(), workspace: "isolated" }), /local isolation/);
});

test("native reopening preserves the original workspace and never prepares its old local checkout", async t => {
  const f = setup(t);
  mkdirSync(path.join(f.workspace, ".git"));
  f.put({ id: "original", agent: "software-engineer", session_id: randomUUID() }, "failed");
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { "software-engineer": { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });
  const controls = createMonitorControls(f.store, { prepare: () => assert.fail("Old local source must remain untouched") });
  const command = input("original", "incoming", "failed");
  controls.submit(command);
  await controls.jobs();
  const request = readJson(path.join(f.root, "controls", "requests", `${command.id}.json`));
  assert.equal(request.taskId, "original");
  assert.equal(request.workspace, f.workspace);
  assert.equal(request.metadata.preparation, undefined);
  assert.equal(f.store.task("original").status, "failed", "Native engine retains authority over session admission and queue moves");
});

for (const kind of ["status", "message"])
for (const purpose of ["engineering", "review"])
test(`native ${purpose} ${kind} staging restores its control directory before admission`, t => {
  const f = setup(t), workspace = path.join(f.root, "missing-native-control");
  const configFile = path.join(f.root, "vm.json"), session = randomUUID();
  const provider = { command: process.execPath,
    args: [path.join(f.root, "codespaces", "copilot.mjs"), "--config", configFile],
    workingDirectory: "/workspaces/1JS" };
  writeJson(configFile, { purpose, workspace, remoteRoot: provider.workingDirectory });
  writeJson(path.join(f.root, "spool.json"), { copilotProviders: { perf: provider } });
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, statusControl: true, updatedAt: new Date().toISOString(),
  });
  f.put({ id: "original-native", agent: "perf", workspace, session_id: session,
    session_config: { provider } }, "failed");
  const command = kind === "message"
    ? { id: randomUUID(), kind, taskId: "original-native", message: "Continue with native commands." }
    : input("original-native", "in_progress", "failed");
  f.controls.stage(command);
  assert.equal(existsSync(workspace), true, "Connection staging must not wait for a monitor job or provider startup");
  assert.deepEqual(readdirSync(workspace), [], "Do not manufacture preparation or a local checkout");
  rmdirSync(workspace);
  f.controls.stage(command);
  assert.equal(existsSync(workspace), true, "Retrying an existing command repairs missing control storage too");
  assert.equal(f.store.task(command.taskId).session_id, session);
});

for (const mismatch of ["workspace", "provider", "local-session"])
test(`native staging never recreates unregistered control storage: ${mismatch}`, t => {
  const f = setup(t), workspace = path.join(f.root, "missing-native-control");
  const configFile = path.join(f.root, "vm.json");
  const provider = { command: process.execPath,
    args: [path.join(f.root, "codespaces", "copilot.mjs"), "--config", configFile],
    workingDirectory: "/workspaces/1JS" };
  writeJson(configFile, { purpose: "engineering", remoteRoot: provider.workingDirectory,
    workspace: mismatch === "workspace" ? path.join(f.root, "another-control") : workspace });
  writeJson(path.join(f.root, "spool.json"), { copilotProviders: { perf: provider } });
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, updatedAt: new Date().toISOString(),
  });
  const saved = mismatch === "local-session" ? null
    : mismatch === "provider" ? { ...provider, args: [] } : provider;
  f.put({ id: "original-native", agent: "perf", workspace, session_id: randomUUID(),
    session_config: { provider: saved } }, "failed");
  f.controls.stage({ id: randomUUID(), kind: "message", taskId: "original-native", message: "Continue." });
  assert.equal(existsSync(workspace), false);
  assert.equal(existsSync(path.join(f.root, "another-control")), false);
});

for (const kind of ["status", "message"])
for (const registered of [true, false])
test(`native ${kind} restores missing control storage only for its registered workspace: ${registered}`, async t => {
  const f = setup(t), workspace = path.join(f.root, "missing-native-control");
  const configFile = path.join(f.root, "engineering-config.json"), session = randomUUID();
  writeJson(configFile, { purpose: "engineering", remoteRoot: "/workspaces/1JS",
    workspace: registered ? workspace : path.join(f.root, "another-control") });
  writeJson(path.join(f.root, "spool.json"), {
    copilotProviders: { perf: { command: process.execPath, args: ["--config", configFile],
      workingDirectory: "/workspaces/1JS" } },
  });
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, statusControl: true, messageContinuationVersion: 1,
    updatedAt: new Date().toISOString(),
  });
  f.put({ id: "original-native", agent: "perf", workspace, session_id: session }, "failed");
  const controls = createMonitorControls(f.store, {
    prepare: () => assert.fail("Restoring control storage must never reset or prepare remote source"),
  });
  const command = kind === "message"
    ? { id: randomUUID(), kind, taskId: "original-native", message: "Push the verified commit." }
    : input("original-native", "in_progress", "failed");
  controls.submit(command);
  await controls.jobs();
  assert.equal(existsSync(workspace), registered);
  const request = readJson(path.join(f.root, "controls", "requests", `${command.id}.json`));
  if (registered) {
    assert.equal(request.taskId, "original-native");
    assert.equal(request.workspace, workspace);
    assert.equal(controls.receipt(command.id).status, "submitted");
    assert.equal(existsSync(path.join(workspace, "preparation.json")), false, "Never fabricate preparation");
    assert.equal(existsSync(path.join(workspace, ".git")), false);
  } else {
    assert.equal(request, null);
    assert.match(controls.receipt(command.id).result.error, /Original task workspace is unavailable/);
  }
  assert.equal(f.store.task("original-native").session_id, session);
});

test("creation works without interactive chat and preserves the assigned reviewer's posting instructions", async t => {
  const f = setup(t);
  assert.equal(f.controls.options().taskEnabled, true);
  assert.equal(f.controls.options().enabled, false);
  const command = { id: randomUUID(), kind: "create", agent: "pr-reviewer",
    title: "Review requested work", prompt: "The complete original assignment.", workspace: "isolated" };
  const submitted = f.controls.submit(command);
  assert.equal(f.controls.submit(command).taskId, submitted.taskId);
  await f.controls.jobs();
  const request = readJson(path.join(f.root, "controls", "requests", `${command.id}.json`));
  assert.equal(request.agent, "pr-reviewer");
  assert.equal(request.taskId, submitted.taskId);
  assert.ok(existsSync(request.workspace));
  assert.match(request.prompt, /^The complete original assignment\./);
  assert.equal(request.prompt, command.prompt);
  assert.doesNotMatch(request.prompt, /Do not post PR comments|Work item history/);
  assert.equal(f.controls.receipt(command.id).status, "submitted");
  assert.equal(f.store.task(submitted.taskId), null, "Only the native daemon creates the task");
});

test("assignment is available without live chat and rejects invalid or paused handoffs", t => {
  const f = setup(t);
  f.put({ id: "one", agent: "perf" }, "incoming");
  f.put({ id: "past", agent: "perf" }, "completed");
  const command = { id: randomUUID(), kind: "handoff", taskId: "one",
    agent: "software-engineer", message: "Assigned from the Tasks view." };
  f.controls.submit(command);
  assert.equal(f.store.task("one").agent, "perf", "Only the daemon changes assignment");
  assert.equal(readJson(path.join(f.root, "controls", "requests", `${command.id}.json`)).agent, "software-engineer");
  assert.throws(() => f.controls.submit({ ...command, id: randomUUID(), taskId: "past" }), /Reopen/);
  assert.throws(() => f.controls.submit({ ...command, id: randomUUID(), agent: "perf" }), /already owns/);
  mkdirSync(path.join(f.root, "controls", "paused"), { recursive: true });
  writeFileSync(path.join(f.root, "controls", "paused", "software-engineer"), "operator");
  assert.throws(() => f.controls.submit({ ...command, id: randomUUID() }), /paused/);
});

test("board controls keep exactly four statuses and reject stale, paused and unsupported actions", t => {
  const f = setup(t);
  f.put({ id: "one", agent: "perf" }, "failed");
  assert.equal(f.controls.options().statusEnabled, true);
  assert.equal(f.controls.options().enabled, false);
  for (const status of ["todo", "blocked", "backlog", "done", "cancelled", "in_review"]) {
    assert.throws(() => f.controls.submit(input("one", status, "failed")), /Unknown/);
  }
  assert.throws(() => f.controls.submit(input("one", "completed", "incoming")), /state changed/);
  assert.throws(() => f.controls.submit({ ...input("one", "completed", "failed"), metadata: {} }), /Invalid operator action/);
  assert.throws(() => f.controls.submit({ id: randomUUID(), kind: "interrupt", taskId: "one" }), /not online/);
  mkdirSync(path.join(f.root, "controls", "paused"), { recursive: true });
  writeFileSync(path.join(f.root, "controls", "paused", "perf"), "operator");
  assert.throws(() => f.controls.submit(input("one", "incoming", "failed")), /paused/);
});

test("moving a running card requests native stop without prematurely moving queue files", t => {
  const f = setup(t);
  f.put({ id: "one", session_id: randomUUID() }, "in_progress");
  const command = input("one", "completed", "in_progress");
  f.controls.submit(command);
  f.controls.submit(command);
  assert.equal(f.store.task("one").status, "in_progress");
  const request = readJson(path.join(f.root, "controls", "requests", `${command.id}.json`));
  assert.equal(request.status, "completed");
  assert.equal(request.expectedStatus, "in_progress");
  assert.throws(() => f.controls.submit({ ...command, status: "failed" }), /reused/);
});

test("reopening an isolated task retains original identity, waits for ownership, and journals preparation", async t => {
  const f = setup(t), session = randomUUID();
  f.put({ id: "one", agent: "perf", session_id: session, prompt: "Original instructions" }, "failed");
  f.put({ id: "other", agent: "perf" }, "in_progress");
  const command = input("one", "incoming", "failed");
  f.controls.submit(command);
  await f.controls.jobs();
  assert.equal(f.controls.receipt(command.id).status, "waiting");
  assert.equal(existsSync(path.join(f.root, "controls", "requests", `${command.id}.json`)), false);
  const { unlinkSync } = await import("node:fs");
  unlinkSync(path.join(f.root, "queues", "in_progress", "other.json"));
  await f.controls.jobs();
  const request = readJson(path.join(f.root, "controls", "requests", `${command.id}.json`));
  assert.equal(request.taskId, "one");
  assert.equal(request.metadata.dashboardPrepared, true);
  assert.equal(f.store.task("one").session_id, session);
  assert.equal(f.store.task("one").prompt, "Original instructions");
  assert.equal(f.store.task("one").status, "failed", "Only the daemon owns queue transitions");
});

test("board writes require same-origin JSON and current token, and survive renderer restart via command identity", async t => {
  const f = setup(t);
  f.put({ id: "one" }, "completed");
  const client = { request: async message => message.operation === "options" ? f.controls.options()
    : message.operation === "submit" ? f.controls.submit(message.input) : f.controls.receipt(message.command) };
  async function request(handler, url, method = "GET", headers = {}, input) {
    let response;
    await handler({ url, method, headers, body: input && JSON.stringify(input) },
      { writeHead(code) { response = { code }; }, end(body) { response.body = body; } });
    return response;
  }
  const handler = createMonitorHandler(client);
  const token = JSON.parse((await request(handler, "/api/monitor/control-options")).body).token;
  const command = input("one", "failed", "completed");
  const headers = { host: "127.0.0.1:8261", origin: "http://127.0.0.1:8261", "content-type": "application/json", "x-spool-token": token };
  assert.equal((await request(handler, "/api/monitor/control", "POST", { ...headers, origin: "https://evil.invalid" }, command)).code, 403);
  assert.equal((await request(handler, "/api/monitor/control", "POST", headers, command)).code, 202);
  const restarted = createMonitorHandler(client);
  assert.equal((await request(restarted, "/api/monitor/control", "POST", headers, command)).code, 403);
  headers["x-spool-token"] = JSON.parse((await request(restarted, "/api/monitor/control-options")).body).token;
  assert.equal((await request(restarted, "/api/monitor/control", "POST", headers, command)).code, 202);
});
