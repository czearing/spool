import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runManagedRunner } from "../packages/bohemia-agent-tooling/src/index.js";
import { readConfiguration } from "./config.mjs";
import { definition } from "./workflow-store.mjs";
import { validateWorkflow } from "./workflow-schema.mjs";
import { executeWorkflow } from "./workflow-executor.mjs";
import { eventSource } from "../packages/workflow/index.mjs";
export { executeWorkflow } from "./workflow-executor.mjs";
import { newRun, nextRun, readRun, writeRun, listRuns } from "./workflow-runs.mjs";
import { createWorkflowEvents } from "./workflow-events.mjs";
import { SpoolStore } from "./spool-store.mjs";
import { withAdmission } from "./admission.mjs";
import { trackPreparation } from "./preparation-progress.mjs";
import { callBohemia } from "../packages/bohemia-pr-mcp/src/client.mjs";

const execute = promisify(execFile);
export async function runCustom(id, entryUrl) {
  const input = process.env.SPOOL_RUNNER_CONFIG ? JSON.parse(process.env.SPOOL_RUNNER_CONFIG)
    : readConfiguration(new URL("../../spool-runners.json", entryUrl));
  const workflow = definition(input, id);
  validateWorkflow(workflow);
  if (eventSource(workflow)) {
    if (!workflow.enabled) {
      const runtime = path.join(path.dirname(fileURLToPath(entryUrl)), ".runner");
      for (const record of listRuns(runtime).filter(row => ["queued", "running"].includes(row.status))) {
        writeRun(runtime, { ...readRun(runtime, record.id), status: "interrupted", finishedAt: new Date().toISOString(),
          error: "Integration workflow was disabled. No event actions were resumed." });
      }
      return;
    }
    const { run } = await import("./run.mjs");
    return run(eventSource(workflow), entryUrl, workflow);
  }
  const runtime = path.join(path.dirname(fileURLToPath(entryUrl)), ".runner");
  const events = createWorkflowEvents(workflow, runtime);
  const needsStore = workflow.nodes.some(node => ["repository", "agent", "command"].includes(node.kind));
  const store = needsStore ? new SpoolStore(input.spool_dir) : null;
  let lifecycle, retryWake, stopping = false;
  const once = !process.argv.includes("--watch") || !workflow.enabled;
  const stop = () => { stopping = true; lifecycle?.stop(); };
  const control = data => {
    if (data.toString().includes("stop")) stop();
    else if (data.toString().includes("run")) lifecycle?.wake();
  };
  if (!once) { process.stdin.on("data", control); process.stdin.once("end", stop); }
  try {
    await runManagedRunner(entryUrl, async value => {
      lifecycle = value;
      value.observe({ configurationRevision: workflow.revision });
      if (stopping) value.stop();
      const scan = async () => {
        clearTimeout(retryWake);
        const queued = nextRun(runtime, workflow);
        const event = queued ? { id: queued.id, input: queued.input } : workflow.enabled ? await events.next() : null;
        if (!event) return { completedSteps: 0, holding: "Waiting for a file change", lastError: null };
        const previous = !queued ? readRun(runtime, event.id) : null;
        if (previous && ["succeeded", "filtered"].includes(previous.status)) {
          events.complete(event);
          return { completedSteps: 0, lastError: null };
        }
        if (previous?.status === "running" || previous?.status === "interrupted") {
          writeRun(runtime, { ...previous, status: "interrupted", finishedAt: new Date().toISOString(),
            error: "Previous attempt was interrupted. Inspect side effects before running again." });
          events.complete(event);
          throw new Error("Previous workflow attempt was interrupted; inspect its execution record before retrying.");
        }
        const eventInput = event.input === undefined ? {} : event.input;
        const record = { ...(queued || newRun(workflow, eventInput, { id: event.id,
          source: workflow.nodes.find(node => ["schedule", "file-change"].includes(node.kind))?.kind || "manual" })),
          status: "running", startedAt: new Date().toISOString() };
        writeRun(runtime, record);
        const finish = () => { if (!queued) events.complete(event); };
        const action = async () => {
          const agent = workflow.nodes.find(node => node.kind === "agent")?.agent;
          const agentStep = workflow.nodes.find(node => node.kind === "agent");
          const existing = agent && store.submission(`workflow:${workflow.id}:${event.id}:${agentStep.id}`);
          if (existing) { finish(); return { taskId: existing.task.id, completedSteps: 0, lastError: null }; }
          store?.assertIdle(agent ?? null, workflow.workspace);
          const result = await executeWorkflow(workflow, update => value.observe(update), execute, {
            store, eventId: event.id, input: eventInput, call: trackPreparation(callBohemia, () => value, runtime),
            recordStep: step => {
              record.steps = [...record.steps.filter(item => item.id !== step.id), step]; writeRun(runtime, record);
            },
          });
          finish();
          return { ...result, holding: null, configurationRevision: workflow.revision };
        };
        try {
          const result = await (store ? withAdmission(input.spool_dir, workflow.nodes.find(node => node.kind === "agent")?.agent || id,
            action, workflow.workspace) : action());
          if (result.holding) {
            writeRun(runtime, { ...record, status: "queued", startedAt: undefined });
            if (!once) retryWake = setTimeout(value.wake, 5000).unref();
            return result;
          }
          writeRun(runtime, { ...record, status: result.filtered ? "filtered" : "succeeded", taskId: result.taskId,
            finishedAt: new Date().toISOString() });
          if (listRuns(runtime).some(run => run.status === "queued")) value.wake();
          return result;
        } catch (error) {
          writeRun(runtime, { ...record, status: "failed", error: error.message, finishedAt: new Date().toISOString() });
          if (listRuns(runtime).some(run => run.status === "queued")) value.wake();
          throw error;
        }
      };
      await value.poll({ once, intervalMs: workflow.intervalSeconds * 1000,
        scan });
    });
    if (!lifecycle) throw new Error("Runner is already executing; duplicate launch refused.");
    if (once && lifecycle.status.lastError) throw new Error(lifecycle.status.lastError);
  } finally {
    clearTimeout(retryWake);
    process.stdin.off("data", control); process.stdin.off("end", stop); process.stdin.pause();
  }
}
