import { deleteProject, ProjectError } from "../../../../lib/projects";

export async function DELETE(request: Request, { params }: { params: Promise<{ project: string }> }) {
  const host = request.headers.get("host");
  if (!host || request.headers.get("origin") !== `${new URL(request.url).protocol}//${host}`) {
    return Response.json({ error: "Project deletion requires a same-origin request." }, { status: 403 });
  }
  try {
    const { project } = await params;
    return Response.json(await deleteProject(project), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ProjectError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Unable to delete project.", error);
    return Response.json({ error: "Could not delete the project. Check the server log and try again." }, { status: 500 });
  }
}
