import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertTurnPrompt } from "./turn-prompt-check.mjs";
import { startBackendFixture } from "./protocol-fixture.mjs";
test("packaged backend reads local projects, rejects unknown routes, and shuts down with its parent", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "spool-desktop-"));
  for (const folder of ["agents", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"]) {
    mkdirSync(path.join(root, folder), { recursive: true });
  }
  writeFileSync(path.join(root, "projects.json"), JSON.stringify({ version: 1, projects: [] }));
  const { child, waiting, ready, request, stop } = startBackendFixture(root);
  t.after(async () => {
    await stop();
    rmSync(root, { recursive: true, force: true });
  });
  await ready;
  assert.deepEqual((await request("/api/desktop/page")).body.page, { kind: "setup" });
  assert.equal((await request("/api/does-not-exist")).status, 404);
  assert.equal((await request("/api/projects", "DELETE")).status, 405);
  const result = await request("/api/projects", "POST", JSON.stringify({ name: "Fixture" }));
  assert.equal(result.status, 201, JSON.stringify(result));
  assert.equal((await request("/api/desktop/page")).body.redirect, `/${result.body.id}`);
  const library = await request("/api/projects", "POST", JSON.stringify({ name: "Library" }));
  assert.equal(library.status, 201);
  const projects = JSON.parse(readFileSync(path.join(root, "projects.json"), "utf8")).projects;
  writeFileSync(path.join(projects.find(project => project.id === library.body.id).root, "agents", "designer.md"), "# Shared designer");
  writeFileSync(path.join(projects.find(project => project.id === result.body.id).root, "controls", "capabilities.json"),
    JSON.stringify({ sharedPromptsVersion: 1, updatedAt: new Date().toISOString() }));
  const source = `/api/projects/${library.body.id}/agents/designer`;
  const target = `/api/projects/${result.body.id}/agents/designer`;
  const preview = await request(source);
  assert.equal(preview.status, 200);
  assert.equal((await request(`/api/projects/${result.body.id}/agent-import`)).status, 404);
  const copied = await request(`/api/projects/${result.body.id}/agent-copy`, "POST", JSON.stringify({
    name: "designer", sourceProject: library.body.id, sourceAgent: "designer",
    revision: preview.body.revision,
  }));
  assert.equal(copied.status, 201, JSON.stringify(copied));
  assert.equal(copied.body.copied, true);
  assert.equal((await request(target)).body.prompt, "# Shared designer");
  await assertTurnPrompt(request, target, result.body.id);
  assert.deepEqual((await request(`/api/desktop/page?path=/${result.body.id}/agents/designer`)).body.page,
    { kind: "agent", agent: "designer", jobs: { current: [], history: [] } });
  assert.deepEqual((await request(`/api/desktop/page?deferAgentJobs=1&path=/${result.body.id}/agents/designer`)).body.page,
    { kind: "agent", agent: "designer", jobs: { current: [], history: [] } });
  assert.deepEqual((await request(`/api/desktop/page?deferAgentJobs=2&path=/${result.body.id}/agents/designer`)).body.page,
    { kind: "agent", agent: "designer" });
  assert.deepEqual((await request(`${target}/jobs`)).body, { current: [], history: [] });
  assert.equal((await request(`/api/projects/${result.body.id}/agents/missing/jobs`)).status, 404);
  const streamId = randomUUID(), snapshots = [];
  let deliver;
  waiting.set(streamId, frame => {
    if (frame.type === "head") assert.equal(frame.status, 200);
    if (frame.type === "error") assert.fail(frame.error);
    if (frame.type === "end") waiting.delete(streamId);
    if (frame.type !== "chunk") return;
    const text = Buffer.from(frame.body, "base64").toString();
    if (!text.startsWith("data: ")) return;
    snapshots.push(JSON.parse(text.slice(6)));
    deliver?.();
  });
  const nextSnapshot = () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Native activity stream timed out.")), 10000);
    deliver = () => {
      if (!snapshots.length) return;
      clearTimeout(timeout); deliver = undefined; resolve(snapshots.shift());
    };
    deliver();
  });
  child.stdin.write(JSON.stringify({ id: streamId, method: "GET",
    url: `/api/projects/${result.body.id}/live?agent=designer`, headers: [["accept", "text/event-stream"]] }) + "\n");
  assert.deepEqual((await nextSnapshot()).jobs, { agent: "designer", data: { current: [], history: [] } });
  const queued = path.join(projects.find(project => project.id === result.body.id).root, "queues", "incoming", "streamed.json");
  writeFileSync(queued, JSON.stringify({ id: "streamed", title: "Native watched task", agent: "designer" }));
  let activity = await nextSnapshot();
  while (activity.agents.find(agent => agent.id === "designer").pending !== 1) activity = await nextSnapshot();
  assert.equal(activity.agents.find(agent => agent.id === "designer").pending, 1);
  assert.equal(activity.jobs.data.current[0].activity, "pending");
  child.stdin.write(JSON.stringify({ id: streamId, cancel: true }) + "\n");
  rmSync(queued);
  const projectRoot = projects.find(project => project.id === result.body.id).root;
  const mcpConfig = path.join(root, "unregistered-repository.json");
  writeFileSync(mcpConfig, JSON.stringify({ version: 1, repositories: {} }));
  writeFileSync(path.join(projectRoot, "spool.json"), JSON.stringify({
    workspacePreparations: { designer: { repo: "unregistered-fixture", mcpConfig,
      input: { repoRoot: projectRoot, operation: "setup" } } },
  }));
  writeFileSync(path.join(projectRoot, "controls", "capabilities.json"),
    JSON.stringify({ version: 1, taskControl: true, updatedAt: new Date().toISOString() }));
  const requestId = randomUUID(), taskId = `manual-${requestId}`;
  const pending = await request(`/api/projects/${result.body.id}/tasks`, "POST", JSON.stringify({
    requestId, agent: "designer", title: "Required setup", prompt: "Preserve the original instructions.",
  }));
  assert.equal(pending.status, 201, JSON.stringify(pending));
  assert.equal(pending.body.notice, "Queued for workspace preparation");
  const conversationUrl = `/api/projects/${result.body.id}/tasks/${taskId}/conversation`;
  let preparedConversation = await request(conversationUrl);
  assert.equal(preparedConversation.status, 200, JSON.stringify(preparedConversation));
  assert.equal(preparedConversation.body.task.prompt, "Preserve the original instructions.");
  assert.equal(preparedConversation.body.canSend, false);
  assert.ok(["waiting", "failed"].includes(preparedConversation.body.activity));
  assert.equal(readFileSync(path.join(projectRoot, "controls", "ui-submissions", `${requestId}.json`), "utf8")
    .includes('"phase":"preparing"'), true);
  const deadline = Date.now() + 10000;
  while (preparedConversation.body.activity !== "failed" && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    preparedConversation = await request(conversationUrl);
  }
  assert.equal(preparedConversation.body.activity, "failed", JSON.stringify(preparedConversation));
  assert.doesNotMatch(preparedConversation.body.task.error, /Copilot ACP/);
  assert.equal(existsSync(path.join(projectRoot, "queues", "incoming", `${taskId}.json`)), false);
  const recoveryTask = "connection-probe", messageId = randomUUID(), at = new Date().toISOString();
  const recoveryId = createHash("sha256").update(`native-operator-resume:${recoveryTask}:${messageId}:${at}`)
    .digest("hex").slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  writeFileSync(path.join(projectRoot, "controls", "capabilities.json"), JSON.stringify({
    version: 1, interactive: true, messageContinuationVersion: 1, updatedAt: at,
  }));
  const failedFile = path.join(projectRoot, "queues", "failed", `${recoveryTask}.json`);
  writeFileSync(failedFile, JSON.stringify({
    id: recoveryTask, agent: "designer", title: "Connection recovery", prompt: "Keep my conversation",
    status: "failed", session_id: "fixture", created_at: at, updated_at: at,
    error: "Copilot ACP startup failed: Connection reset by peer: Copilot ACP closed its output",
    interaction: { messages: [{ id: messageId, text: "Continue safely", status: "queued", created_at: at }] },
  }));
  mkdirSync(path.join(projectRoot, "controls", "manual"), { recursive: true });
  writeFileSync(path.join(projectRoot, "controls", "manual", `${recoveryId}.json`), JSON.stringify({
    request: { kind: "status", taskId: recoveryTask, agent: "designer" }, status: "waiting",
    retryAt: new Date(Date.now() + 60_000).toISOString(),
  }));
  mkdirSync(path.join(projectRoot, "logs"), { recursive: true });
  writeFileSync(path.join(projectRoot, "logs", `${recoveryTask}.log`), JSON.stringify({
    type: "user.message", data: { content: "Continue safely", messageId }, timestamp: at,
  }) + "\n");
  const reconnecting = await request(`/api/projects/${result.body.id}/tasks/${recoveryTask}/conversation?events=1`);
  assert.equal(reconnecting.status, 200);
  assert.equal(reconnecting.body.connection.message, "Reconnecting to your Codespace. Your messages are saved.");
  assert.equal(reconnecting.body.activity, "waiting");
  assert.equal(reconnecting.body.canSend, true);
  assert.equal(reconnecting.body.task.error, null);
  assert.equal(reconnecting.body.task.interaction.messages[0].status, "queued");
  assert.equal(reconnecting.body.entries[0].messageId, messageId);
  assert.match(readFileSync(failedFile, "utf8"), /Copilot ACP startup failed/);
  rmSync(path.join(projectRoot, "controls", "capabilities.json"));
  const offlineId = randomUUID(), offlineInput = JSON.stringify({ id: offlineId, message: "Save this during reconnection." });
  const messagesUrl = `/api/projects/${result.body.id}/tasks/${recoveryTask}/conversation`;
  const queuedMessage = await request(messagesUrl, "POST", offlineInput);
  assert.equal(queuedMessage.status, 200, JSON.stringify(queuedMessage));
  assert.deepEqual(queuedMessage.body, { id: offlineId, state: "queued" });
  assert.deepEqual((await request(messagesUrl, "POST", offlineInput)).body, queuedMessage.body);
  const offlineConversation = (await request(messagesUrl)).body;
  assert.equal(offlineConversation.canSend, true);
  assert.equal(offlineConversation.task.interaction.messages.filter(message => message.id === offlineId).length, 1);
  assert.equal(existsSync(path.join(projectRoot, "controls", "requests", `${offlineId}.json`)), false);
  assert.equal((await request(`${target}?scope=context`)).status, 400);
  const saved = await request(source, "PUT", JSON.stringify({ ...preview.body, prompt: "Updated shared designer" }));
  assert.equal(saved.status, 200);
  assert.equal((await request(target)).body.prompt, "# Shared designer");
  assert.equal((await request(source, "DELETE")).status, 204);
  assert.equal((await request(target)).body.prompt, "# Shared designer");
  const removed = await request(`/api/projects/${result.body.id}`, "DELETE");
  assert.equal(removed.status, 200);
  assert.equal(removed.body.nextProject, library.body.id);
  assert.equal((await request("/api/desktop/page")).body.redirect, `/${library.body.id}`);
  assert.doesNotMatch(readFileSync(path.join(projects.find(project => project.id === result.body.id).root, "agents", "designer.md"), "utf8"), /shared_prompt/);
  assert.equal((await request(`/api/projects/${library.body.id}`, "DELETE")).body.nextProject, null);
  assert.deepEqual((await request("/api/desktop/page")).body.page, { kind: "setup" });
  assert.equal((await request(`https://example.com`)).error, "Invalid desktop operation.");
});
