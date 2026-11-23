import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { cachedFileReader, readFileSnapshot } from "./file-snapshot";
import { readRunningProcesses, type RunningProcess } from "./process-snapshot";
import type { AgentWorkState } from "./agent-jobs";

type Execution = { agent: string; session: string | null; provider: { pid: number | null; token: string } | null };
type AgentWork = { id: string; agent: string; state: AgentWorkState };
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
function liveSession(task: Execution, processes: readonly RunningProcess[]) {
  const key = task.provider ? `provider:${task.provider.token}` : task.session ? `session:${task.session}` : null;
  const alive = task.provider
    ? processes.some((entry) => entry.pid === task.provider!.pid && new RegExp(`(?<![\\w-])${task.provider!.token}(?![\\w-])`).test(entry.command))
    : task.session && processes.some((entry) =>
      new RegExp(`(?:^|\\s)(?:--session-id|--resume)(?:=|\\s+)["']?${task.session}(?=["'\\s]|$)`).test(entry.command));
  return alive ? key : null;
}
export function countActiveSessions(executions: readonly Execution[], processes: readonly RunningProcess[]): Record<string, number> {
  const sessions = new Map<string, Set<string>>();
  for (const task of executions) {
    const key = liveSession(task, processes);
    if (!key) continue;
    const active = sessions.get(task.agent) ?? new Set<string>();
    active.add(key); sessions.set(task.agent, active);
  }
  return Object.fromEntries([...sessions].map(([agent, active]) => [agent, active.size]));
}
const readExecution = cachedFileReader(async ({ file }: { file: string }) => {
  const value = JSON.parse(await readFile(file, "utf8"));
  if (basename(dirname(file)) === "incoming" && value?.agent === undefined) return null;
  const execution = parseExecution(value, file);
  const phase = value?.interaction?.phase, queue = basename(dirname(file));
  return queue === "in_progress" && (value?.interaction?.paused || phase && !["starting", "running", "interrupting", "stopping"].includes(phase))
    ? null : { ...execution, id: value.id as string, queue, phase: phase as string | undefined };
});
export async function readAgentActivity(root: string) {
  const records = await readFileSnapshot(async () => (await Promise.all(["incoming", "in_progress"].map(async queue => {
    const directory = join(root, "queues", queue);
    return (await readdir(directory, { withFileTypes: true }))
      .filter(file => file.isFile() && file.name.endsWith(".json"))
      .map(file => ({ file: join(directory, file.name) }));
  }))).flat().sort((a, b) => a.file.localeCompare(b.file)),
    readExecution, "Active executions");
  const executions = records.filter(entry => entry !== null);
  const isStarting = (entry: typeof executions[number]) => entry.phase === "starting" ||
    !entry.phase && (entry.provider ? entry.provider.pid === null : !entry.session);
  const candidates = executions.filter(entry => entry.queue === "in_progress" && !isStarting(entry));
  const legacy = candidates.some(entry => entry.session && !entry.provider);
  const pids = candidates.flatMap(entry => entry.provider?.pid ? [entry.provider.pid] : []);
  const processes = legacy || pids.length ? await readRunningProcesses(legacy ? undefined : pids) : [];
  const work: AgentWork[] = executions.flatMap(entry => {
    const state = entry.queue === "incoming" ? "pending" : isStarting(entry) ? "starting"
      : liveSession(entry, processes) ? "running" : undefined;
    return state ? [{ id: entry.id, agent: entry.agent, state }] : [];
  });
  return { active: countActiveSessions(candidates, processes), work };
}
