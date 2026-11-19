import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { archiveBoardColumn, readTaskBoard, setTaskArchived } from "./board-archive";
import { readAgentJobs } from "./agent-jobs";
import { readBoardVersion } from "./project-live";
import { spoolQueues } from "./spool-model";

let root: string;
const taskFile = (status: string, id = "A") => join(root, "queues", status, `${id}.json`);
const save = (status: string, id = "A", updatedAt = "2026-10-01T10:00:00Z") => writeFile(taskFile(status, id),
  JSON.stringify({ id, title: id, agent: "engineer", status, updated_at: updatedAt, prompt: "KEEP ORIGINAL", session_id: "saved-session" }));
async function preparation(id = "recovery", status = "failed") {
  const directory = join(root, "controls", "manual-history");
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${id}.json`);
  await writeFile(file, JSON.stringify({ status, detail: "spawn gh ENOENT",
    request: { kind: "create", taskId: id, title: "Library performance recovery", agent: "engineer" } }));
  return file;
}
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
it("archives and restores one conversation repeatedly without modifying its session or other conversations", async () => {
  await save("completed", "A"); await save("completed", "B");
  const original = await readFile(taskFile("completed"), "utf8");
  await archiveBoardColumn(root, "completed");
  for (let attempt = 0; attempt < 3; attempt++) {
    await setTaskArchived(root, "A", false);
    expect((await readTaskBoard(root)).items.map(item => item.id)).toEqual(["A"]);
    expect((await readTaskBoard(root)).archived.map(item => item.id)).toEqual(["B"]);
    await setTaskArchived(root, "A", true);
  }
  await setTaskArchived(root, "A", false);
  expect(await archiveBoardColumn(root, "completed")).toEqual({ archived: 1 });
  expect((await readTaskBoard(root)).items).toEqual([]);
  expect(await readFile(taskFile("completed"), "utf8")).toBe(original);
  await expect(setTaskArchived(root, "missing", true)).rejects.toThrow("Conversation not found");
});
it("hides active conversations without stopping work, and resurfaces new revisions", async () => {
  await save("in_progress");
  const original = await readFile(taskFile("in_progress"), "utf8");
  await setTaskArchived(root, "A", true);
  expect((await readAgentJobs(root, "engineer")).history[0].archived).toBe(true);
  expect(await readFile(taskFile("in_progress"), "utf8")).toBe(original);
  await save("in_progress", "A", "2026-10-01T11:00:00Z");
  expect((await readAgentJobs(root, "engineer")).current[0].archived).toBe(false);
});
it("archives and restores failed preparations shared by the board and agent history without a queue task", async () => {
  const file = await preparation(), original = await readFile(file, "utf8");
  expect((await readTaskBoard(root)).items).toMatchObject([{ id: "recovery", status: "failed",
    preparation: { stage: "failed", error: "spawn gh ENOENT" } }]);
  expect((await readAgentJobs(root, "engineer")).history).toMatchObject([{ id: "recovery", archived: false }]);
  await setTaskArchived(root, "recovery", true);
  expect((await readTaskBoard(root)).items).toEqual([]);
  expect((await readTaskBoard(root)).archived).toMatchObject([{ id: "recovery", key: "task:recovery" }]);
  expect((await readAgentJobs(root, "engineer")).history).toMatchObject([{ id: "recovery", archived: true }]);
  await setTaskArchived(root, "recovery", false);
  expect((await readTaskBoard(root)).items.map(item => item.id)).toEqual(["recovery"]);
  expect(await readFile(file, "utf8")).toBe(original);
});
it("bulk archives failed preparations and queue tasks together and is idempotent", async () => {
  await preparation(); await save("failed"); await save("completed", "B");
  expect(await archiveBoardColumn(root, "failed")).toEqual({ archived: 2 });
  expect((await readTaskBoard(root)).items.map(item => item.id)).toEqual(["B"]);
  expect((await readAgentJobs(root, "engineer")).history.filter(item => item.archived)).toHaveLength(2);
  expect(await archiveBoardColumn(root, "failed")).toEqual({ archived: 0 });
});
it("does not resurrect archived native tasks through stale preparation failures", async () => {
  await preparation("A"); await save("failed");
  expect((await readTaskBoard(root)).items).toHaveLength(1);
  await setTaskArchived(root, "A", true);
  expect((await readTaskBoard(root)).items).toEqual([]);
  expect((await readAgentJobs(root, "engineer")).history).toHaveLength(1);
  expect((await readAgentJobs(root, "engineer")).history[0].archived).toBe(true);
});
it("resurfaces a real task created after its preparation failure was archived", async () => {
  await preparation("A"); await setTaskArchived(root, "A", true);
  await save("incoming");
  expect((await readTaskBoard(root)).items).toMatchObject([{ id: "A", status: "incoming" }]);
  expect((await readTaskBoard(root)).archived).toEqual([]);
  expect((await readAgentJobs(root, "engineer")).current).toMatchObject([{ id: "A", archived: false }]);
});
it("changes the board version when a preparation is updated in place", async () => {
  const directory = join(root, "controls", "manual");
  await mkdir(directory, { recursive: true });
  const file = join(directory, "pending.json"), request = { kind: "create", taskId: "pending", title: "Pending task", agent: "engineer" };
  await writeFile(file, JSON.stringify({ request, status: "waiting" }));
  const before = await readBoardVersion(root);
  await writeFile(file, JSON.stringify({ request, status: "preparing" }));
  expect(await readBoardVersion(root)).not.toBe(before);
  expect((await readTaskBoard(root)).items).toMatchObject([{ id: "pending", preparation: { stage: "preparing" } }]);
});
