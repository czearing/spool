import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { cachedFileReader, hasCode, readFileSnapshot } from "./file-snapshot";
import { publishJson, readOptionalJson } from "./spool-publish";
import { readSpoolItems } from "./spool";
import { readSpoolArchive, type ArchivedSpoolItem } from "./spool-archive";
import { taskRevision, type SpoolItem } from "./spool-model";
import { readTaskPreparations } from "./task-preparations";

export class BoardArchiveError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const file = (root: string) => join(root, "controls", "ui-archive.json");
const batches = (root: string) => join(root, "controls", "ui-archive");
const readOperation = cachedFileReader(async ({ file }: { file: string }) => {
  const batch: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!batch || typeof batch !== "object" || !("version" in batch) || batch.version !== 1 ||
    !("revisions" in batch) || !Array.isArray(batch.revisions)) throw new Error("Invalid archive batch.");
  if (!batch.revisions.every((entry: unknown) => typeof entry === "string") ||
    ("archived" in batch && typeof batch.archived !== "boolean") ||
    ("sequence" in batch && (typeof batch.sequence !== "number" || !Number.isSafeInteger(batch.sequence) || batch.sequence < 0))) {
    throw new Error("Invalid archive batch.");
  }
  return { name: basename(file), revisions: batch.revisions as string[], archived: !("archived" in batch) || batch.archived,
    sequence: "sequence" in batch ? batch.sequence as number : 0 };
});
async function readMarkers(root: string) {
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
  const operations = await readFileSnapshot(async () => {
    try { return (await readdir(batches(root))).filter(name => name.endsWith(".json")).sort()
      .map(name => ({ file: join(batches(root), name) })); }
    catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
  }, readOperation, "Board archive");
  operations.sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name));
  for (const operation of operations) for (const revision of operation.revisions) {
    if (operation.archived) markers.add(revision); else markers.delete(revision);
  }
  return { markers, sequence: operations.at(-1)?.sequence ?? 0 };
}
const matches = (item: SpoolItem, markers: Set<string>) => markers.has(taskRevision(item));
async function publishArchive(root: string, revisions: string[], archived: boolean, sequence: number) {
  await mkdir(batches(root), { recursive: true });
  await publishJson(join(batches(root), `${randomUUID()}.json`), {
    version: 1, revisions, archived, sequence: Math.max(Date.now(), sequence + 1),
  });
}
async function readBoardItems(root: string): Promise<SpoolItem[]> {
  const [items, preparations] = await Promise.all([readSpoolItems(root), readTaskPreparations(root)]);
  const ids = new Set(items.map(item => item.id));
  for (const preparation of preparations) {
    if (ids.has(preparation.id)) continue;
    ids.add(preparation.id);
    items.push({ id: preparation.id, title: preparation.title, status: preparation.stage === "failed" ? "failed" : "incoming",
      agent: preparation.agent, updatedAt: null, preparation });
  }
  return items;
}
export async function readTaskBoard(root: string) {
  const [items, history, { markers }] = await Promise.all([readBoardItems(root), readSpoolArchive(root), readMarkers(root)]);
  const archived: ArchivedSpoolItem[] = items.filter((item) => matches(item, markers))
    .map((item) => ({ ...item, key: `task:${item.id}`, updatedAt: item.updatedAt ?? null }));
  return { items: items.filter((item) => !matches(item, markers)), archived: [...archived, ...history].sort((a, b) =>
    (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0) || a.key.localeCompare(b.key)) };
}
export async function archiveBoardColumn(root: string, status: unknown) {
  if (status !== "completed" && status !== "failed") throw new BoardArchiveError("Only completed or failed tasks can be archived.");
  const [items, { markers, sequence }] = await Promise.all([readBoardItems(root), readMarkers(root)]);
  const selected = items.filter((item) => item.status === status && !matches(item, markers));
  if (selected.length) {
    await publishArchive(root, selected.map(taskRevision), true, sequence);
  }
  return { archived: selected.length };
}
export async function setTaskArchived(root: string, id: string, archived: boolean) {
  const [items, { markers, sequence }] = await Promise.all([readBoardItems(root), readMarkers(root)]);
  const item = items.find((item) => item.id === id);
  if (!item) throw new BoardArchiveError("Conversation not found.", 404);
  if (matches(item, markers) !== archived) await publishArchive(root, [taskRevision(item)], archived, sequence);
  return { id, archived };
}
