import { callBohemia } from "../packages/bohemia-pr-mcp/src/client.mjs";
import { renderSpoolTaskPrompt } from "./queue.mjs";

export const repositoryRequest = (operation, repoRoot) => {
  if (operation === "refresh") return ["bohemia_prepare", { repoRoot, operation: "master" }];
  if (operation === "setup") return ["bohemia_prepare", { repoRoot, operation: "setup" }];
  if (operation === "build") return ["bohemia_build", { repoRoot }];
  if (operation === "check") return ["bohemia_check", { repoRoot }];
  throw new Error(`Unknown repository operation: ${operation}`);
};
export async function executeAction(step, workflow, { call = callBohemia, store, eventId, preparation, prepareEvent, dispatchEvent, publishEvent } = {}) {
  if (!store) throw new Error("Workflow actions require the configured Spool project.");
  if (step.operation === "prepare-event") {
    if (!prepareEvent) throw new Error("This action needs a workspace event.");
    const output = await prepareEvent();
    return { output, preparation: output };
  }
  if (step.operation === "publish-fixes") {
    if (!publishEvent) throw new Error("This action needs a report event and a configured publication owner.");
    return { output: await publishEvent() };
  }
  if (["dispatch-event", "resume-event"].includes(step.operation)) {
    if (!dispatchEvent) throw new Error("This action needs a prepared task event.");
    const task = await dispatchEvent(step.prompt);
    if (!task?.id) throw new Error("Event delivery did not confirm a durable task.");
    return { taskId: task.id };
  }
  if (step.kind === "repository") {
    store.assertIdle(null, workflow.workspace);
    const result = await call(...repositoryRequest(step.operation, workflow.workspace));
    store.assertIdle(null, workflow.workspace);
    return { output: result, preparation: step.operation === "setup" ? result : preparation };
  }
  if (step.kind === "agent") {
    if (!eventId) throw new Error("Agent handoff requires a durable event identity.");
    const key = `workflow:${workflow.id}:${eventId}:${step.id}`;
    const existing = store.submission(key);
    if (existing) return { taskId: existing.task.id };
    store.assertIdle(step.agent, workflow.workspace);
    const trigger = workflow.nodes.find(node => node.kind === "file-change");
    const context = trigger ? `\n\nTriggered by a change to: ${trigger.path}` : "";
    const prepared = preparation ? `\n\nRepository tools completed in ${workflow.workspace}. Preserve this checkout and branch; do not reset or reprepare it. Complete the requested work and publication before marking the task completed.` : "";
    const prompt = renderSpoolTaskPrompt(step.prompt + context + prepared, step.agent);
    const task = await store.submit({ key, agent: step.agent, workspace: workflow.workspace, title: step.label,
      prompt, metadata: { runner: workflow.id, eventId, ...(preparation ? { preparation } : {}) } });
    return { taskId: task.id };
  }
  throw new Error(`Unknown workflow action: ${step.kind}`);
}
