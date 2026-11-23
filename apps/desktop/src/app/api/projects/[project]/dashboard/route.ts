import { getProjects } from "../../../../../lib/projects";
import { readSpoolItems } from "../../../../../lib/spool";
import { summarizeTasks } from "../../../../../lib/dashboard";
import { defaultDashboardRange, isDashboardRange } from "../../../../../lib/dashboard-range";
import { listAgents } from "../../../../../lib/agents";
import { readUsage } from "../../../../../lib/spool-usage";

export async function GET(request: Request, { params }: { params: Promise<{ project: string }> }) {
  const range = new URL(request.url).searchParams.get("range") ?? defaultDashboardRange;
  if (!isDashboardRange(range)) return Response.json({ error: "Choose a supported timeline." }, { status: 400 });
  try {
    const id = (await params).project, project = (await getProjects()).find((item) => item.id === id);
    if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
    const [items, agents, usage] = await Promise.all([readSpoolItems(project.root), listAgents(project.root), readUsage(project.root)]);
    return Response.json(summarizeTasks(items, new Date(), range, agents, usage), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Unable to read task dashboard.", error);
    return Response.json({ error: "Task analytics are unavailable. Check the server log." }, { status: 503 });
  }
}
