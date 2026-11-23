import { AgentError, listAgents } from "../../../../../../../lib/agents";
import { readAgentJobs } from "../../../../../../../lib/agent-jobs";
import { getProjects } from "../../../../../../../lib/projects";

export async function GET(request: Request, { params }: { params: Promise<{ project: string; agent: string }> }) {
  try {
    const { project: id, agent } = await params;
    const project = (await getProjects()).find(project => project.id === id);
    if (!project) throw new AgentError("Project not found.", 404);
    if (!(await listAgents(project.root)).includes(agent)) throw new AgentError("Agent not found.", 404);
    const search = new URL(request.url).searchParams;
    return Response.json(await readAgentJobs(project.root, agent, {
      cursor: search.get("cursor") || undefined, search: search.get("search") || undefined,
      selected: search.get("selected") || undefined,
      limit: search.has("limit") ? Number(search.get("limit")) : undefined,
    }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RangeError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof AgentError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Unable to read agent conversations.", error);
    return Response.json({ error: "Could not load conversations. Try again." }, { status: 500 });
  }
}
