import { afterEach, beforeEach, expect, it } from "vitest";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolLogReader } from "./tool-log";

let root: string, file: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "spool-tool-log-")); file = join(root, "task.log"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const event = (type: string, id: string, time: number, extra = {}) => JSON.stringify({
  type: `tool.execution_${type}`, timestamp: new Date(time).toISOString(), data: { toolCallId: id, ...extra },
}) + "\n";
const start = (id: string, time = 1000, name = "view") => event("start", id, time, { toolName: name, arguments: "PRIVATE INPUT" });
it("reads complete native events, strips payloads, pairs failures and deduplicates repeated events", async () => {
  const read = createToolLogReader();
  await writeFile(file, "plain output\n" + start("a") + start("a") + event("complete", "a", 2000, { success: false, result: "PRIVATE OUTPUT" })
    + event("complete", "a", 2500) + event("complete", "missing", 2000));
  expect((await read(file)).calls).toEqual([{ name: "view", action: "Description not recorded", startedAt: 1000, endedAt: 2000 }]);
  expect(JSON.stringify(await read(file))).not.toContain("PRIVATE");
});
it("uses canonical tool names, not Copilot tool titles or argument descriptions", async () => {
  const read = createToolLogReader();
  await writeFile(file, event("start", "a", 1000, { toolName: "powershell", toolTitle: "Inspect a private file",
    arguments: { description: "Inspect a private file", command: "PRIVATE" }, turnId: "turn-a", model: "model" })
    + event("start", "b", 2000, { toolName: "powershell", toolTitle: "Run internal checks",
      arguments: { description: "Run internal checks", command: "PRIVATE" }, turnId: "turn-b", model: "model" }));
  expect((await read(file)).calls).toEqual([
    { name: "powershell", action: "Inspect a private file", startedAt: 1000 },
    { name: "powershell", action: "Run internal checks", startedAt: 2000 },
  ]);
});
it("incrementally joins UTF-8 partial lines and shares concurrent reads without counting twice", async () => {
  const read = createToolLogReader(), tail = start("b", 3000, "réad");
  await writeFile(file, start("a") + tail.slice(0, -6));
  expect((await read(file)).calls).toHaveLength(1);
  await appendFile(file, tail.slice(-6) + event("complete", "a", 4000));
  const [a, b] = await Promise.all([read(file), read(file)]);
  expect(a).toEqual(b);
  expect(a.calls).toEqual([
    { name: "view", action: "Description not recorded", startedAt: 1000, endedAt: 4000 },
    { name: "réad", action: "Description not recorded", startedAt: 3000 },
  ]);
  expect(await read(file)).toEqual(a);
});
it("resets on truncation, larger in-place rewrites, atomic replacement and removal", async () => {
  const read = createToolLogReader();
  await writeFile(file, start("old")); await read(file);
  await writeFile(file, start("new") + start("other"));
  expect((await read(file)).calls).toHaveLength(2);
  expect((await read(file)).calls.some((call) => call.endedAt)).toBe(false);
  await writeFile(file, ""); expect((await read(file)).calls).toEqual([]);
  await writeFile(join(root, "next.log"), start("replacement", 5000));
  await rename(join(root, "next.log"), file);
  expect((await read(file)).calls).toEqual([{ name: "view", action: "Description not recorded", startedAt: 5000 }]);
  await rm(file); expect((await read(file)).calls).toEqual([]);
});
it("reports corrupt records explicitly without discarding readable calls or inventing timing", async () => {
  const read = createToolLogReader();
  await writeFile(file, '{"type":"tool.execution_start", broken}\n' + start("readable"));
  expect(await read(file)).toEqual({ available: true, invalidRecords: 1, calls: [{ name: "view", action: "Description not recorded", startedAt: 1000 }] });
  expect((await read(file)).invalidRecords).toBe(1);
  await writeFile(file, start("fixed"));
  expect(await read(file)).toEqual({ available: true, invalidRecords: 0, calls: [{ name: "view", action: "Description not recorded", startedAt: 1000 }] });
});
