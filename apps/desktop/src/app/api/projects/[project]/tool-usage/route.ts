import { getProjects } from "../../../../../lib/projects";
import { defaultDashboardRange, isDashboardRange } from "../../../../../lib/dashboard-range";
import { readToolUsage } from "../../../../../lib/spool-tool-usage";

export async function GET(request: Request, { params }: { params: Promise<{ project: string }> }) {
  const range = new URL(request.url).searchParams.get("range") ?? defaultDashboardRange;
  if (!isDashboardRange(range)) return Response.json({ error: "Choose a supported timeline." }, { status: 400 });
  try {
    const id = (await params).project, project = (await getProjects()).find((item) => item.id === id);
    if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
    return Response.json(await readToolUsage(project.root, range), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Unable to read tool usage.", error);
    return Response.json({ error: "Tool usage is unavailable. Check the server log." }, { status: 503 });
  }
}
