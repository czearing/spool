import { getProjects } from "../../../../../lib/projects";
import { readProjectLive } from "../../../../../lib/project-live";

export async function GET(_request: Request, { params }: { params: Promise<{ project: string }> }) {
  try {
    const id = (await params).project, project = (await getProjects()).find((item) => item.id === id);
    if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
    return Response.json(await readProjectLive(project.root), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Unable to refresh project activity.", error);
    return Response.json({ error: "Live activity is unavailable. Check the server log." }, { status: 503 });
  }
}
