import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { cachedFileReader, hasCode, readFileSnapshot } from "./file-snapshot";
import { spoolQueues, type SpoolItem } from "./spool";
import { reviewSupersession } from "../../../packages/runners/packages/repository-mcp/src/review-outcome.mjs";
import { taskFailurePresentation } from "../../../packages/runners/bridge/task-failure.mjs";

export type ArchivedSpoolItem = SpoolItem & { key: string; updatedAt: string | null };
export async function listArchive(root: string) {
  const directory = join(root, "queues", ".runner-archive");
  try {
    const files = await readdir(directory, { withFileTypes: true });
    return files.filter((file) => file.isFile() && file.name.endsWith(".json"))
      .map((file) => ({ file: join(directory, file.name) })).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  } catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
}
async function readArchivedItem({ file }: { file: string }) {
  const content = await readFile(file, "utf8");
  let task: unknown;
  try { task = JSON.parse(content); }
  catch (error) { throw new Error(`Invalid Spool archive JSON: ${basename(file)}`, { cause: error }); }
  if (!task || typeof task !== "object" || !("id" in task) || typeof task.id !== "string" || !task.id.trim()
    || !basename(file).startsWith(`${task.id}-`) || !("title" in task) || typeof task.title !== "string" || !task.title.trim()
    || !("status" in task) || !("updated_at" in task) || typeof task.updated_at !== "string" || !Number.isFinite(Date.parse(task.updated_at))) {
    throw new Error(`Invalid Spool archive record: ${basename(file)}`);
  }
  const queue = spoolQueues.find((queue) => queue.id === task.status);
  if (!queue) throw new Error(`Invalid Spool archive status: ${basename(file)}`);
  if ("agent" in task && (typeof task.agent !== "string" || !/^[a-zA-Z0-9_-]+$/.test(task.agent))) {
    throw new Error(`Invalid Spool archive agent: ${basename(file)}`);
  }
  const supersession = reviewSupersession(task);
  return { task, item: { key: basename(file), id: task.id, title: task.title, status: supersession ? "superseded" : queue.id, updatedAt: task.updated_at,
    ...("agent" in task && typeof task.agent === "string" ? { agent: task.agent } : {}) } satisfies ArchivedSpoolItem };
}
const readCachedArchive = cachedFileReader(readArchivedItem);
export async function readSpoolArchive(root: string): Promise<ArchivedSpoolItem[]> {
  const records = await readFileSnapshot(() => listArchive(root), readCachedArchive, "Spool archive");
  const items = records.map(({ task, item }) => item.status !== "superseded" && taskFailurePresentation(root, task).status === "blocked"
    ? { ...item, status: "blocked" as const, queueStatus: "failed" as const } : item);
  return items.sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? "") || a.key.localeCompare(b.key));
}
