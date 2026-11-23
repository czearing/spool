import { getProjects } from "../../../../../lib/projects";
import { readRunners } from "../../../../../lib/runner-client";
import { runnerEvents } from "../../../../../lib/runner-events";

export async function GET(request: Request, { params }: { params: Promise<{ project: string }> }) {
  try {
    const { project: projectId } = await params;
    const project = (await getProjects()).find(({ id }) => id === projectId);
    if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
    if (request.headers.get("accept")?.includes("text/event-stream")) return runnerEvents(project.root, request.signal);
    return Response.json(await readRunners(project.root), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Cannot verify runner status.", error);
    return Response.json({ error: "Runner status is unavailable. Connection and activity could not be verified." },
      { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
