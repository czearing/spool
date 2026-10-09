import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { cachedFileReader, readFileSnapshot } from "./file-snapshot";
import { listSpoolEntries } from "./spool";
import type { JobCompletion } from "./job-completions";

const readCompletion = cachedFileReader(async ({ file }: { file: string }): Promise<JobCompletion | null> => {
  const task: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!task || typeof task !== "object" || !("id" in task) || task.id !== basename(file, ".json") ||
    !("title" in task) || typeof task.title !== "string" || !task.title.trim()) throw new Error("Invalid completed task.");
  if ("agent" in task && (typeof task.agent !== "string" || !/^[a-zA-Z0-9_-]+$/.test(task.agent))) throw new Error("Invalid completed agent.");
  // A role can mark work complete before the native runner has settled its outcome.
  if ("provider" in task && task.provider != null || "error" in task && task.error != null) return null;
  const generation = ["created_at", "session_id", "turns"].map((field) => Reflect.get(task, field) ?? null);
  const key = createHash("sha256").update(JSON.stringify([task.id, ...generation])).digest("hex");
  return { key, id: task.id, title: task.title, ...("agent" in task && typeof task.agent === "string" ? { agent: task.agent } : {}) };
});
export async function readSpoolCompletions(root: string) {
  const items = await readFileSnapshot(() => listSpoolEntries(root, ["completed"]), readCompletion, "Completed jobs");
  return items.filter((item) => item !== null);
}
