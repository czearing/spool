import { definition, loadWorkflowConfig, saveDefinition } from "./workflow-store.mjs";
import path from "node:path";
import { workflowRunRequest } from "./workflow-run-api.mjs";
import { inspectWorkflow } from "./workflow-inspection.mjs";
import { runtimeRoot } from "./runtime-root.mjs";
const [file, root, id, method = "GET"] = process.argv.slice(2);
try {
  let value;
  if (method === "GET") {
    const input = loadWorkflowConfig(file, root);
    value = await inspectWorkflow(input, definition(input, id));
  }
  else {
    let text = "";
    for await (const chunk of process.stdin) {
      text += chunk;
      if (Buffer.byteLength(text) > 100000) throw Object.assign(new Error("Runner definition is too large."), { status: 413 });
    }
    const input = JSON.parse(text);
    const home = runtimeRoot();
    if (["RUN", "RUNS", "WEBHOOK"].includes(method))
      value = await workflowRunRequest(definition(loadWorkflowConfig(file, root), id), path.join(home, "runners", id, ".runner"), method, input);
    else {
      if (input.id !== id) throw Object.assign(new Error("Runner identity does not match."), { status: 400 });
      value = await saveDefinition(file, root, input, input.revision, method === "POST", home);
      value = await inspectWorkflow(loadWorkflowConfig(file, root), value);
    }
  }
  console.log(JSON.stringify({ value }));
} catch (error) {
  console.error(error.stack);
  console.log(JSON.stringify({ error: error.message, status: error.status || 503 }));
  process.exitCode = 1;
}
