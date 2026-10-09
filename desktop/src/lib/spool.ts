import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { cachedFileReader, readFileSnapshot } from "./file-snapshot";

import { spoolQueues, type SpoolItem, type SpoolStatus } from "./spool-model";
export { spoolQueues, type SpoolItem, type SpoolStatus } from "./spool-model";
type Entry = { file: string; status: SpoolStatus };

export async function countCompletedSpoolItems(root: string): Promise<number> {
  const files = await readdir(join(root, "queues", "completed"), { withFileTypes: true });
  return files.filter((file) => file.isFile() && file.name.endsWith(".json")).length;
}

export async function listSpoolEntries(root: string, statuses: readonly SpoolStatus[] = spoolQueues.map(({ id }) => id)): Promise<Entry[]> {
  const queues = await Promise.all(statuses.map(async (id) => {
    const directory = join(root, "queues", id);
    const files = await readdir(directory, { withFileTypes: true });
    return files.filter((file) => file.isFile() && file.name.endsWith(".json"))
      .map((file) => ({ file: join(directory, file.name), status: id }));
  }));
  return queues.flat().sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
}
async function readItem({ file, status }: Entry): Promise<SpoolItem> {
  const content = await readFile(file, "utf8");
  let task: unknown;
  try { task = JSON.parse(content); }
  catch (error) { throw new Error(`Invalid Spool JSON: ${basename(file)}`, { cause: error }); }
  if (!task || typeof task !== "object" || !("id" in task) || task.id !== basename(file, ".json")
    || !("title" in task) || typeof task.title !== "string" || !task.title.trim()) {
    throw new Error(`Invalid Spool identity or title: ${basename(file)}`);
  }
  // Spool's queue location is authoritative, including during atomic status transitions.
  if ("agent" in task && (typeof task.agent !== "string" || !/^[a-zA-Z0-9_-]+$/.test(task.agent))) {
    throw new Error(`Invalid Spool agent: ${basename(file)}`);
  }
  const updatedAt = "updated_at" in task ? task.updated_at : undefined;
  if (updatedAt !== undefined && updatedAt !== null && (typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt)))) {
    throw new Error(`Invalid Spool job timestamp: ${basename(file)}`);
  }
  return { id: task.id, title: task.title, status, ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...("agent" in task && typeof task.agent === "string" ? { agent: task.agent } : {}) };
}
const readCachedItem = cachedFileReader(readItem);
export async function readSpoolItems(root = process.env.SPOOL_ROOT ?? resolve(process.cwd(), "..", "spool")): Promise<SpoolItem[]> {
  const items = await readFileSnapshot(() => listSpoolEntries(root), readCachedItem, "Spool queues");
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`Spool work item exists in multiple queues: ${item.id}`);
    ids.add(item.id);
  }
  return items;
}
