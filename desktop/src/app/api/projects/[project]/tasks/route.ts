import { AgentError } from "../../../../../lib/agents";
import { getProjects } from "../../../../../lib/projects";
import { readSpoolSubmission, submitSpoolTask } from "../../../../../lib/spool-submit";
import { TaskSubmissionError } from "../../../../../lib/task-submission";

export async function POST(request: Request, { params }: { params: Promise<{ project: string }> }) {
  const host = request.headers.get("host");
  if (!host || request.headers.get("origin") !== `${new URL(request.url).protocol}//${host}`) {
    return Response.json({ error: "Task creation requires a same-origin request." }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return Response.json({ error: "Send the task as JSON." }, { status: 415 });
  }
  const body = await request.text();
  if (Buffer.byteLength(body) > 850_000) return Response.json({ error: "Task request is too large." }, { status: 413 });
  let input: unknown;
  try { input = JSON.parse(body); }
  catch { return Response.json({ error: "Invalid task request." }, { status: 400 }); }
  try {
    const { project: id } = await params, project = (await getProjects()).find((project) => project.id === id);
    if (!project) throw new TaskSubmissionError("Project not found.", 404);
    const result = await submitSpoolTask(project.root, input);
    return Response.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof TaskSubmissionError || error instanceof AgentError) {
      return Response.json({ error: error.message, rejected: error instanceof TaskSubmissionError && error.rejected }, { status: error.status });
    }
    console.error("Unable to submit Spool task.", error);
    return Response.json({ error: "Could not confirm task creation. Retry the same submission; it may already have been sent. Check the server log." }, { status: 500 });
  }
}
export async function GET(request: Request, { params }: { params: Promise<{ project: string }> }) {
  try {
    const { project: id } = await params, project = (await getProjects()).find((project) => project.id === id);
    if (!project) throw new TaskSubmissionError("Project not found.", 404);
    const result = await readSpoolSubmission(project.root, new URL(request.url).searchParams.get("requestId") ?? "");
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof TaskSubmissionError) {
      return Response.json({ error: error.message, rejected: error.rejected }, { status: error.status });
    }
    console.error("Unable to read task submission.", error);
    return Response.json({ error: "Could not confirm task creation. Retry the same submission." }, { status: 500 });
  }
}
