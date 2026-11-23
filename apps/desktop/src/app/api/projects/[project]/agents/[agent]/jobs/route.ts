import { AgentError, listAgents } from "../../../../../../../lib/agents";
import { readAgentJobs } from "../../../../../../../lib/agent-jobs";
import { getProjects } from "../../../../../../../lib/projects";

export async function GET(_request: Request, { params }: { params: Promise<{ project: string; agent: string }> }) {
  try {
    const { project: id, agent } = await params;
    const project = (await getProjects()).find(project => project.id === id);
    if (!project) throw new AgentError("Project not found.", 404);
    if (!(await listAgents(project.root)).includes(agent)) throw new AgentError("Agent not found.", 404);
    return Response.json(await readAgentJobs(project.root, agent), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AgentError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Unable to read agent conversations.", error);
    return Response.json({ error: "Could not load conversations. Try again." }, { status: 500 });
  }
}
