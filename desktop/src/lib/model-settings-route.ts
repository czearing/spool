import { AgentError } from "./agents";
import { getProjects } from "./projects";
import { readModelSettings, saveModelSettings } from "./model-settings";
import { getModelCatalog } from "./model-catalog";

type Context = { params: Promise<{ project: string; agent?: string }> };
export async function modelSettingsRoute(request: Request, { params }: Context) {
  try {
    const { project: id, agent } = await params;
    const project = (await getProjects()).find((project) => project.id === id);
    if (!project) throw new AgentError("Project not found.", 404);
    if (request.method === "GET") {
      return Response.json(await readModelSettings(project.root, agent), { headers: { "Cache-Control": "no-store" } });
    }
    if (request.headers.get("origin") !== `${new URL(request.url).protocol}//${request.headers.get("host")}`) {
      throw new AgentError("Settings changes require a same-origin request.", 403);
    }
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new AgentError("Send settings as JSON.", 415);
    const text = await request.text();
    if (Buffer.byteLength(text) > 2048) throw new AgentError("Settings request is too large.", 413);
    let input: unknown;
    try { input = JSON.parse(text); } catch { throw new AgentError("Invalid settings JSON."); }
    if (input && typeof input === "object" && "model" in input && input.model !== null) {
      const current = await readModelSettings(project.root, agent);
      if (input.model !== current.model && !(await getModelCatalog()).some(({ value }) => value === input.model)) {
        throw new AgentError("Choose an available model.");
      }
    }
    return Response.json(await saveModelSettings(project.root, agent, input), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AgentError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Unable to load or save Spool model settings.", error);
    return Response.json({ error: "Spool settings are unavailable. Check the server log and retry." }, { status: 503 });
  }
}
