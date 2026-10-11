import { createHash } from "node:crypto";
import { executeWorkflow } from "./workflow-executor.mjs";
import { executeBlock } from "./workflow-blocks.mjs";
import { validateWorkflow, executionSettings } from "./workflow-schema.mjs";
import { newRun, readRun, writeRun } from "./workflow-runs.mjs";
import { verifyEventWorkspace } from "./workflow-workspace.mjs";
import { eventSource } from "@spool/workflow";

export const filteredEvent = error => error?.code === "WORKFLOW_FILTERED";
export function bindEventQueue(queue, pipeline) {
  for (const method of ["createIssue", "retryIssue"]) {
    const deliver = queue[method];
    queue[method] = (...args) => {
      const index = method === "retryIssue" ? 1 : 0, payload = args[index];
      return pipeline.deliver({ prompt: payload.description, title: payload.title }, prompt => {
        const next = [...args]; next[index] = { ...payload, description: prompt };
        return deliver(...next);
      });
    };
  }
}
export const eventPreparer = (pipeline, prepare, workspace) =>
  options => pipeline.prepare({ ...options, workspace }, () => prepare(options));
export function createEventPipeline(workflow, { store, runtime, call, observe = () => {}, verifyPreparation = verifyEventWorkspace }) {
  const ordered = validateWorkflow(workflow), actions = ordered.slice(1);
  const pivot = actions.findIndex(node => node.operation === "prepare-event");
  let context, record, prior;
  function completeScan() {
    if (record?.status !== "running") return;
    record = { ...record, status: "interrupted", finishedAt: new Date().toISOString(),
      error: "The source did not complete this event's handoff. It must be revalidated before another attempt." };
    writeRun(runtime, record);
  }
  function begin(event) {
    completeScan();
    const hash = createHash("sha256").update(JSON.stringify([workflow.id, executionSettings(workflow), event])).digest("hex");
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    const saved = readRun(runtime, id);
    prior = new Map(saved?.steps.map(step => [step.id, step]) || []);
    record = { ...(saved || newRun(workflow, event, { id, source: "integration" })), status: "running",
      startedAt: new Date().toISOString(), finishedAt: undefined, error: undefined };
    context = { event, input: event, steps: { [ordered[0].id]: event } };
    writeRun(runtime, record);
  }
  async function sequence(nodes, dependencies = {}) {
    try {
      const result = await executeWorkflow({ ...workflow, workspace: context.event.workspace || workflow.workspace }, observe, undefined, {
        store, call, eventId: record.id, sequence: nodes, context, ...dependencies, captureContext: true,
        executeBlock: async (node, definition, input) => {
          const native = ["prepare-event", "dispatch-event", "resume-event", "publish-fixes"].includes(node.operation);
          const previous = prior.get(node.id);
          if (!native && previous && previous.status !== "filtered") {
            if (previous.status !== "succeeded") throw new Error("A previous attempt may have side effects. Inspect the execution and change the workflow before retrying this action.");
            return { output: previous.output, ...(node.operation === "setup" ? { preparation: previous.output } : {}) };
          }
          return executeBlock(node, definition, input);
        },
        recordStep: step => {
          record.steps = [...record.steps.filter(item => item.id !== step.id), step]; writeRun(runtime, record);
        },
      });
      context = result.context;
      if (result.filtered) throw Object.assign(new Error("Event did not match the workflow filter."), { code: "WORKFLOW_FILTERED" });
      return result;
    } catch (error) {
      record = { ...record, status: filteredEvent(error) ? "filtered" : "failed",
        error: filteredEvent(error) ? undefined : error.message, finishedAt: new Date().toISOString() };
      writeRun(runtime, record);
      throw error;
    }
  }
  function finish(result) {
    record = { ...record, status: "succeeded", taskId: result?.id, finishedAt: new Date().toISOString() };
    writeRun(runtime, record);
  }
  return {
    completeScan,
    async prepare(event, perform) {
      if (pivot < 0) throw new Error("Event workflow has no workspace preparation action.");
      begin(event);
      await sequence(actions.slice(0, pivot + 1), { prepareEvent: perform });
      return context.steps[actions[pivot].id];
    },
    async deliver(event, perform) {
      if (!context || !record) throw new Error("Event workflow has not prepared this delivery.");
      context.event = { ...context.event, ...event };
      context.input = { ...context.input, ...event };
      context.steps[ordered[0].id] = context.event;
      let receipt;
      await sequence(actions.slice(pivot + 1), { dispatchEvent: async prompt => {
        await verifyPreparation(context.steps[actions[pivot].id], eventSource(workflow) === "pr-updater");
        return (receipt = await perform(prompt));
      } });
      if (!receipt?.id) throw new Error("Event workflow did not deliver its task.");
      finish(receipt);
      return receipt;
    },
    async report(event, publishEvent) {
      begin(event);
      let publication;
      const result = await sequence(actions, { publishEvent: publishEvent && (async () => (publication = await publishEvent())) });
      finish(result.taskId ? { id: result.taskId } : undefined);
      return { ...publication, ...(result.taskId ? { taskId: result.taskId, dispatched: 1 } : {}) };
    },
  };
}
