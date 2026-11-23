import type { readTaskBoard } from "./board-archive";
import { boardReadModel } from "./board-read-model";
import type { SpoolItem } from "./spool-model";

export type AgentWorkState = "pending" | "starting" | "running";
export type AgentJob = SpoolItem & { key: string; archived: boolean; updatedAt: string | null; activity?: AgentWorkState };
export type AgentJobs = { current: AgentJob[]; history: AgentJob[]; nextCursor?: string | null };
export type AgentJobPage = { cursor?: string; limit?: number; search?: string; selected?: string };

export async function readAgentJobs(root: string, agent: string, page?: AgentJobPage): Promise<AgentJobs> {
  const limit = page?.limit ?? 60;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Invalid history page size.");
  let cursor: { time: number; key: string } | undefined;
  if (page?.cursor) {
    try { cursor = JSON.parse(Buffer.from(page.cursor, "base64url").toString("utf8")); } catch {}
    if (!cursor || !Number.isSafeInteger(cursor.time) || typeof cursor.key !== "string" || cursor.key.length > 512)
      throw new RangeError("Invalid history cursor.");
  }
  const search = page?.search?.trim() ?? "";
  if (search.length > 200) throw new RangeError("Search is too long.");
  const db = await boardReadModel(root), filter = "agent=? AND instr(fold(title),?)>0", term = search.toLocaleLowerCase();
  const decode = (rows: Record<string, unknown>[]) => rows.map(row => JSON.parse(row.value as string) as AgentJob);
  const current = decode(db.prepare(`SELECT value FROM jobs WHERE ${filter} AND current=1 ORDER BY time DESC,key`).all(agent, term));
  const rows = db.prepare(`SELECT value,time,key FROM jobs WHERE ${filter} AND current=0
    ${cursor ? "AND (time<? OR (time=? AND key>?))" : ""} ORDER BY time DESC,key LIMIT ?`)
    .all(agent, term, ...(cursor ? [cursor.time, cursor.time, cursor.key] : []), limit + 1);
  const history = decode(rows.slice(0, limit)), last = rows[limit - 1];
  if (page?.selected && ![...current, ...history].some(job => job.id === page.selected)) {
    const selected = decode(db.prepare("SELECT value FROM jobs WHERE agent=? AND id=? AND key NOT LIKE '.runner-archive:%' LIMIT 1")
      .all(agent, page.selected))[0];
    if (selected) (selected.archived || !["incoming", "in_progress"].includes(selected.status) ? history : current).push(selected);
  }
  const nextCursor = rows.length > limit ? Buffer.from(JSON.stringify({ time: last.time, key: last.key })).toString("base64url") : null;
  return { current, history, ...(nextCursor ? { nextCursor } : {}) };
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
