import { readTaskBoard } from "./board-archive";
import type { SpoolItem } from "./spool-model";

export type AgentJob = SpoolItem & { key: string; archived: boolean; updatedAt: string | null };
export type AgentJobs = { current: AgentJob[]; history: AgentJob[] };

export async function readAgentJobs(root: string, agent: string): Promise<AgentJobs> {
  const board = await readTaskBoard(root);
  const jobs: AgentJob[] = [
    ...board.items.map((item) => ({
      ...item, key: `${item.status}:${item.id}.json`, archived: false,
    })),
    ...board.archived.map((item) => ({
      ...item, key: item.key.startsWith("task:") ? item.key : `.runner-archive:${item.key}`, archived: true,
    })),
  ].filter((job) => job.agent === agent).map(({ id, title, status, key, archived, updatedAt }) =>
    ({ id, title, status, key, archived, updatedAt: updatedAt ?? null }));
  jobs.sort((a, b) => (b.updatedAt ? Date.parse(b.updatedAt) : -Infinity) - (a.updatedAt ? Date.parse(a.updatedAt) : -Infinity)
    || a.key.localeCompare(b.key));
  const isCurrent = (job: AgentJob) => !job.archived && ["incoming", "in_progress"].includes(job.status);
  return { current: jobs.filter(isCurrent), history: jobs.filter((job) => !isCurrent(job)) };
}
