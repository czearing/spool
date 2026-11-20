import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it } from "vitest";
import { readConversation, sendTaskMessage } from "./spool-conversation";
import { publishJson } from "./spool-publish";
import { applicationPaths, configureApplication } from "./application-paths";

let root: string;
const control = (...parts: string[]) => join(root, "controls", ...parts);
const task = { id: "one", title: "One task", agent: "engineer", prompt: "Original instructions.",
  created_at: "2026-09-30T10:00:00Z", updated_at: "2026-09-30T10:00:00Z", provider: { token: "PRIVATE_LEASE" } };
beforeEach(async () => {
  if (!process.env.SPOOL_TEST_PACKAGED_RUNNERS)
    configureApplication({ ...applicationPaths(), resources: resolve("..", "packages") });
  root = await mkdtemp(join(tmpdir(), "spool-chat-unit-"));
  for (const folder of ["agents", "logs", "controls", ...["incoming", "in_progress", "completed", "failed"].map((name) => join("queues", name))]) {
    await mkdir(join(root, folder), { recursive: true });
  }
  await writeFile(join(root, "agents", "engineer.md"), "# Engineer");
  await writeFile(join(root, "queues", "incoming", "one.json"), JSON.stringify(task));
  await writeFile(control("capabilities.json"), JSON.stringify({ version: 1, interactive: true, updatedAt: new Date().toISOString() }));
});
afterEach(async () => { await rm(root, { force: true, recursive: true }); });
it("keeps explicit uncertain-delivery resolution idempotent alongside the durable message outbox", async () => {
  const id = randomUUID(), messageId = randomUUID();
  await writeFile(control("capabilities.json"), JSON.stringify({
    version: 1, interactive: true, messageRecoveryVersion: 1, updatedAt: new Date().toISOString(),
  }));
  const file = join(root, "queues", "in_progress", "one.json");
  const original = JSON.stringify({ ...task, interaction: { messages: [
    { id: messageId, text: "Earlier input", status: "delivery_uncertain", created_at: "2026-09-30T10:00:00Z" },
  ] } });
  await writeFile(file, original);
  await mkdir(control("results"), { recursive: true });
  await writeFile(control("results", `${id}.json`), JSON.stringify({ result: { status: "accepted" } }));
  const input = { id, messageId, decision: "dismiss" };
  await expect(sendTaskMessage(root, "one", input)).resolves.toEqual({ id, state: "accepted" });
  const command = JSON.parse(await readFile(control("commands", `${id}.json`), "utf8"));
  expect(command.request).toMatchObject({ kind: "resolve_message", taskId: "one", metadata: { messageId, decision: "dismiss" } });
  await expect(sendTaskMessage(root, "one", input)).resolves.toEqual({ id, state: "accepted" });
  await expect(sendTaskMessage(root, "one", { ...input, decision: "retry" })).rejects.toMatchObject({ status: 409 });
  expect(await readFile(file, "utf8")).toBe(original);
});
it("acknowledges durable queueing immediately without claiming daemon acceptance", async () => {
  const id = randomUUID(), message = "Keep **these exact instructions**.";
  const started = Date.now();
  expect(await sendTaskMessage(root, "one", { id, message })).toEqual({ id, state: "queued" });
  expect(Date.now() - started).toBeLessThan(2000);
  expect(JSON.parse(await readFile(control("requests", `${id}.json`), "utf8")))
    .toMatchObject({ id, taskId: "one", kind: "message", message });
  expect((await readConversation(root, "one")).task.interaction?.messages)
    .toMatchObject([{ id, text: message, status: "queued" }]);
  await publishJson(control("results", `${id}.json`), { id, result: { status: "accepted" } });
  expect(await readdir(control("manual"))).toEqual([]);
  await rm(control("capabilities.json"));
  expect(await sendTaskMessage(root, "one", { id, message })).toEqual({ id, state: "accepted" });
  await expect(sendTaskMessage(root, "one", { id, message: "Changed" })).rejects.toMatchObject({ status: 409 });
});
it("publishes a follow-up without opening or projecting its conversation log", async () => {
  await mkdir(join(root, "logs", "one.log"));
  const id = randomUUID();
  expect(await sendTaskMessage(root, "one", { id, message: "Keep going" })).toEqual({ id, state: "queued" });
  expect(await readdir(control("requests"))).toContain(`${id}.json`);
});
it("reconciles retries of a lost response and delayed receipts into one durable message", async () => {
  const id = randomUUID(), input = { id, message: "Do not duplicate" };
  await sendTaskMessage(root, "one", input);
  expect(await sendTaskMessage(root, "one", input)).toEqual({ id, state: "queued" });
  expect((await readConversation(root, "one")).task.interaction?.messages).toHaveLength(1);
  await publishJson(control("results", `${id}.json`), { result: { status: "accepted" } });
  expect(await sendTaskMessage(root, "one", input)).toEqual({ id, state: "accepted" });
  expect((await readdir(control("requests"))).sort()).toEqual([`${id}-interrupt.json`, `${id}.json`].sort());
});
it("reports native rejection without successful-looking acceptance", async () => {
  const id = randomUUID();
  await sendTaskMessage(root, "one", { id, message: "Follow up" });
  await publishJson(control("results", `${id}.json`), { id, result: { status: "failed", error: "Workspace no longer owned" } });
  expect((await readConversation(root, "one")).task.interaction?.messages)
    .toMatchObject([{ id, status: "failed", error: "Workspace no longer owned" }]);
  await expect(sendTaskMessage(root, "one", { id, message: "Follow up" })).rejects.toMatchObject({ rejected: true });
});
it("does not authorize a new message identity after a partially persisted native command", async () => {
  const id = randomUUID(), input = { id, message: "Do not duplicate" };
  await sendTaskMessage(root, "one", input);
  await writeFile(join(root, "queues", "incoming", "one.json"),
    JSON.stringify({ ...task, interaction: { applied_requests: [id] } }));
  await publishJson(control("results", `${id}.json`), { id, result: { status: "failed", error: "Queue move failed" } });
  await expect(sendTaskMessage(root, "one", input)).rejects.toMatchObject({ rejected: false });
});
it("saves offline messages without publishing unsupported daemon requests", async () => {
  await rm(control("capabilities.json"));
  expect((await readConversation(root, "one")).canSend).toBe(true);
  const id = randomUUID();
  expect(await sendTaskMessage(root, "one", { id, message: "Hello" })).toEqual({ id, state: "queued" });
  expect(await readdir(control("requests"))).toEqual([]);
  expect((await readConversation(root, "one")).task.interaction?.messages).toMatchObject([{ id, status: "queued" }]);
  expect((await readConversation(root, "one")).connection?.message).toContain("reconnecting");
  await rm(join(root, "queues", "incoming", "one.json"));
  await writeFile(join(root, "queues", "completed", "one.json"), JSON.stringify(task));
  expect((await readConversation(root, "one")).readOnlyReason).toContain("No saved session");
  await expect(readConversation(root, "missing")).rejects.toMatchObject({ status: 404 });
});
it("enables completed-session messaging only when the daemon supports native continuation", async () => {
  await rm(join(root, "queues", "incoming", "one.json"));
  const file = join(root, "queues", "completed", "one.json");
  await writeFile(file, JSON.stringify({ ...task, session_id: "persisted-session" }));
  expect((await readConversation(root, "one")).readOnlyReason).toBe("Update Spool to resume this conversation.");
  await writeFile(control("capabilities.json"), JSON.stringify({ version: 1, interactive: true,
    messageContinuationVersion: 1, updatedAt: new Date().toISOString() }));
  expect((await readConversation(root, "one")).canSend).toBe(true);
  await writeFile(file, JSON.stringify(task));
  expect((await readConversation(root, "one")).readOnlyReason).toBe("No saved session is available for this conversation.");
});
it("routes ended native conversations through the runner's original-session admission exactly once", async () => {
  const id = randomUUID(), input = { id, message: "Continue the original work." };
  await rm(join(root, "queues", "incoming", "one.json"));
  await writeFile(join(root, "queues", "failed", "one.json"), JSON.stringify({
    ...task, provider: null, workspace: root, session_id: "saved-native-session", status: "failed",
  }));
  await writeFile(join(root, "spool.json"), JSON.stringify({
    copilotProviders: { engineer: { command: process.execPath, args: [] } },
  }));
  await writeFile(control("capabilities.json"), JSON.stringify({ version: 1, interactive: true,
    messageContinuationVersion: 1, updatedAt: new Date().toISOString() }));
  const pending = sendTaskMessage(root, "one", input);
  const file = control("native-resumes", `${id}.json`);
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
  }).toMatchObject({ request: { id, taskId: "one", agent: "engineer", workspace: root, message: input.message },
    sessionId: "saved-native-session", expectedStatus: "failed", status: "waiting" });
  expect(await readdir(control("requests"))).toEqual([]);
  expect(await pending).toEqual({ id, state: "queued" });
  await publishJson(control("results", `${id}.json`), { id, result: { status: "accepted" } });
  expect(await sendTaskMessage(root, "one", input)).toEqual({ id, state: "accepted" });
  expect(await readdir(control("native-resumes"))).toEqual([`${id}.json`]);
});
it("rejects unsafe identities, invalid pagination and message bodies before publication", async () => {
  await expect(readConversation(root, "../elsewhere")).rejects.toMatchObject({ status: 400 });
  await expect(readConversation(root, "one", -1)).rejects.toMatchObject({ status: 400 });
  for (const input of [{ id: randomUUID(), message: "" }, { id: randomUUID(), message: "x".repeat(65537) },
    { id: randomUUID(), message: "Hello", kind: "create" }, { id: "../outside", message: "Hello" }]) {
    await expect(sendTaskMessage(root, "one", input)).rejects.toMatchObject({ status: 400 });
  }
  expect(await readdir(control())).toEqual(["capabilities.json"]);
});
