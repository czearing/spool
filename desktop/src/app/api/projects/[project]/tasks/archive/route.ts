import { archiveBoardColumn, BoardArchiveError } from "../../../../../../lib/board-archive";
import { getProjects } from "../../../../../../lib/projects";

export async function POST(request: Request, { params }: { params: Promise<{ project: string }> }) {
  const host = request.headers.get("host");
  if (!host || request.headers.get("origin") !== `${new URL(request.url).protocol}//${host}`) {
    return Response.json({ error: "Archiving requires a same-origin request." }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return Response.json({ error: "Send the archive request as JSON." }, { status: 415 });
  }
  const body = await request.text();
  if (Buffer.byteLength(body) > 1024) return Response.json({ error: "Archive request is too large." }, { status: 413 });
  let value: unknown;
  try { value = JSON.parse(body); }
  catch { return Response.json({ error: "Invalid archive request." }, { status: 400 }); }
  if (!value || typeof value !== "object" || !("status" in value) || Object.keys(value).length !== 1) {
    return Response.json({ error: "Choose a task column to archive." }, { status: 400 });
  }
  try {
    const { project: id } = await params, project = (await getProjects()).find((entry) => entry.id === id);
    if (!project) throw new BoardArchiveError("Project not found.", 404);
    return Response.json(await archiveBoardColumn(project.root, value.status), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof BoardArchiveError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Unable to archive board tasks.", error);
    return Response.json({ error: "Could not confirm archiving. Refresh the board before retrying." }, { status: 500 });
  }
}
