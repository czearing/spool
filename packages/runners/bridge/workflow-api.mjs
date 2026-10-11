import path from "node:path";
import { definition, loadWorkflowConfig, saveDefinition } from "./workflow-store.mjs";
import { workflowRunRequest } from "./workflow-run-api.mjs";
import { inspectWorkflow } from "./workflow-inspection.mjs";

export async function workflowRequest(file, root, id, method, input, runtime) {
  if (method === "GET") {
    const config = loadWorkflowConfig(file, root);
    return inspectWorkflow(config, definition(config, id));
  }
  if (["RUN", "RUNS", "WEBHOOK"].includes(method))
    return workflowRunRequest(definition(loadWorkflowConfig(file, root), id), path.join(runtime, "runners", id, ".runner"), method, input);
  if (!["POST", "PUT"].includes(method)) throw Object.assign(new Error("Unsupported runner operation."), { status: 405 });
  if (!input || input.id !== id) throw Object.assign(new Error("Runner identity does not match."), { status: 400 });
  const saved = await saveDefinition(file, root, input, input.revision, method === "POST", runtime);
  return inspectWorkflow(loadWorkflowConfig(file, root), saved);
}
