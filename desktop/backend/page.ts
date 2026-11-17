import { getProjects } from "../src/lib/projects";
import { listAgents, readAgentPrompt } from "../src/lib/agents";
import { readAgentJobs } from "../src/lib/agent-jobs";
import { readBoardVersion } from "../src/lib/project-live";
import { readTaskBoard } from "../src/lib/board-archive";
import { readSpoolItems } from "../src/lib/spool";
import { readUsage } from "../src/lib/spool-usage";
import { summarizeTasks } from "../src/lib/dashboard";
import { defaultDashboardRange } from "../src/lib/dashboard-range";
import type { PageData } from "../src/desktop/page-data";
import { readRunnerCatalog } from "../src/lib/runner-catalog";

export async function pageData(request: Request): Promise<Response> {
  const search = new URL(request.url).searchParams;
  const pathname = search.get("path") || "/";
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const projects = await getProjects();
  if (!parts.length && projects.length) return Response.json({ redirect: `/${projects[0].id}` });
  if (!parts.length) return Response.json({ projects, agents: [], version: "", page: { kind: "setup" } } satisfies PageData);
  const project = projects.find(item => item.id === parts[0]);
  if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
  const [agents, version, runners] = await Promise.all([
    listAgents(project.root), readBoardVersion(project.root), readRunnerCatalog(project.root),
  ]);
  if (parts[1] === "runners" && runners.error && !runners.configured)
    return Response.json({ error: runners.error }, { status: 503 });
  if (parts[1] === "runners" && parts.length === 2) {
    return Response.json({ redirect: runners.runners[0] ? `/${project.id}/runners/${runners.runners[0].id}` : `/${project.id}` });
  }
  const runner = runners.runners.find(runner => runner.id === parts[2]);
  let page: PageData["page"];
  if (parts.length === 1) {
    const [items, usage] = await Promise.all([readSpoolItems(project.root), readUsage(project.root)]);
    page = { kind: "dashboard", initial: summarizeTasks(items, new Date(), defaultDashboardRange, agents, usage) };
  } else if (parts[1] === "tasks" && parts.length === 2) {
    page = { kind: "tasks", board: await readTaskBoard(project.root) };
  } else if (parts[1] === "runners" && parts.length === 3 && runner) {
    page = { kind: "runner", runner };
  }
  else if (parts[1] === "agents" && agents.includes(parts[2]) && parts.length === 3) {
    page = { kind: "agent", agent: parts[2],
      ...(search.get("deferAgentJobs") === "2" ? {} : { jobs: await readAgentJobs(project.root, parts[2]) }) };
  } else if (parts[1] === "agents" && agents.includes(parts[2]) && parts[3] === "prompt" && parts.length === 4) {
    page = { kind: "prompt", document: await readAgentPrompt(project.root, parts[2]) };
  } else return Response.json({ error: "Page not found." }, { status: 404 });
  return Response.json({ projects, project, agents, version, runners, page } satisfies PageData);
}
