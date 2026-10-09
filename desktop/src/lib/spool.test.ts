import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { countCompletedSpoolItems, readSpoolItems, spoolQueues } from "./spool";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const actual = await vi.importActual<typeof fs>("node:fs/promises");
let root: string;
const file = (status: string, id = "TASK-1") => join(root, "queues", status, `${id}.json`);
async function task(status: string, id = "TASK-1", fields: Record<string, unknown> = {}) {
  await fs.writeFile(file(status, id), JSON.stringify({ id, title: `Title ${id}`, status, ...fields }));
}
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "spool-board-"));
  await Promise.all(spoolQueues.map(({ id }) => fs.mkdir(join(root, "queues", id), { recursive: true })));
  vi.mocked(fs.readFile).mockReset().mockImplementation(actual.readFile);
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true }); });

it("reads every live queue using directory status and exposes only display fields", async () => {
  for (const { id } of spoolQueues) await task(id, id, { status: "incoming", prompt: "PRIVATE PROMPT", cost: { total_cost_usd: 1 } });
  await fs.mkdir(join(root, "queues", ".runner-archive"));
  await fs.writeFile(join(root, "queues", ".runner-archive", "old.json"), "{broken");
  await fs.writeFile(join(root, "queues", "incoming", "pending.tmp"), "{broken");
  const items = await readSpoolItems(root);
  expect(items).toHaveLength(4);
  for (const { id } of spoolQueues) expect(items).toContainEqual({ id, title: `Title ${id}`, status: id });
  expect(JSON.stringify(items)).not.toMatch(/PRIVATE|prompt|cost/);
});
it("returns an empty board only for genuinely empty queues and honors SPOOL_ROOT", async () => {
  vi.stubEnv("SPOOL_ROOT", root); expect(await readSpoolItems()).toEqual([]);
  await task("failed"); expect(await readSpoolItems()).toEqual([{ id: "TASK-1", title: "Title TASK-1", status: "failed" }]);
});
it("includes assigned agents as display metadata but never exposes task instructions", async () => {
  await task("incoming", "TASK-1", { agent: "engineer", prompt: "PRIVATE PROMPT" });
  expect(await readSpoolItems(root)).toEqual([{ id: "TASK-1", title: "Title TASK-1", status: "incoming", agent: "engineer" }]);
  await task("incoming", "TASK-1", { agent: 123 });
  await expect(readSpoolItems(root)).rejects.toThrow("Invalid Spool agent");
});
it("does not serve stale data after a file changes or changes queues", async () => {
  await task("incoming"); await readSpoolItems(root);
  await task("incoming", "TASK-1", { title: "Updated title" });
  await fs.rename(file("incoming"), file("completed"));
  expect(await readSpoolItems(root)).toEqual([{ id: "TASK-1", title: "Updated title", status: "completed" }]);
});
it("reuses unchanged display records but detects in-place edits, including timestamps", async () => {
  await task("completed", "TASK-1", { updated_at: "2026-10-01T10:00:00Z" });
  await readSpoolItems(root);
  // Windows may finalize ctime after the first read of a newly written file.
  await readSpoolItems(root);
  vi.mocked(fs.readFile).mockClear();
  expect((await readSpoolItems(root))[0].updatedAt).toBe("2026-10-01T10:00:00Z");
  expect(fs.readFile).not.toHaveBeenCalled();
  await task("completed", "TASK-1", { updated_at: "2026-10-01T11:00:00Z" });
  expect((await readSpoolItems(root))[0].updatedAt).toBe("2026-10-01T11:00:00Z");
  expect(fs.readFile).toHaveBeenCalledOnce();
});
it("rejects malformed JSON rather than silently hiding a work item", async () => {
  await fs.writeFile(file("incoming"), "{broken");
  await expect(readSpoolItems(root)).rejects.toThrow("Invalid Spool JSON: TASK-1.json");
});
it.each([{ id: "WRONG" }, { title: null }, { title: " " }])("rejects invalid identity or title: %s", async (fields) => {
  await task("incoming", "TASK-1", fields);
  await expect(readSpoolItems(root)).rejects.toThrow("Invalid Spool identity or title");
});
it("rejects duplicate live records and missing queue directories", async () => {
  await task("incoming"); await task("completed");
  await expect(readSpoolItems(root)).rejects.toThrow("exists in multiple queues: TASK-1");
  await fs.rmdir(join(root, "queues", "failed"));
  await expect(readSpoolItems(root)).rejects.toMatchObject({ code: "ENOENT" });
});
it("retries a file that atomically moves before it can be opened", async () => {
  await task("incoming");
  vi.mocked(fs.readFile).mockImplementationOnce(async (...args) => {
    await fs.rename(file("incoming"), file("in_progress")); return actual.readFile(...args);
  });
  expect(await readSpoolItems(root)).toEqual([{ id: "TASK-1", title: "Title TASK-1", status: "in_progress" }]);
});
it("rescans when a transition would otherwise leave a stale or missing item", async () => {
  await task("incoming");
  vi.mocked(fs.readFile).mockImplementationOnce(async (...args) => {
    const text = await actual.readFile(...args); await fs.rename(file("incoming"), file("completed")); return text;
  });
  expect(await readSpoolItems(root)).toEqual([{ id: "TASK-1", title: "Title TASK-1", status: "completed" }]);
});
it("bounds retries instead of hiding a continuously changing queue", async () => {
  await task("incoming");
  vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error("Moved"), { code: "ENOENT" }));
  await expect(readSpoolItems(root)).rejects.toThrow("Spool queues kept changing");
  expect(fs.readFile).toHaveBeenCalledTimes(3);
});
it("counts successful tasks with no task payload reads, ignoring archive, temp files and directories", async () => {
  await task("completed", "DONE-1"); await task("failed", "FAILED-1");
  await fs.writeFile(join(root, "queues", "completed", "pending.tmp"), "{broken");
  await fs.mkdir(join(root, "queues", "completed", "folder.json"));
  await fs.mkdir(join(root, "queues", ".runner-archive"));
  await fs.writeFile(join(root, "queues", ".runner-archive", "old.json"), '{"status":"completed"}');
  expect(await countCompletedSpoolItems(root)).toBe(1);
  expect(fs.readFile).not.toHaveBeenCalled();
  await task("incoming", "DONE-2"); await fs.rename(file("incoming", "DONE-2"), file("completed", "DONE-2"));
  expect(await countCompletedSpoolItems(root)).toBe(2);
  await fs.unlink(file("completed", "DONE-1"));
  expect(await countCompletedSpoolItems(root)).toBe(1);
});
it("keeps Home's count errors explicit when its completed queue is missing", async () => {
  await fs.rmdir(join(root, "queues", "completed"));
  await expect(countCompletedSpoolItems(root)).rejects.toMatchObject({ code: "ENOENT" });
});
