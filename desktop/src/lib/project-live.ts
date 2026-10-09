import { stat } from "node:fs/promises";
import { join } from "node:path";
import { listAgents } from "./agents";
import { readAgentActivity } from "./agent-activity";
import { countCompletedSpoolItems } from "./spool";
import { hasCode } from "./file-snapshot";
import { readTaskPreparations } from "./task-preparations";
import type { TaskPreparation } from "./task-preparation";
import { readSpoolCompletions } from "./spool-completions";
import type { JobCompletion } from "./job-completions";
import { readAgentAppearance } from "./agent-icons";

export type ProjectLive = { agents: { id: string; active: number; icon?: string; imageVersion?: string | null }[]; successful: number; boardVersion: string; preparations: TaskPreparation[]; completed: JobCompletion[] };
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
  return directories.join("|");
}
export async function readProjectLive(root: string): Promise<ProjectLive> {
  const [agents, counts, successful, boardVersion, preparations, completed] = await Promise.all([
    listAgents(root), readAgentActivity(root), countCompletedSpoolItems(root), readBoardVersion(root), readTaskPreparations(root),
    readSpoolCompletions(root),
  ]);
  if (Object.keys(counts).some((id) => !agents.includes(id))) throw new Error("A running session references an unconfigured agent.");
  return { agents: await Promise.all(agents.map(async (id) => {
    const { icon, imageVersion } = await readAgentAppearance(root, id);
    return { id, active: counts[id] ?? 0, icon, imageVersion };
  })),
    successful, boardVersion, preparations, completed };
}
