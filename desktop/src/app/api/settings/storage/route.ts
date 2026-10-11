import { readProjectStorage, saveProjectStorage } from "../../../../lib/project-storage";
import { ProjectError } from "../../../../lib/project-error";

export async function GET() {
  try { return Response.json(await readProjectStorage(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) {
    console.error("Cannot read project storage settings.", error);
    return Response.json({ error: "Project storage settings are unavailable. Check the local log." }, { status: 503 });
  }
}
export async function PUT(request: Request) {
  if (!request.headers.get("host") || request.headers.get("origin") !== `${new URL(request.url).protocol}//${request.headers.get("host")}`)
    return Response.json({ error: "Storage changes require a same-origin request." }, { status: 403 });
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return Response.json({ error: "Send storage settings as JSON." }, { status: 415 });
  const text = await request.text();
  if (text.length > 8192) return Response.json({ error: "Storage settings are too large." }, { status: 413 });
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return Response.json({ error: "Invalid storage settings." }, { status: 400 }); }
  try { return Response.json(await saveProjectStorage(value)); }
  catch (error) {
    if (error instanceof ProjectError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Cannot save project storage settings.", error);
    return Response.json({ error: "Could not save this storage location. Check folder permissions and try again." }, { status: 500 });
  }
}
