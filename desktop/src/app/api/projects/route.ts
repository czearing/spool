import { createProject, ProjectError } from "../../../lib/projects";

export async function POST(request: Request) {
  const host = request.headers.get("host");
  if (!host || request.headers.get("origin") !== `${new URL(request.url).protocol}//${host}`) {
    return Response.json({ error: "Project changes require a same-origin request." }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return Response.json({ error: "Send project details as JSON." }, { status: 415 });
  }
  const text = await request.text();
  if (text.length > 8192) return Response.json({ error: "Project details are too large." }, { status: 413 });
  let input: unknown;
  try { input = JSON.parse(text); }
  catch { return Response.json({ error: "Invalid project details." }, { status: 400 }); }
  try {
    const { id, name } = await createProject(input);
    return Response.json({ id, name }, { status: 201 });
  } catch (error) {
    if (error instanceof ProjectError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Unable to save project settings.", error);
    return Response.json({ error: "Could not save project settings. Check the server log and try again." }, { status: 500 });
  }
}
