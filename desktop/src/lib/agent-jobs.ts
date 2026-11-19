import { readTaskBoard } from "./board-archive";
import type { SpoolItem } from "./spool-model";

export type AgentWorkState = "pending" | "starting" | "running";
export type AgentJob = SpoolItem & { key: string; archived: boolean; updatedAt: string | null; activity?: AgentWorkState };
export type AgentJobs = { current: AgentJob[]; history: AgentJob[] };

export async function readAgentJobs(root: string, agent: string): Promise<AgentJobs> {
  return selectAgentJobs(await readTaskBoard(root), agent);
}
export function selectAgentJobs(board: Awaited<ReturnType<typeof readTaskBoard>>, agent: string): AgentJobs {
  const jobs: AgentJob[] = [
    ...board.items.filter(item => item.agent === agent).map((item) => ({
      ...item, key: `${item.status}:${item.id}.json`, archived: false,
    })),
    ...board.archived.filter(item => item.agent === agent).map((item) => ({
      ...item, key: item.key.startsWith("task:") ? item.key : `.runner-archive:${item.key}`, archived: true,
    })),
  ].map(({ id, title, status, key, archived, updatedAt }) =>
    ({ id, title, status, key, archived, updatedAt: updatedAt ?? null }));
  jobs.sort((a, b) => (b.updatedAt ? Date.parse(b.updatedAt) : -Infinity) - (a.updatedAt ? Date.parse(a.updatedAt) : -Infinity)
    || a.key.localeCompare(b.key));
  const isCurrent = (job: AgentJob) => !job.archived && ["incoming", "in_progress"].includes(job.status);
  return { current: jobs.filter(isCurrent), history: jobs.filter((job) => !isCurrent(job)) };
}
