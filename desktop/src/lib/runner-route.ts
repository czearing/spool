import { getProjects } from "./projects";
import { runnerRequest, RunnerWorkflowError } from "./runner-workflow-client";

export type RunnerRouteContext = { params: Promise<{ project: string; runner: string }> };
async function jsonBody(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
    throw new RunnerWorkflowError("Send JSON input.", 415);
  const reader = request.body?.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 100000) { await reader.cancel(); throw new RunnerWorkflowError("Runner request is too large.", 413); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RunnerWorkflowError("Invalid JSON."); }
}
export async function runnerRoute(request: Request, { params }: RunnerRouteContext, mode: "definition" | "runs" | "webhook" = "definition") {
  try {
    const host = request.headers.get("host") || "", url = new URL(request.url);
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host))
      throw new RunnerWorkflowError("Runner access requires a local host.", 403);
    if (request.method !== "GET" && mode !== "webhook" && request.headers.get("origin") !== `${url.protocol}//${host}`)
      throw new RunnerWorkflowError("Runner changes require a same-origin request.", 403);
    const { project: id, runner } = await params;
    const project = (await getProjects()).find(entry => entry.id === id);
    if (!project) throw new RunnerWorkflowError("Project not found.", 404);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(runner)) throw new RunnerWorkflowError("Invalid runner identity.");
    let input = request.method === "GET" ? undefined : await jsonBody(request);
    let method = request.method;
    if (mode === "runs") {
      method = request.method === "GET" ? "RUNS" : "RUN";
      if (method === "RUNS") input = { executionId: url.searchParams.get("execution") || undefined };
    }
    if (mode === "webhook") {
      method = "WEBHOOK";
      input = { input, executionId: request.headers.get("idempotency-key") || undefined, authorization: request.headers.get("authorization") };
    }
    const value = await runnerRequest(project.root, runner, method, input);
    return Response.json(value, { status: ["RUN", "WEBHOOK"].includes(method) ? 202 : method === "POST" ? 201 : 200,
      headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RunnerWorkflowError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Runner request failed.", error);
    return Response.json({ error: "Runner request failed. Check the server log." }, { status: 503 });
  }
}
