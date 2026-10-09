import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { listSpoolEntries } from "./spool";
import { cachedFileReader, readFileSnapshot } from "./file-snapshot";
import { createToolLogReader, type ToolLog } from "./tool-log";
import { summarizeToolCalls } from "./tool-usage";
import type { DashboardRange } from "./dashboard-range";

const readLog = createToolLogReader();
const readSession = cachedFileReader(async ({ file }: { file: string }) => {
  const task: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!task || typeof task !== "object" || !("id" in task) || task.id !== basename(file, ".json")) {
    throw new Error("Invalid task identity while reading tool sessions.");
  }
  const id = "session_id" in task ? task.session_id : undefined;
  if (id == null) return undefined;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid saved tool session identity.");
  return id;
});
export async function readToolUsage(root: string, range: DashboardRange, now = new Date()) {
  const sessions = [...new Set((await readFileSnapshot(() => listSpoolEntries(root), readSession, "Tool sessions"))
    .filter((id): id is string => id !== undefined))];
  const sessionRoot = process.env.SPOOL_COPILOT_SESSION_ROOT ?? join(homedir(), ".copilot", "session-state");
  const logs: ToolLog[] = [];
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, sessions.length) }, async () => {
    while (index < sessions.length) {
      const id = sessions[index++];
      logs.push(await readLog(join(sessionRoot, id, "events.jsonl")));
    }
  }));
  return { ...summarizeToolCalls(logs.filter((log) => log.available).map((log) => log.calls), range, now),
    missingSessions: logs.filter((log) => !log.available).length,
    invalidRecords: logs.reduce((sum, log) => sum + log.invalidRecords, 0) };
}
