import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateWorkflow } from "./workflow-schema.mjs";
import { executeBlock } from "./workflow-blocks.mjs";

const execute = promisify(execFile);
export async function executeWorkflow(workflow, observe = () => {}, run = execute, dependencies = {}) {
  const ordered = validateWorkflow(workflow), steps = dependencies.sequence || ordered.slice(1);
  const input = dependencies.input === undefined ? {} : dependencies.input;
  let context = { ...dependencies, input, steps: { [ordered[0].id]: input }, ...dependencies.context }, taskId = null;
  const finish = result => ({ ...result, ...(dependencies.captureContext ? { context } : {}) });
  for (const step of steps) {
    const startedAt = new Date().toISOString(), input = context.input;
    observe({ currentStep: step.id, stepStartedAt: startedAt });
    dependencies.recordStep?.({ id: step.id, label: step.label, status: "running", startedAt, input });
    try {
      const result = await (dependencies.executeBlock || executeBlock)(step, workflow, { ...context, run });
      context = { ...context, ...result, input: result.output, steps: { ...context.steps, [step.id]: result.output } };
      taskId = result.taskId ?? taskId;
      dependencies.recordStep?.({ id: step.id, label: step.label, status: result.filtered ? "filtered" : "succeeded",
        input, output: result.output, startedAt, finishedAt: new Date().toISOString() });
      if (result.filtered) return finish({ completedSteps: steps.indexOf(step) + 1, taskId, filtered: true, lastError: null });
    } catch (error) {
      dependencies.recordStep?.({ id: step.id, label: step.label, status: "failed", input, startedAt,
        finishedAt: new Date().toISOString(), error: error.message });
      console.error(`[${workflow.id}/${step.id}] ${error.stderr || error.message}`);
      throw Object.assign(new Error(`Step "${step.label}" failed (${error.code ?? "execution error"}): ${error.message}`, { cause: error }), { code: error.code });
    } finally { observe({ currentStep: null }); }
  }
  return finish({ completedSteps: steps.length, taskId, lastError: null });
}
