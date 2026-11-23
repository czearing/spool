import { getProjects } from "../../../../../lib/projects";
import { readProjectLive } from "../../../../../lib/project-live";
import { projectEvents } from "../../../../../lib/project-events";

export async function GET(request: Request, { params }: { params: Promise<{ project: string }> }) {
  try {
    const id = (await params).project, project = (await getProjects()).find((item) => item.id === id);
    if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
    const agent = new URL(request.url).searchParams.get("agent") || undefined;
    if (agent && !/^[a-zA-Z0-9_-]+$/.test(agent)) return Response.json({ error: "Invalid agent." }, { status: 400 });
    if (request.headers.get("accept")?.includes("text/event-stream")) return projectEvents(project.root, request.signal, agent);
    return Response.json(await readProjectLive(project.root, agent), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Unable to refresh project activity.", error);
    return Response.json({ error: "Live activity is unavailable. Check the server log." }, { status: 503 });
  }
}
