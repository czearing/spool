import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { readConversation, sendTaskMessage } from "./spool-conversation";
import { publishJson } from "./spool-publish";
import { applicationPaths, configureApplication } from "./application-paths";
import * as receipts from "./message-receipts";

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
it("rereads proven delivery before projecting a conversation served by an older daemon", async () => {
  const file = join(root, "queues", "incoming", "one.json");
  const message = { id: randomUUID(), text: "Original input", status: "delivery_uncertain", created_at: task.created_at };
  await writeFile(file, JSON.stringify({ ...task, interaction: { messages: [message] } }));
  const reconcile = vi.spyOn(receipts, "reconcileMessageReceipts").mockImplementationOnce(async () => {
    await writeFile(file, JSON.stringify({ ...task, interaction: { messages: [{ ...message, status: "delivered" }] } }));
    return true;
  });
  try {
    const result = await readConversation(root, "one");
    expect(result.recoveryAvailable).toBe(false);
    expect(result.task.interaction?.messages).toEqual([{ ...message, status: "delivered" }]);
    expect(result.task.prompt).toBe(task.prompt);
  } finally { reconcile.mockRestore(); }
});
it("uses the canonical reader to assemble deltas, hide leases and ignore incomplete JSON", async () => {
  const event = (type: string, content: string) => JSON.stringify({ type, timestamp: task.created_at, data: { content } }) + "\n";
  await writeFile(join(root, "logs", "one.log"), event("assistant.message_delta", "Hello ") + event("assistant.message_delta", "world")
    + event("assistant.message", "Hello world!") + '{"type":"assistant.message"');
  const result = await readConversation(root, "one");
  expect(result.entries).toMatchObject([{ kind: "assistant", text: "Hello world!", delta: false }]);
  expect(result.canSend).toBe(true);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_LEASE");
});
it.each([false, true])("does not retime historical messages when task metadata changes (raw=%s)", async raw => {
  const timestamp = "2026-09-30T10:01:00Z";
  await writeFile(join(root, "logs", "one.log"), [
    { type: "assistant.message", data: { content: "Undated reply" } },
    { type: "tool.execution_start", data: { toolCallId: "done", toolName: "task_complete",
      arguments: { summary: "Undated completion" } } },
    { type: "assistant.message", timestamp, data: { content: "Timestamped reply" } },
  ].map(event => JSON.stringify(event) + "\n").join(""));
  const before = await readConversation(root, "one", null, raw);
  await writeFile(join(root, "queues", "incoming", "one.json"), JSON.stringify({
    ...task, updated_at: "2026-09-30T11:00:00Z",
  }));
  const after = await readConversation(root, "one", null, raw);
  expect(after.entries).toEqual(before.entries);
  expect(after.entries.map(entry => entry.ts)).toEqual(["", "", timestamp]);
  await writeFile(join(root, "logs", "one.log"), JSON.stringify({
    type: "assistant.message", timestamp: "2026-09-30T11:01:00Z", data: { content: "New reply" },
  }) + "\n", { flag: "a" });
  expect((await readConversation(root, "one", null, raw)).entries.slice(0, 3)).toEqual(before.entries);
});
it("renders preparation progress and its real failure before a task or provider exists", async () => {
  const requestId = randomUUID(), id = `manual-${requestId}`;
  await mkdir(control("ui-submissions")); await mkdir(control("manual"));
  await writeFile(control("ui-submissions", `${requestId}.json`), JSON.stringify({
    taskId: id, phase: "preparing", task: { ...task, id },
  }));
  const file = control("manual", `${requestId}.json`);
  await writeFile(file, JSON.stringify({ status: "preparing", detail: "Building required packages" }));
  expect(await readConversation(root, id)).toMatchObject({
    task: { id, prompt: task.prompt, status: "incoming" }, activity: "waiting", canSend: false,
    connection: { message: "Building required packages" },
  });
  expect(await readConversation(root, id, null, true)).toMatchObject({
    raw: true, logId: null, task: { id, prompt: task.prompt }, entries: [],
  });
  await writeFile(file, JSON.stringify({ status: "failed", detail: "Required package build failed" }));
  expect(await readConversation(root, id)).toMatchObject({
    task: { id, status: "failed", error: "Required package build failed" }, activity: "failed", canSend: false,
  });
});
for (const recovery of ["message", "startup-message", "chat-start", "empty-restore", "direct-message"])
it(`projects persisted ${recovery} recovery without claiming delivery or exposing stale startup errors`, async () => {
  await rm(join(root, "queues", "incoming", "one.json"));
  const message = { id: randomUUID(), text: "Keep going", status: "queued", created_at: task.created_at };
  const messages = ["chat-start", "empty-restore"].includes(recovery) ? [] : [message];
  const stored = { ...task, status: "failed", session_id: recovery === "chat-start" ? null : "saved-session",
    error: "Copilot ACP startup failed: Connection reset by peer: Copilot ACP closed its output",
    interaction: { messages } };
  const file = join(root, "queues", "failed", "one.json");
  await writeFile(file, JSON.stringify(stored));
  await writeFile(control("capabilities.json"), JSON.stringify({ version: 1, interactive: true,
    messageContinuationVersion: 1, updatedAt: new Date().toISOString() }));
  const key = recovery === "chat-start" ? `native-chat-start:${stored.id}:${stored.updated_at}`
    : recovery === "empty-restore" ? `native-empty-restore:${stored.id}:${stored.session_id}`
      : `native-operator-resume:${stored.id}:${message.id}${recovery === "startup-message" ? `:${stored.updated_at}` : ""}`;
  const id = recovery === "direct-message" ? message.id : createHash("sha256").update(key).digest("hex").slice(0, 32)
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  const directory = recovery === "direct-message" ? "native-resumes" : "manual";
  await mkdir(control(directory), { recursive: true });
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  await writeFile(control(directory, `${id}.json`), JSON.stringify({
    request: { taskId: stored.id, agent: stored.agent }, status: "waiting", retryAt,
  }));
  await writeFile(join(root, "logs", "one.log"), [
    { type: "session.error", data: { message: "[Copilot ACP setup] Checking assigned Codespace" } },
    { type: "session.error", data: { message: "Connection reset by peer" } },
  ].map(event => JSON.stringify(event) + "\n").join(""));
  const pending = await readConversation(root, stored.id);
  expect(pending.connection).toEqual({ message: "Reconnecting to your Codespace. Your messages are saved.", retryAt });
  expect(pending.activity).toBe("waiting");
  expect(pending.task.error).toBeNull();
  expect(pending.task.interaction?.messages).toEqual(messages);
  expect(pending.canSend).toBe(recovery !== "chat-start");
  expect(JSON.stringify(pending.entries)).not.toMatch(/ACP|reset by peer/);
  expect(await readFile(file, "utf8")).toContain("Copilot ACP startup failed");
  await writeFile(file, JSON.stringify({ ...stored, interaction: {
    messages: [{ ...message, status: "delivery_uncertain" }],
  } }));
  expect((await readConversation(root, stored.id)).connection).toBeUndefined();
  await writeFile(file, JSON.stringify(stored));
  await mkdir(control("results"), { recursive: true });
  await writeFile(control("results", `${id}.json`), JSON.stringify({ result: { status: "failed" } }));
  const failed = await readConversation(root, stored.id);
  expect(failed.connection).toBeUndefined();
  expect(failed.activity).toBe("failed");
  expect(failed.task.error).toBe("The connection to the agent was interrupted. Your conversation is saved.");
});
it("reads bounded pages and does not repeat pending live messages in older history", async () => {
  const lines = Array.from({ length: 200 }, (_, index) => JSON.stringify({ type: "assistant.message", timestamp: task.created_at,
    data: { content: `${index}:` + "x".repeat(3000) } }) + "\n");
  await writeFile(join(root, "logs", "one.log"), lines.join(""));
  const latest = await readConversation(root, "one");
  expect(latest.limited).toBe(true); expect(latest.nextBefore).toBeGreaterThan(0);
  const older = await readConversation(root, "one", latest.nextBefore);
  expect(older.activity).toBe("unknown");
  expect(older.entries.at(-1)?.text).not.toBe(latest.entries.at(-1)?.text);
  expect(older.task.interaction?.messages).toEqual([]);
  await expect(readConversation(root, "one", Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({ status: 409 });
});
it("keeps native work, writing, pauses and offline state distinct while exposing redacted tool calls", async () => {
  await rm(join(root, "queues", "incoming", "one.json"));
  const path = join(root, "queues", "in_progress", "one.json");
  await writeFile(path, JSON.stringify({ ...task, interaction: { phase: "running" } }));
  await writeFile(join(root, "logs", "one.log"), JSON.stringify({
    type: "assistant.message_delta", timestamp: task.created_at, data: { content: "Checking the result." },
  }) + "\n");
  expect((await readConversation(root, "one")).activity).toBe("writing");
  await writeFile(join(root, "logs", "one.log"), JSON.stringify({
    type: "tool.execution_start", timestamp: task.created_at, data: { toolCallId: "inspect", toolName: "shell",
      arguments: { description: "Inspect the checkout", token: "PRIVATE_TOOL_PAYLOAD" } },
  }) + "\n", { flag: "a" });
  const working = await readConversation(root, "one");
  expect(working.activity).toBe("working"); expect(JSON.stringify(working)).not.toContain("PRIVATE_TOOL_PAYLOAD");
  expect(working.entries.at(-1)).toMatchObject({ kind: "tool_call", toolUseId: "inspect", name: "shell" });
  expect(working.entries.at(-1)?.input).toContain("Inspect the checkout");
  await writeFile(join(root, "logs", "one.log"), JSON.stringify({
    type: "tool.execution_complete", timestamp: task.created_at, data: { toolCallId: "inspect", success: true,
      result: { content: "Inspected checkout. Internal lease PRIVATE_LEASE" } },
  }) + "\n", { flag: "a" });
  const completed = await readConversation(root, "one");
  expect(completed.entries.at(-1)).toMatchObject({ kind: "tool_result", toolUseId: "inspect", isError: false });
  expect(completed.entries.at(-1)?.content).toContain("Inspected checkout.");
  expect(JSON.stringify(completed)).not.toContain("PRIVATE_LEASE");
  await writeFile(path, JSON.stringify({ ...task, interaction: { phase: "paused", paused: true } }));
  expect((await readConversation(root, "one")).activity).toBe("waiting");
  await rm(control("capabilities.json"));
  expect((await readConversation(root, "one")).activity).toBe("offline");
});
