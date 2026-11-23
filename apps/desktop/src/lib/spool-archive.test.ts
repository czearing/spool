import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readSpoolArchive } from "./spool-archive";

let root: string, archive: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spool-archive-")); archive = join(root, "queues", ".runner-archive");
});
afterEach(async () => { await rm(root, { recursive: true }); });
async function record(key = "TASK-1-attempt-a.json", fields: Record<string, unknown> = {}) {
  await mkdir(archive, { recursive: true });
  await writeFile(join(archive, key), JSON.stringify({
    id: "TASK-1", title: "Archived task", status: "failed", updated_at: "2026-09-01T10:00:00Z",
    prompt: "PRIVATE PROMPT", comments: ["PRIVATE COMMENT"], ...fields,
  }));
}
it("treats a missing archive as genuinely empty", async () => { expect(await readSpoolArchive(root)).toEqual([]); });
it("preserves repeated task IDs as separate attempts and returns only display fields", async () => {
  await record();
  await record("TASK-1-attempt-b.json", { status: "completed", updated_at: "2026-09-02T10:00:00Z" });
  await writeFile(join(archive, "unfinished.tmp"), "{invalid");
  expect(await readSpoolArchive(root)).toEqual([
    { key: "TASK-1-attempt-b.json", id: "TASK-1", title: "Archived task", status: "completed", updatedAt: "2026-09-02T10:00:00Z" },
    { key: "TASK-1-attempt-a.json", id: "TASK-1", title: "Archived task", status: "failed", updatedAt: "2026-09-01T10:00:00Z" },
  ]);
});
it.each([{ id: "OTHER" }, { title: "" }, { status: "unknown" }, { updated_at: "yesterday" }])("rejects malformed archive records: %j", async (fields) => {
  await record(undefined, fields); await expect(readSpoolArchive(root)).rejects.toThrow("Invalid Spool archive");
});
it("does not silently hide malformed JSON", async () => {
  await record(); await writeFile(join(archive, "TASK-1-attempt-a.json"), "{broken");
  await expect(readSpoolArchive(root)).rejects.toThrow("Invalid Spool archive JSON");
});
