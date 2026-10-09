import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { archiveBoardColumn, readTaskBoard } from "./board-archive";
import { readAgentJobs } from "./agent-jobs";
import { readBoardVersion } from "./project-live";
import { spoolQueues } from "./spool-model";

let root: string;
const taskFile = (status: string, id = "A") => join(root, "queues", status, `${id}.json`);
const save = (status: string, id = "A", updatedAt = "2026-10-01T10:00:00Z") => writeFile(taskFile(status, id),
  JSON.stringify({ id, title: id, agent: "engineer", status, updated_at: updatedAt, prompt: "KEEP ORIGINAL", session_id: "saved-session" }));
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "board-archive-"));
  await Promise.all(spoolQueues.map(({ id }) => mkdir(join(root, "queues", id), { recursive: true })));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it("archives every task in just the selected terminal column without altering native records", async () => {
  await save("completed"); await save("completed", "B"); await save("failed", "C"); await save("in_progress", "D");
  const original = await readFile(taskFile("completed"), "utf8"), before = await readBoardVersion(root);
  expect(await archiveBoardColumn(root, "completed")).toEqual({ archived: 2 });
  expect(await readFile(taskFile("completed"), "utf8")).toBe(original);
  const board = await readTaskBoard(root);
  expect(board.items.map((item) => item.id).sort()).toEqual(["C", "D"]);
  expect(board.archived.map((item) => item.id).sort()).toEqual(["A", "B"]);
  expect((await readAgentJobs(root, "engineer")).history.filter((job) => job.archived)).toHaveLength(2);
  expect(await readBoardVersion(root)).not.toBe(before);
  expect(await archiveBoardColumn(root, "completed")).toEqual({ archived: 0 });
  expect(await archiveBoardColumn(root, "failed")).toEqual({ archived: 1 });
  expect((await readTaskBoard(root)).archived).toHaveLength(3);
});
it("automatically resurfaces resumed or updated work without replacing its original session", async () => {
  await save("completed"); await archiveBoardColumn(root, "completed");
  await rename(taskFile("completed"), taskFile("in_progress"));
  expect((await readTaskBoard(root)).items[0].status).toBe("in_progress");
  await rename(taskFile("in_progress"), taskFile("completed"));
  await save("completed", "A", "2026-10-01T11:00:00Z");
  expect((await readTaskBoard(root)).archived).toEqual([]);
  expect((await readTaskBoard(root)).items.map((item) => item.id)).toEqual(["A"]);
  expect(JSON.parse(await readFile(taskFile("completed"), "utf8")).session_id).toBe("saved-session");
});
it("keeps previous attempts distinct from a newly archived live task", async () => {
  await save("failed");
  await mkdir(join(root, "queues", ".runner-archive"));
  await writeFile(join(root, "queues", ".runner-archive", "A-old.json"), await readFile(taskFile("failed")));
  await archiveBoardColumn(root, "failed");
  expect((await readTaskBoard(root)).archived.map((item) => item.key).sort()).toEqual(["A-old.json", "task:A"]);
});
it("rejects active columns, ignores abandoned legacy locks, and reports corrupt archive data", async () => {
  await expect(archiveBoardColumn(root, "in_progress")).rejects.toThrow("Only completed or failed");
  await mkdir(join(root, "controls"));
  const lock = join(root, "controls", "ui-archive.json.lock");
  await writeFile(lock, "");
  await save("failed");
  expect(await archiveBoardColumn(root, "failed")).toEqual({ archived: 1 });
  expect(await readFile(lock, "utf8")).toBe("");
  await rm(lock); await writeFile(join(root, "controls", "ui-archive.json"), '{"version":1,"items":{"A":42}}');
  await expect(readTaskBoard(root)).rejects.toThrow("Invalid board archive");
  await expect(archiveBoardColumn(root, "failed")).rejects.toThrow("Invalid board archive");
});
it("concurrent batches cannot overwrite each other and incomplete temporary files are ignored", async () => {
  await save("completed", "A"); await save("failed", "B");
  await Promise.all([archiveBoardColumn(root, "completed"), archiveBoardColumn(root, "failed")]);
  expect((await readTaskBoard(root)).archived.map((item) => item.id).sort()).toEqual(["A", "B"]);
  await writeFile(join(root, "controls", "ui-archive", "abandoned.tmp"), "{broken");
  expect((await readTaskBoard(root)).items).toEqual([]);
  await writeFile(join(root, "controls", "ui-archive", "corrupt.json"), '{"version":1,"revisions":[42]}');
  await expect(readTaskBoard(root)).rejects.toThrow("Invalid archive batch");
});
