import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { listAgents } from "./agents";
import { readAgentActivity } from "./agent-activity";
import { countCompletedSpoolItems } from "./spool";
import { hasCode } from "./file-snapshot";
import { readTaskPreparations } from "./task-preparations";
import type { TaskPreparation } from "./task-preparation";
import { readAgentAppearance } from "./agent-icons";
import { readAgentJobs, type AgentJob, type AgentJobs } from "./agent-jobs";

const activityChanges = new EventEmitter();
activityChanges.setMaxListeners(0);
type Activity = Awaited<ReturnType<typeof readAgentActivity>>;
const activityCache = new Map<string, { value: Activity; checked: number; generation: number; pending?: Promise<void>; error?: string }>();
export function watchActivity(root: string, changed: () => void) {
  activityChanges.on(root, changed);
  return () => { activityChanges.off(root, changed); };
}
export function invalidateActivity(root: string) {
  const saved = activityCache.get(root);
  if (saved) { saved.checked = 0; saved.generation++; }
}
function activitySnapshot(root: string) {
  let saved = activityCache.get(root);
  if (!saved) { saved = { value: { active: {}, work: [] }, checked: 0, generation: 0 }; activityCache.set(root, saved); }
  const entry = saved;
  if (!entry.pending && Date.now() - entry.checked >= 5000) {
    const generation = entry.generation;
    entry.pending = readAgentActivity(root).then(value => {
      entry.value = value; entry.error = undefined;
    }, () => { entry.error = "Live process status is unavailable. Saved conversations are still available."; })
      .finally(() => { entry.checked = entry.generation === generation ? Date.now() : 0; entry.pending = undefined; activityChanges.emit(root); });
  }
  return { ...entry.value, error: entry.error ?? (entry.checked ? undefined : "Checking live process status...") };
}

export type ProjectLive = {
  agents: { id: string; title?: string; active: number; pending?: number; starting?: number; icon?: string; imageVersion?: string | null }[];
  successful: number; boardVersion: string; preparations: TaskPreparation[];
  jobs?: { agent: string; data: AgentJobs };
  activityError?: string;
};
export async function readBoardVersion(root: string) {
  const directories = await Promise.all(["incoming", "in_progress", "completed", "failed", ".runner-archive"].map(async (name) => {
    try { const info = await stat(join(root, "queues", name)); return `${name}:${info.mtimeMs}:${info.ctimeMs}`; }
    catch (error) { if (name === ".runner-archive" && hasCode(error, "ENOENT")) return `${name}:missing`; throw error; }
  }));
  for (const [directory, name] of [["controls", "ui-archive.json"], ["controls", "ui-archive"], ["controls", "failure-origins"], ["usage", "accounting.json"]]) {
    try {
      const info = await stat(/* turbopackIgnore: true */ join(/* turbopackIgnore: true */ root, directory, name));
      directories.push(`${directory}:${name}:${info.mtimeMs}:${info.ctimeMs}`);
    } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  }
  directories.push(createHash("sha256").update(JSON.stringify(await readTaskPreparations(root))).digest("hex"));
  return directories.join("|");
}
export async function readProjectLive(root: string, agent?: string): Promise<ProjectLive> {
  const [boardVersion, agents, successful, preparations, jobs] = await Promise.all([
    readBoardVersion(root), listAgents(root), countCompletedSpoolItems(root), readTaskPreparations(root),
    agent ? readAgentJobs(root, agent) : undefined,
  ]);
  const activity = activitySnapshot(root);
  const work = new Map(activity.work.map(item => [item.id, item]));
  for (const preparation of preparations) if (preparation.stage !== "failed" && !work.has(preparation.id))
    work.set(preparation.id, { id: preparation.id, agent: preparation.agent, state: "pending" });
  const counts = new Map<string, { pending: number; starting: number }>();
  for (const item of work.values()) {
    const count = counts.get(item.agent) ?? { pending: 0, starting: 0 };
    if (item.state === "pending" || item.state === "starting") count[item.state]++;
    counts.set(item.agent, count);
  }
  let selected: ProjectLive["jobs"];
  if (agent && jobs && agents.includes(agent)) {
    const withActivity = (job: AgentJob): AgentJob => ({ ...job, activity: work.get(job.id)?.state });
    selected = { agent, data: { ...jobs, current: jobs.current.map(withActivity), history: jobs.history.map(withActivity) } };
  }
  return { agents: await Promise.all(agents.map(async (id) => {
    const { title, icon, imageVersion } = await readAgentAppearance(root, id);
    return { id, title, active: activity.active[id] ?? 0,
      pending: counts.get(id)?.pending ?? 0,
      starting: counts.get(id)?.starting ?? 0, icon, imageVersion };
  })),
    successful, boardVersion, preparations, activityError: activity.error, ...(selected ? { jobs: selected } : {}) };
}
