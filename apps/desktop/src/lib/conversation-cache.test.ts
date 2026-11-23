import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, rename, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConversation } from "./spool-conversation";
import { monitorConversation } from "../../backend/conversation-reader.mjs";

const reads = vi.hoisted(() => ({ readSync: vi.fn(), readFileSync: vi.fn(), fstatSync: vi.fn(), openSync: vi.fn(), mkdirSync: vi.fn() }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, ...reads };
});
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
let root: string;
const task = { id: "one", title: "One", agent: "fixture", prompt: "Fixture", updated_at: "2026-11-03T00:00:00Z",
  provider: { token: "PRIVATE_ONE" } };
const event = (text: string) => JSON.stringify({ type: "assistant.message", data: { content: text } }) + "\n";
const read = (id = "one") => readConversation(root, id, null, true);
beforeEach(async () => {
  reads.readSync.mockReset().mockImplementation(actual.readSync);
  reads.readFileSync.mockReset().mockImplementation(actual.readFileSync);
  reads.fstatSync.mockReset().mockImplementation(actual.fstatSync);
  reads.openSync.mockReset().mockImplementation(actual.openSync);
  reads.mkdirSync.mockReset().mockImplementation(actual.mkdirSync);
  root = await mkdtemp(join(tmpdir(), "spool-conversation-cache-"));
  for (const directory of ["agents", "logs", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, "queues", "in_progress", "one.json"), JSON.stringify(task));
  await writeFile(join(root, "controls", "capabilities.json"),
    JSON.stringify({ version: 1, interactive: true, updatedAt: new Date().toISOString() }));
  await writeFile(join(root, "logs", "one.log"), event("Original"));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("reuses unchanged windows without sharing mutable entries or rereading task payloads twice", async () => {
  await read(); await read();
  reads.readSync.mockClear(); reads.readFileSync.mockClear(); reads.mkdirSync.mockClear();
  const first = await read();
  first.entries[0].text = "Changed by caller";
  const next = await read();
  expect(next.entries[0].text).toBe("Original");
  expect(reads.readSync).not.toHaveBeenCalled();
  expect(reads.readFileSync.mock.calls.filter(([file]) => file === join(root, "queues", "in_progress", "one.json"))).toHaveLength(0);
  expect(reads.mkdirSync).not.toHaveBeenCalled();
});
it("parses only appended or rewritten raw log events while keeping cached projections private", async () => {
  const file = join(root, "logs", "one.log");
  let source = Array.from({ length: 1000 }, (_, index) => event(`event-${index}`)).join("");
  await writeFile(file, source);
  const store = { root, task: () => ({ ...task, status: "in_progress" }) };
  monitorConversation(store, "one", null, true)!.entries[0].text = "Caller mutation";
  const parse = vi.spyOn(JSON, "parse");
  try {
    source += event("Appended"); await appendFile(file, event("Appended"));
    const updated = monitorConversation(store, "one", null, true)!;
    expect(parse).toHaveBeenCalledOnce();
    expect(updated.entries).toHaveLength(1001);
    expect(updated.entries[0].text).toBe("event-0");
    expect(updated.entries.at(-1)!.text).toBe("Appended");
    source = source.replace('"event-500"', '"rewrite-x"');
    await writeFile(file, source);
    expect(monitorConversation(store, "one", null, true)!.entries[500].text).toBe("rewrite-x");
    expect(parse).toHaveBeenCalledTimes(2);
    await writeFile(file, event("Rotated"));
    expect(monitorConversation(store, "one", null, true)!.entries.map(entry => entry.text)).toEqual(["Rotated"]);
  } finally { parse.mockRestore(); }
});
it("invalidates appends, same-size rewrites, replacement files and deletion", async () => {
  const file = join(root, "logs", "one.log");
  await read();
  await appendFile(file, event("Appended"));
  expect((await read()).entries.map(entry => entry.text)).toEqual(["Original", "Appended"]);
  await writeFile(file, event("Replaced"));
  expect((await read()).entries.map(entry => entry.text)).toEqual(["Replaced"]);
  await writeFile(file, event("SameSize"));
  expect((await read()).entries[0].text).toBe("SameSize");
  const before = await read();
  await rename(file, `${file}.old`);
  await writeFile(file, event("SameSize"));
  expect((await read()).logId).not.toBe(before.logId);
  await rm(file);
  const missing = await read();
  expect(missing.available).toBe(false); expect(missing.entries).toEqual([]);
});
it("keeps live state and lease redaction fresh when only the task changes", async () => {
  await writeFile(join(root, "logs", "one.log"), JSON.stringify({ type: "tool.execution_complete",
    data: { toolCallId: "tool", success: true, result: "PRIVATE_ONE and PRIVATE_TWO" } }) + "\n");
  expect(JSON.stringify(await read())).not.toContain("PRIVATE_ONE");
  await read(); reads.readSync.mockClear();
  await writeFile(join(root, "queues", "in_progress", "one.json"),
    JSON.stringify({ ...task, title: "Updated", provider: { token: "PRIVATE_TWO" }, interaction: { paused: true } }));
  const next = await read();
  expect(next.task.title).toBe("Updated"); expect(next.activity).toBe("waiting");
  expect(JSON.stringify(next)).not.toContain("PRIVATE_TWO");
  expect(reads.readSync).not.toHaveBeenCalled();
});
it("separates pagination and rendering modes and waits for complete UTF-8 records", async () => {
  const file = join(root, "logs", "one.log");
  const lines = Array.from({ length: 180 }, (_, index) => event(`${index} \u00e9 ${"x".repeat(2000)}`));
  await writeFile(file, lines.join(""));
  const latest = await read(), older = await readConversation(root, "one", latest.nextBefore, true);
  expect([...older.entries, ...latest.entries]).toHaveLength(180);
  expect(new Set([...older.entries, ...latest.entries].map(entry => entry.id)).size).toBe(180);
  expect((await read()).entries).toEqual(latest.entries);
  await writeFile(file, JSON.stringify({ type: "assistant.message_delta", data: { content: "Hello" } }) + "\n"
    + JSON.stringify({ type: "assistant.message_delta", data: { content: " world" } }));
  expect((await read()).entries).toHaveLength(1);
  await appendFile(file, "\n");
  expect((await read()).entries).toHaveLength(2);
  expect((await readConversation(root, "one")).entries).toMatchObject([{ text: "Hello world" }]);
  await expect(readConversation(root, "one", latest.nextBefore, true)).rejects.toMatchObject({ status: 409 });
});
it("does not cache a window that changes while it is being read", async () => {
  reads.fstatSync.mockImplementationOnce(actual.fstatSync).mockImplementationOnce((file: number) => {
    const stat = actual.fstatSync(file, { bigint: true });
    return { ...stat, mtimeNs: stat.mtimeNs + 1n };
  });
  await read(); reads.readSync.mockClear();
  expect((await read()).entries[0].text).toBe("Original");
  expect(reads.readSync).toHaveBeenCalledOnce();
});
it("evicts old windows instead of retaining every opened transcript", async () => {
  for (let index = 0; index < 9; index++) {
    const id = `task-${index}`;
    await writeFile(join(root, "queues", "in_progress", `${id}.json`), JSON.stringify({ ...task, id }));
    await writeFile(join(root, "logs", `${id}.log`), event(id));
    await read(id); await read(id);
  }
  reads.readSync.mockClear();
  await read("task-8");
  expect(reads.readSync).not.toHaveBeenCalled();
  await read("task-0");
  expect(reads.readSync).toHaveBeenCalledOnce();
});
it("still checks access permissions instead of serving cached data after an open failure", async () => {
  await read(); await read();
  reads.openSync.mockImplementationOnce(() => { throw Object.assign(new Error("Denied"), { code: "EACCES" }); });
  await expect(read()).rejects.toMatchObject({ code: "EACCES" });
});
