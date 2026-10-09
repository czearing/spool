import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { hasCode, readFileSnapshot } from "./file-snapshot";
import { isTaskPreparation, type TaskPreparation } from "./task-preparation";

const historyCache = new Map<string, { version: string; items: TaskPreparation[] }>();
async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(/* turbopackIgnore: true */ file, "utf8")); }
  catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
export async function readTaskPreparations(root: string): Promise<TaskPreparation[]> {
  async function read(directory: string) {
    const items = await readFileSnapshot(async () => {
      try {
        return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map(({ name }) => ({ file: join(directory, name), name })).sort((a, b) => a.name.localeCompare(b.name));
      } catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
    }, async ({ file, name }) => {
      const job: unknown = JSON.parse(await readFile(/* turbopackIgnore: true */ file, "utf8"));
      if (!record(job) || !record(job.request)) throw new Error("Invalid runner preparation record.");
      if (job.request.kind !== "create") return undefined;
      const result = await readJson(join(root, "controls", "results", name));
      if (record(result) && record(result.result) && result.result.status === "accepted") return undefined;
      const failed = record(result) && record(result.result) && result.result.status === "failed" ? result.result : undefined;
      const item = { id: job.request.taskId, title: job.request.title, agent: job.request.agent,
        stage: failed ? "failed" : job.status === "prepared" ? "submitted" : job.status,
        ...(failed || job.status === "failed" ? { error: failed?.error ?? job.detail } : {}) };
      if (!isTaskPreparation(item)) throw new Error("Invalid runner task preparation.");
      return item;
    }, "Runner preparations");
    return items.filter((item): item is TaskPreparation => item !== undefined);
  }
  const history = join(root, "controls", "manual-history");
  let version = "missing";
  try { const info = await stat(history); version = `${info.mtimeMs}:${info.ctimeMs}`; }
  catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  let cached = historyCache.get(root);
  if (!cached || cached.version !== version) {
    cached = { version, items: (await read(history)).filter((item) => item.stage === "failed") };
    historyCache.set(root, cached);
  }
  return [...await read(join(root, "controls", "manual")), ...cached.items];
}
