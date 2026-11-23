import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runnerLocations } from "./runner-client";
import { isRunnerWorkflow, type RunnerWorkflow } from "./runner-workflow";

export class RunnerWorkflowError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export async function runnerWorkflowRequest(root: string, id: string, method: string, input?: unknown): Promise<RunnerWorkflow> {
  const value = await runnerRequest(root, id, method, input);
  if (!isRunnerWorkflow(value)) throw new Error("Invalid runner settings response.");
  return value;
}
export async function runnerRequest(root: string, id: string, method: string, input?: unknown): Promise<unknown> {
  const { home, config, runtime } = runnerLocations(root);
  const source = await import(/* @vite-ignore */ pathToFileURL(join(home, "bridge", "workflow-api.mjs")).href);
  if (typeof source.workflowRequest !== "function") throw new Error("Runner engine is not installed.");
  try { return await source.workflowRequest(config, root, id, method, input, runtime); }
  catch (error) {
    if (error instanceof Error && "status" in error && typeof error.status === "number")
      throw new RunnerWorkflowError(error.message, error.status);
    throw error;
  }
}
