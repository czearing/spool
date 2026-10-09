import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { readFileSnapshot } from "./file-snapshot";
import { readRunningProcesses, type RunningProcess } from "./process-snapshot";

type Execution = { agent: string; session: string | null; provider: { pid: number | null; token: string } | null };
function parseExecution(value: unknown, file: string): Execution {
  if (!value || typeof value !== "object" || !("id" in value) || value.id !== basename(file, ".json") ||
    !("agent" in value) || typeof value.agent !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value.agent)) throw new Error(`Invalid active task: ${basename(file)}`);
  const session = "session_id" in value ? value.session_id : null;
  if (session !== null && (typeof session !== "string" || !/^[a-zA-Z0-9_-]+$/.test(session))) throw new Error("Invalid active session identity.");
  const provider = "provider" in value ? value.provider : null;
  if (provider == null) return { agent: value.agent, session, provider: null };
  if (typeof provider !== "object" || !("token" in provider) || typeof provider.token !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(provider.token) || !("pid" in provider) ||
    (provider.pid !== null && (typeof provider.pid !== "number" || !Number.isSafeInteger(provider.pid) || provider.pid <= 0))) {
    throw new Error("Invalid active provider identity.");
  }
  return { agent: value.agent, session, provider: { pid: provider.pid, token: provider.token } };
}
export function countActiveSessions(executions: readonly Execution[], processes: readonly RunningProcess[]): Record<string, number> {
  const sessions = new Map<string, Set<string>>();
  for (const task of executions) {
    const key = task.provider ? `provider:${task.provider.token}` : task.session ? `session:${task.session}` : null;
    const alive = task.provider
      ? processes.some((entry) => entry.pid === task.provider!.pid && new RegExp(`(?<![\\w-])${task.provider!.token}(?![\\w-])`).test(entry.command))
      : task.session && processes.some((entry) =>
        new RegExp(`(?:^|\\s)(?:--session-id|--resume)(?:=|\\s+)["']?${task.session}(?=["'\\s]|$)`).test(entry.command));
    if (!key || !alive) continue;
    const active = sessions.get(task.agent) ?? new Set<string>();
    active.add(key); sessions.set(task.agent, active);
  }
  return Object.fromEntries([...sessions].map(([agent, active]) => [agent, active.size]));
}
export async function readAgentActivity(root: string) {
  const directory = join(root, "queues", "in_progress");
  const executions = await readFileSnapshot(async () => (await readdir(directory, { withFileTypes: true }))
    .filter((file) => file.isFile() && file.name.endsWith(".json"))
    .map((file) => ({ file: join(directory, file.name) })).sort((a, b) => a.file.localeCompare(b.file)),
  async ({ file }) => parseExecution(JSON.parse(await readFile(file, "utf8")), file), "Active executions");
  if (!executions.some((entry) => entry.session || entry.provider)) return {};
  const legacy = executions.some(entry => entry.session && !entry.provider);
  const pids = executions.flatMap(entry => entry.provider?.pid ? [entry.provider.pid] : []);
  return countActiveSessions(executions, await readRunningProcesses(legacy ? undefined : pids));
}
