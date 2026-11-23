import { BoardArchiveError, setTaskArchived } from "../../../../../../../lib/board-archive";
import { getProjects } from "../../../../../../../lib/projects";

export async function POST(request: Request, { params }: { params: Promise<{ project: string; task: string }> }) {
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
  if (!value || typeof value !== "object" || Object.keys(value).length !== 1 ||
    !("archived" in value) || typeof value.archived !== "boolean") {
    return Response.json({ error: "Choose whether to archive the conversation." }, { status: 400 });
  }
  try {
    const { project: id, task } = await params, project = (await getProjects()).find((entry) => entry.id === id);
    if (!project) throw new BoardArchiveError("Project not found.", 404);
    return Response.json(await setTaskArchived(project.root, task, value.archived), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof BoardArchiveError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Unable to change conversation archive.", error);
    return Response.json({ error: "Could not confirm archiving. Refresh before retrying." }, { status: 500 });
  }
}
