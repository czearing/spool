import { getProjects } from "../src/lib/projects";
import { listAgents, readAgentPrompt } from "../src/lib/agents";
import { readBoardVersion } from "../src/lib/project-live";
import { readTaskBoard } from "../src/lib/board-archive";
import { readTaskPreparations } from "../src/lib/task-preparations";
import { readAgentJobs } from "../src/lib/agent-jobs";
import { readSpoolItems } from "../src/lib/spool";
import { readUsage } from "../src/lib/spool-usage";
import { summarizeTasks } from "../src/lib/dashboard";
import { defaultDashboardRange } from "../src/lib/dashboard-range";
import type { PageData } from "../src/desktop/page-data";

export async function pageData(request: Request): Promise<Response> {
  const pathname = new URL(request.url).searchParams.get("path") || "/";
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const projects = await getProjects();
  if (!parts.length && projects.length) return Response.json({ redirect: `/${projects[0].id}` });
  if (!parts.length) return Response.json({ projects, agents: [], version: "", page: { kind: "setup" } } satisfies PageData);
  const project = projects.find(item => item.id === parts[0]);
  if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
  const [agents, version] = await Promise.all([listAgents(project.root), readBoardVersion(project.root)]);
  let page: PageData["page"];
  if (parts.length === 1) {
    const [items, usage] = await Promise.all([readSpoolItems(project.root), readUsage(project.root)]);
    page = { kind: "dashboard", initial: summarizeTasks(items, new Date(), defaultDashboardRange, agents, usage) };
  } else if (parts[1] === "tasks" && parts.length === 2) {
    const [board, preparations] = await Promise.all([readTaskBoard(project.root), readTaskPreparations(project.root)]);
    page = { kind: "tasks", board, preparations };
  } else if (parts[1] === "runners" && parts.length === 2) page = { kind: "runners" };
  else if (parts[1] === "runners" && parts.length === 3) page = { kind: "workflow", runner: parts[2] };
  else if (parts[1] === "agents" && agents.includes(parts[2]) && parts.length === 3) {
    page = { kind: "agent", agent: parts[2], jobs: await readAgentJobs(project.root, parts[2]) };
  } else if (parts[1] === "agents" && agents.includes(parts[2]) && parts[3] === "prompt" && parts.length === 4) {
    page = { kind: "prompt", document: await readAgentPrompt(project.root, parts[2]) };
  } else return Response.json({ error: "Page not found." }, { status: 404 });
  return Response.json({ projects, project, agents, version, page } satisfies PageData);
}
