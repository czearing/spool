import { getProjects } from "../../../../../lib/projects";
import { completionEvents, readSpoolCompletions } from "../../../../../lib/spool-completions";

export async function GET(request: Request, { params }: { params: Promise<{ project: string }> }) {
  try {
    const id = (await params).project, project = (await getProjects()).find(item => item.id === id);
    if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
    if (request.headers.get("accept")?.includes("text/event-stream")) return completionEvents(project.root, request.signal);
    return Response.json(await readSpoolCompletions(project.root), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Unable to read job completions.", error);
    return Response.json({ error: "Job completions are unavailable." }, { status: 503 });
  }
}
