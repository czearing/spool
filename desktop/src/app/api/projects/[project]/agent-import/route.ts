import { AgentError } from "../../../../../lib/agents";
import { agentCatalog, importAgent } from "../../../../../lib/agent-import";

type Context = { params: Promise<{ project: string }> };
export async function GET(_request: Request, { params }: Context) {
  try { return Response.json(await agentCatalog((await params).project), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request, { params }: Context) {
  if (!request.headers.get("host") || request.headers.get("origin") !== `${new URL(request.url).protocol}//${request.headers.get("host")}`)
    return Response.json({ error: "Agent imports require a same-origin request." }, { status: 403 });
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    return Response.json({ error: "Send import details as JSON." }, { status: 415 });
  const text = await request.text();
  if (Buffer.byteLength(text) > 24000) return Response.json({ error: "Import details are too large." }, { status: 413 });
  let input: unknown;
  try { input = JSON.parse(text); } catch { return Response.json({ error: "Invalid import details." }, { status: 400 }); }
  try { return Response.json(await importAgent((await params).project, input), { status: 201 }); }
  catch (error) { return failure(error); }
}
function failure(error: unknown) {
  if (error instanceof AgentError) return Response.json({ error: error.message }, { status: error.status });
  console.error("Agent import failed.", error);
  return Response.json({ error: "Could not import the agent. Check the local log and reload before retrying." }, { status: 503 });
}
