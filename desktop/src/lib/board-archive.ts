import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { hasCode } from "./file-snapshot";
import { publishJson, readOptionalJson } from "./spool-publish";
import { readSpoolItems } from "./spool";
import { readSpoolArchive, type ArchivedSpoolItem } from "./spool-archive";
import { taskRevision, type SpoolItem } from "./spool-model";

export class BoardArchiveError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const file = (root: string) => join(root, "controls", "ui-archive.json");
const batches = (root: string) => join(root, "controls", "ui-archive");
const terminal = (item: SpoolItem) => item.status === "completed" || item.status === "failed";
async function readMarkers(root: string): Promise<Set<string>> {
  const value = await readOptionalJson(file(root));
  const markers = new Set<string>();
  if (value !== undefined) {
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
      !("items" in value) || !value.items || typeof value.items !== "object" || Array.isArray(value.items)) throw new Error("Invalid board archive.");
    for (const entry of Object.values(value.items)) {
      if (typeof entry !== "string") throw new Error("Invalid board archive.");
      markers.add(entry);
    }
  }
  let names: string[];
  try { names = await readdir(batches(root)); }
  catch (error) { if (hasCode(error, "ENOENT")) return markers; throw error; }
  await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    const batch = await readOptionalJson(join(batches(root), name));
    if (!batch || typeof batch !== "object" || !("version" in batch) || batch.version !== 1 ||
      !("revisions" in batch) || !Array.isArray(batch.revisions)) throw new Error("Invalid archive batch.");
    for (const entry of batch.revisions) {
      if (typeof entry !== "string") throw new Error("Invalid archive batch.");
      markers.add(entry);
    }
  }));
  return markers;
}
const matches = (item: SpoolItem, markers: Set<string>) => terminal(item) && markers.has(taskRevision(item));
export async function readTaskBoard(root: string) {
  const [items, history, markers] = await Promise.all([readSpoolItems(root), readSpoolArchive(root), readMarkers(root)]);
  const archived: ArchivedSpoolItem[] = items.filter((item) => matches(item, markers))
    .map((item) => ({ ...item, key: `task:${item.id}`, updatedAt: item.updatedAt ?? null }));
  return { items: items.filter((item) => !matches(item, markers)), archived: [...archived, ...history].sort((a, b) =>
    (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0) || a.key.localeCompare(b.key)) };
}
export async function archiveBoardColumn(root: string, status: unknown) {
  if (status !== "completed" && status !== "failed") throw new BoardArchiveError("Only completed or failed tasks can be archived.");
  const [items, markers] = await Promise.all([readSpoolItems(root), readMarkers(root)]);
  const selected = items.filter((item) => item.status === status && !matches(item, markers));
  if (selected.length) {
    await mkdir(batches(root), { recursive: true });
    // Immutable batches cannot strand a lock or overwrite another archive request.
    await publishJson(join(batches(root), `${randomUUID()}.json`), { version: 1, revisions: selected.map(taskRevision) });
  }
  return { archived: selected.length };
}
