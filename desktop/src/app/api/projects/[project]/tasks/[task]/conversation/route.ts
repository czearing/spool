import { createHash } from "node:crypto";
import { getProjects } from "../../../../../../../lib/projects";
import { readConversation, sendTaskMessage } from "../../../../../../../lib/spool-conversation";
import { readConversationTask } from "../../../../../../../lib/conversation-store";
import { ConversationError } from "../../../../../../../lib/task-conversation";
import { TaskSubmissionError } from "../../../../../../../lib/task-submission";

type Context = { params: Promise<{ project: string; task: string }> };
async function projectTask(context: Context) {
  const { project: id, task } = await context.params, projects = await getProjects(), project = projects.find((item) => item.id === id);
  if (!project) throw new ConversationError("Project not found.", 404);
  if (readConversationTask(project.root, task)) return { root: project.root, task };
  const owners = projects.filter((item) => item.id !== id && readConversationTask(item.root, task));
  return { root: owners.length === 1 ? owners[0].root : project.root, task };
}
function failure(error: unknown) {
  if (error instanceof ConversationError || error instanceof TaskSubmissionError) {
    return Response.json({ error: error.message, rejected: error.rejected }, { status: error.status });
  }
  console.error("Spool conversation failed.", error);
  return Response.json({ error: "Conversation unavailable. Check the server log and retry." }, { status: 500 });
}
export async function GET(request: Request, context: Context) {
  try {
    const { root, task } = await projectTask(context), params = new URL(request.url).searchParams;
    const before = params.has("before") ? Number(params.get("before")) : null;
    const body = JSON.stringify(await readConversation(root, task, before, params.get("events") === "1"));
    const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
    const unchanged = request.headers.get("if-none-match")?.split(",")
      .some(value => value.trim().replace(/^W\//, "") === etag || value.trim() === "*");
    return new Response(unchanged ? null : body, { status: unchanged ? 304 : 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ETag: etag } });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  const host = request.headers.get("host");
  if (!host || request.headers.get("origin") !== `${new URL(request.url).protocol}//${host}`) {
    return Response.json({ error: "Messaging requires a same-origin request." }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return Response.json({ error: "Send the message as JSON." }, { status: 415 });
  }
  const body = await request.text();
  if (Buffer.byteLength(body) > 400_000) return Response.json({ error: "Message request is too large." }, { status: 413 });
  let input: unknown;
  try { input = JSON.parse(body); }
  catch { return Response.json({ error: "Invalid message request." }, { status: 400 }); }
  try {
    const { root, task } = await projectTask(context);
    return Response.json(await sendTaskMessage(root, task, input), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
