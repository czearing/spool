import { createHash } from "node:crypto";
import { mkdir, readdir, stat, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readTaskBoard } from "./board-archive";
import { listSpoolEntries } from "./spool";
import { listArchive } from "./spool-archive";
import { hasCode } from "./file-snapshot";
import { readTaskPreparations } from "./task-preparations";
import type { AgentJob } from "./agent-jobs";

type Model = { db: DatabaseSync; pending?: Promise<void> };
const models = new Map<string, Model>();
const opening = new Map<string, Promise<Model>>();
export async function closeBoardReadModels() {
  await Promise.allSettled(opening.values());
  for (const model of models.values()) { try { await model.pending; } catch {} model.db.close(); }
  models.clear();
}
async function openModel(root: string) {
  const saved = models.get(root);
  if (saved) return saved;
  let operation = opening.get(root);
  if (!operation) {
    operation = createModel(root);
    opening.set(root, operation);
    void operation.finally(() => opening.delete(root)).catch(() => {});
  }
  return operation;
}
async function createModel(root: string) {
  const directory = join(root, ".spool-cache");
  let file = ":memory:";
  try {
    await mkdir(directory, { recursive: true });
    try { await writeFile(join(directory, ".gitignore"), "*\n", { flag: "wx" }); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    file = join(directory, "board-v1.sqlite");
  } catch {}
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file);
    db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; ROLLBACK;");
  } catch (error) {
    db?.close();
    db = undefined;
    if (error instanceof Error && /malformed|not a database/i.test(error.message)) {
      try {
        await rename(file, `${file}.corrupt-${Date.now()}`);
        db = new DatabaseSync(file);
        db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL");
      } catch { db?.close(); db = undefined; }
    } else db = undefined;
    db ??= new DatabaseSync(":memory:");
  }
  const schema = `
    CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY, version TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (
      key TEXT PRIMARY KEY, agent TEXT, id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      archived INTEGER NOT NULL, time INTEGER NOT NULL, updated TEXT, current INTEGER NOT NULL, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS agent_history ON jobs(agent, current, time DESC, key);
    CREATE INDEX IF NOT EXISTS agent_identity ON jobs(agent, id);`;
  try { db.exec(schema); }
  catch { db.close(); db = new DatabaseSync(":memory:"); db.exec(schema); }
  db.function("fold", { deterministic: true }, value => typeof value === "string" ? value.toLocaleLowerCase() : "");
  const model: Model = { db };
  models.set(root, model);
  return model;
}
async function directoryFiles(directory: string): Promise<string[]> {
  try { return (await readdir(directory, { withFileTypes: true })).filter(file => file.isFile()).map(file => join(directory, file.name)); }
  catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
}
async function version(root: string) {
  const [tasks, archive, markers, origins, preparations] = await Promise.all([
    listSpoolEntries(root), listArchive(root), directoryFiles(join(root, "controls", "ui-archive")),
    directoryFiles(join(root, "controls", "failure-origins")), readTaskPreparations(root),
  ]);
  const files = [...tasks.map(entry => entry.file), ...archive.map(entry => entry.file), ...markers, ...origins,
    join(root, "controls", "ui-archive.json")].sort();
  const versions = new Array<string>(files.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(32, files.length) }, async () => {
    while (next < files.length) {
      const index = next++, file = files[index];
      try {
        const info = await stat(file, { bigint: true });
        versions[index] = `${file}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      } catch (error) { if (hasCode(error, "ENOENT")) versions[index] = `${file}:missing`; else throw error; }
    }
  }));
  return createHash("sha256").update(JSON.stringify(["summary-v2", versions, preparations])).digest("hex");
}
async function reconcile(root: string, model: Model) {
  const fingerprint = await version(root);
  if (model.db.prepare("SELECT version FROM metadata WHERE id=1").get()?.version === fingerprint) return;
  const board = await readTaskBoard(root);
  const entries = [
    ...board.items.map(item => ({ ...item, key: `${item.status}:${item.id}.json`, archived: false })),
    ...board.archived.map(item => ({ ...item, key: item.key.startsWith("task:") ? item.key : `.runner-archive:${item.key}`, archived: true })),
  ];
  const insert = model.db.prepare(`INSERT INTO jobs(key,agent,id,title,status,archived,time,updated,current,value)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET agent=excluded.agent,id=excluded.id,title=excluded.title,
    status=excluded.status,archived=excluded.archived,time=excluded.time,updated=excluded.updated,current=excluded.current,value=excluded.value
    WHERE value!=excluded.value OR agent IS NOT excluded.agent`);
  const remove = model.db.prepare("DELETE FROM jobs WHERE key=?");
  const keys = new Set(entries.map(entry => entry.key));
  model.db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of model.db.prepare("SELECT key FROM jobs").all()) if (!keys.has(row.key as string)) remove.run(row.key);
    for (const entry of entries) {
      const { id, title, status, key, archived } = entry, updatedAt = entry.updatedAt ?? null;
      const job: AgentJob = { id, title, status, key, archived, updatedAt,
        ...(entry.queueStatus ? { queueStatus: entry.queueStatus } : {}),
        ...(entry.preparation ? { preparation: entry.preparation } : {}) };
      insert.run(key, entry.agent ?? null, id, title, status, +archived, Date.parse(updatedAt ?? "") || 0,
        updatedAt, +(!archived && ["incoming", "in_progress"].includes(status)), JSON.stringify(job));
    }
    model.db.prepare("INSERT INTO metadata VALUES(1,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version").run(fingerprint);
    model.db.exec("COMMIT");
  } catch (error) { model.db.exec("ROLLBACK"); throw error; }
}
export async function boardReadModel(root: string) {
  const model = await openModel(root);
  if (!model.pending) {
    const operation = reconcile(root, model);
    model.pending = operation;
    void operation.finally(() => { if (model.pending === operation) model.pending = undefined; }).catch(() => {});
  }
  await model.pending;
  return model.db;
}
