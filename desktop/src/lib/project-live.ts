import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { listAgents } from "./agents";
import { readAgentActivity } from "./agent-activity";
import { countCompletedSpoolItems } from "./spool";
import { hasCode } from "./file-snapshot";
import { readTaskPreparations } from "./task-preparations";
import type { TaskPreparation } from "./task-preparation";
import { readAgentAppearance } from "./agent-icons";
import { selectAgentJobs, type AgentJob, type AgentJobs } from "./agent-jobs";
import { readTaskBoard } from "./board-archive";

export type ProjectLive = {
  agents: { id: string; title?: string; active: number; pending?: number; starting?: number; icon?: string; imageVersion?: string | null }[];
  successful: number; boardVersion: string; preparations: TaskPreparation[];
  jobs?: { agent: string; data: AgentJobs };
};
export async function readBoardVersion(root: string) {
  const directories = await Promise.all(["incoming", "in_progress", "completed", "failed", ".runner-archive"].map(async (name) => {
    try { const info = await stat(join(root, "queues", name)); return `${name}:${info.mtimeMs}:${info.ctimeMs}`; }
    catch (error) { if (name === ".runner-archive" && hasCode(error, "ENOENT")) return `${name}:missing`; throw error; }
  }));
  for (const [directory, name] of [["controls", "ui-archive.json"], ["controls", "ui-archive"], ["usage", "accounting.json"]]) {
    try {
      const info = await stat(/* turbopackIgnore: true */ join(/* turbopackIgnore: true */ root, directory, name));
      directories.push(`${directory}:${name}:${info.mtimeMs}:${info.ctimeMs}`);
    } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  }
  directories.push(createHash("sha256").update(JSON.stringify(await readTaskPreparations(root))).digest("hex"));
  return directories.join("|");
}
export async function readProjectLive(root: string, agent?: string): Promise<ProjectLive> {
  const [boardVersion, agents, activity, successful, board] = await Promise.all([
    readBoardVersion(root), listAgents(root), readAgentActivity(root), countCompletedSpoolItems(root), readTaskBoard(root),
  ]);
  const preparations = [...board.items, ...board.archived].flatMap(item => item.preparation ? [item.preparation] : []);
  if (Object.keys(activity.active).some((id) => !agents.includes(id))) throw new Error("A running session references an unconfigured agent.");
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
  if (agent && agents.includes(agent)) {
    const jobs = selectAgentJobs(board, agent);
    const withActivity = (job: AgentJob): AgentJob => ({ ...job, activity: work.get(job.id)?.state });
    selected = { agent, data: { current: jobs.current.map(withActivity), history: jobs.history.map(withActivity) } };
  }
  return { agents: await Promise.all(agents.map(async (id) => {
    const { title, icon, imageVersion } = await readAgentAppearance(root, id);
    return { id, title, active: activity.active[id] ?? 0,
      pending: counts.get(id)?.pending ?? 0,
      starting: counts.get(id)?.starting ?? 0, icon, imageVersion };
  })),
    successful, boardVersion, preparations, ...(selected ? { jobs: selected } : {}) };
}
