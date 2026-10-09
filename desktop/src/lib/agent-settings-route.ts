import { AgentError } from "./agents";
import { getProjects } from "./projects";
import { getModelCatalog } from "./model-catalog";
import { assertAgentSettingsSupported, callAgentTool } from "./spool-agent-client";

type Context = { params: Promise<{ project: string; agent?: string }> };
export async function agentSettingsRoute(request: Request, { params }: Context) {
  try {
    const { project: id, agent } = await params;
    const project = (await getProjects()).find((entry) => entry.id === id);
    if (!project) throw new AgentError("Project not found.", 404);
    if (request.method === "GET" && agent) {
      return Response.json(await callAgentTool(project.root, "spool_get_agent", { name: agent }), { headers: { "Cache-Control": "no-store" } });
    }
    if (request.headers.get("origin") !== `${new URL(request.url).protocol}//${request.headers.get("host")}`) {
      throw new AgentError("Agent changes require a same-origin request.", 403);
    }
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new AgentError("Send agent settings as JSON.", 415);
    const text = await request.text();
    if (Buffer.byteLength(text) > (agent ? 70000 : 200000)) throw new AgentError("Agent request is too large.", 413);
    let input: unknown;
    try { input = JSON.parse(text); } catch { throw new AgentError("Invalid agent JSON."); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new AgentError("Invalid agent settings.");
    await assertAgentSettingsSupported(project.root);
    if ("model" in input && input.model !== null) {
      const current = agent ? await callAgentTool(project.root, "spool_get_agent", { name: agent }) : null;
      if (input.model !== current?.model && !(await getModelCatalog()).some(({ value }) => value === input.model)) {
        throw new AgentError("Choose an available model.");
      }
    }
    const value = await callAgentTool(project.root, agent ? "spool_update_agent" : "spool_create_agent",
      { ...input, ...(agent ? { name: agent } : {}) });
    return Response.json(value, { status: agent ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AgentError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Spool agent request failed.", error);
    return Response.json({ error: "Spool agent settings are unavailable. Check the server log." }, { status: 503 });
  }
}
