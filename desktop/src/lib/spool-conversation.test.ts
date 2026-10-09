import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it } from "vitest";
import { readConversation, sendTaskMessage } from "./spool-conversation";

let root: string;
const control = (...parts: string[]) => join(root, "controls", ...parts);
const task = { id: "one", title: "One task", agent: "engineer", prompt: "Original instructions.",
  created_at: "2026-09-30T10:00:00Z", updated_at: "2026-09-30T10:00:00Z", provider: { token: "PRIVATE_LEASE" } };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spool-chat-unit-"));
  for (const folder of ["agents", "logs", "controls", ...["incoming", "in_progress", "completed", "failed"].map((name) => join("queues", name))]) {
    await mkdir(join(root, folder), { recursive: true });
  }
  await writeFile(join(root, "agents", "engineer.md"), "# Engineer");
  await writeFile(join(root, "queues", "incoming", "one.json"), JSON.stringify(task));
  await writeFile(control("capabilities.json"), JSON.stringify({ version: 1, interactive: true, updatedAt: new Date().toISOString() }));
});
afterEach(async () => { await rm(root, { force: true, recursive: true }); });
it("uses the canonical reader to assemble deltas, hide leases and ignore incomplete JSON", async () => {
  const event = (type: string, content: string) => JSON.stringify({ type, timestamp: task.created_at, data: { content } }) + "\n";
  await writeFile(join(root, "logs", "one.log"), event("assistant.message_delta", "Hello ") + event("assistant.message_delta", "world")
    + event("assistant.message", "Hello world!") + '{"type":"assistant.message"');
  const result = await readConversation(root, "one");
  expect(result.entries).toMatchObject([{ kind: "assistant", text: "Hello world!", delta: false }]);
  expect(result.canSend).toBe(true);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_LEASE");
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
it("publishes native message commands only and waits for actual daemon acceptance", async () => {
  const id = randomUUID(), message = "Keep **these exact instructions**.";
  const pending = sendTaskMessage(root, "one", { id, message });
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(control("requests", `${id}.json`), "utf8")); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
  }).toMatchObject({ id, taskId: "one", kind: "message", message });
  await writeFile(control("results", `${id}.json`), JSON.stringify({ id, result: { status: "accepted" } }));
  expect(await pending).toEqual({ id, state: "accepted" });
  expect(await readdir(control("manual"))).toEqual([]);
  await rm(control("capabilities.json"));
  expect(await sendTaskMessage(root, "one", { id, message })).toEqual({ id, state: "accepted" });
  await expect(sendTaskMessage(root, "one", { id, message: "Changed" })).rejects.toMatchObject({ status: 409 });
});
it("reports native rejection without successful-looking acceptance", async () => {
  const id = randomUUID(), pending = sendTaskMessage(root, "one", { id, message: "Follow up" });
  const rejection = expect(pending).rejects.toThrow("Workspace no longer owned");
  await expect.poll(() => readdir(control("requests"))).toContain(`${id}.json`);
  await writeFile(control("results", `${id}.json`), JSON.stringify({ id, result: { status: "failed", error: "Workspace no longer owned" } }));
  await rejection;
});
it("keeps historical and offline tasks readable without permitting sends", async () => {
  await rm(control("capabilities.json"));
  expect((await readConversation(root, "one")).readOnlyReason).toBe("Spool is offline.");
  await expect(sendTaskMessage(root, "one", { id: randomUUID(), message: "Hello" })).rejects.toMatchObject({ status: 409 });
  await rm(join(root, "queues", "incoming", "one.json"));
  await writeFile(join(root, "queues", "completed", "one.json"), JSON.stringify(task));
  expect((await readConversation(root, "one")).readOnlyReason).toBe("Spool is offline.");
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
it("rejects unsafe identities, invalid pagination and message bodies before publication", async () => {
  await expect(readConversation(root, "../elsewhere")).rejects.toMatchObject({ status: 400 });
  await expect(readConversation(root, "one", -1)).rejects.toMatchObject({ status: 400 });
  for (const input of [{ id: randomUUID(), message: "" }, { id: randomUUID(), message: "x".repeat(65537) },
    { id: randomUUID(), message: "Hello", kind: "create" }, { id: "../outside", message: "Hello" }]) {
    await expect(sendTaskMessage(root, "one", input)).rejects.toMatchObject({ status: 400 });
  }
  expect(await readdir(control())).toEqual(["capabilities.json"]);
});
