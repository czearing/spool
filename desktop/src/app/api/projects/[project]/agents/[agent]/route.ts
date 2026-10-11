import { AgentError, deleteAgent, readAgentPrompt, saveAgentPrompt } from "../../../../../../lib/agents";
import { getProjects } from "../../../../../../lib/projects";

type Context = { params: Promise<{ project: string; agent: string }> };
function sameOrigin(request: Request) {
  const host = request.headers.get("host");
  return host && request.headers.get("origin") === `${new URL(request.url).protocol}//${host}`;
}
export async function GET(request: Request, { params }: Context) {
  try {
    const { project: id, agent } = await params;
    const project = (await getProjects()).find((project) => project.id === id);
    if (!project) throw new AgentError("Project not found.", 404);
    return Response.json(await readAgentPrompt(project.root, agent, new URL(request.url).searchParams.get("scope") === "context" ? "context" : "prompt"),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AgentError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Unable to read agent prompt.", error);
    return Response.json({ error: "Could not read the prompt. Check the server log." }, { status: 500 });
  }
}
export async function PUT(request: Request, { params }: { params: Promise<{ project: string; agent: string }> }) {
  if (!sameOrigin(request)) {
    return Response.json({ error: "Prompt changes require a same-origin request." }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return Response.json({ error: "Send the prompt as JSON." }, { status: 415 });
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > 150_000) return Response.json({ error: "The prompt is too large." }, { status: 413 });
  let input: unknown;
  try { input = JSON.parse(text); }
  catch { return Response.json({ error: "Invalid prompt request." }, { status: 400 }); }
  try {
    const { project: id, agent } = await params;
    const project = (await getProjects()).find((project) => project.id === id);
    if (!project) throw new AgentError("Project not found.", 404);
    return Response.json(await saveAgentPrompt(project.root, agent, input, new URL(request.url).searchParams.get("scope") === "context" ? "context" : "prompt"),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AgentError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Unable to save agent prompt.", error);
    return Response.json({ error: "Could not save the prompt. Your edits are kept here. Check the server log and try again." }, { status: 500 });
  }
}
export async function DELETE(request: Request, { params }: Context) {
  if (!sameOrigin(request)) return Response.json({ error: "Agent deletion requires a same-origin request." }, { status: 403 });
  try {
    const { project: id, agent } = await params;
    const project = (await getProjects()).find((project) => project.id === id);
    if (!project) throw new AgentError("Project not found.", 404);
    await deleteAgent(project.root, agent);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AgentError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Unable to delete agent.", error);
    return Response.json({ error: "Could not delete the agent. Check the server log and try again." }, { status: 500 });
  }
}
