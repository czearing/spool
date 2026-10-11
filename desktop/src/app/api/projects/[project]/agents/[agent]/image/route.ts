import { AgentError } from "../../../../../../../lib/agents";
import { getProjects } from "../../../../../../../lib/projects";
import { decodeAgentImage, readAgentAppearance } from "../../../../../../../lib/agent-icons";

export async function GET(request: Request, { params }: { params: Promise<{ project: string; agent: string }> }) {
  try {
    const { project: id, agent } = await params;
    const project = (await getProjects()).find((entry) => entry.id === id);
    if (!project) throw new AgentError("Project not found.", 404);
    const { image, imageVersion } = await readAgentAppearance(project.root, agent);
    if (!image) throw new AgentError("Agent image not found.", 404);
    const version = new URL(request.url).searchParams.get("v");
    if (version && version !== imageVersion) throw new AgentError("Agent image changed.", 404);
    const { bytes, type } = decodeAgentImage(image);
    return new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": type, "X-Content-Type-Options": "nosniff",
      "Cache-Control": version ? "private, max-age=31536000, immutable" : "no-store",
    } });
  } catch (error) {
    if (error instanceof AgentError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Could not read agent image.", error);
    return Response.json({ error: "Agent image is unavailable." }, { status: 503 });
  }
}
