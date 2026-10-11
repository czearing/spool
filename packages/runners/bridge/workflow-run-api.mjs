import { timingSafeEqual } from "node:crypto";
import { enqueueRun, listRuns, readRun } from "./workflow-runs.mjs";

const fail = (message, status) => { throw Object.assign(new Error(message), { status }); };
export async function workflowRunRequest(workflow, runtime, method, input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Execution settings must be an object.", 400);
  if (method === "RUNS") {
    if (input.executionId) {
      const record = readRun(runtime, input.executionId);
      if (!record) fail("Execution not found.", 404);
      return record;
    }
    return listRuns(runtime).slice(0, 20).map(({ id, status, source, createdAt, startedAt, finishedAt, error, taskId }) =>
      ({ id, status, source, createdAt, startedAt, finishedAt, error, taskId }));
  }
  if (workflow.kind !== "custom") fail("Integration events run automatically; manual execution is not supported.", 400);
  if (method === "WEBHOOK") {
    const trigger = workflow.nodes.find(node => node.kind === "webhook");
    if (!workflow.enabled || !trigger) fail("Webhook is not enabled.", 409);
    const token = process.env[trigger.secretEnv];
    if (!token || token.length < 32) fail("Webhook token is not configured on the UI server.", 503);
    const expected = Buffer.from(`Bearer ${token}`), actual = Buffer.from(input.authorization || "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail("Webhook authentication failed.", 401);
  } else if (method !== "RUN") fail("Unsupported execution request.", 405);
  if (method === "RUN" && input.revision !== workflow.revision) fail("Save or reload the workflow before running it.", 409);
  const record = await enqueueRun(workflow, runtime, input.input === undefined ? {} : input.input, {
    id: input.executionId, source: method === "WEBHOOK" ? "webhook" : "manual",
  });
  return { id: record.id, status: record.status, createdAt: record.createdAt };
}
