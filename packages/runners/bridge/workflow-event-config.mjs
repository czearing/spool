import { eventSource, stepDefinition } from "../packages/workflow/index.mjs";
import { keyFor } from "./config.mjs";

export function eventConfiguration(input, workflow) {
  const source = eventSource(workflow);
  if (!source) throw new Error("Workflow has no integration event source.");
  const trigger = workflow.nodes.find(node => ["azure-devops", "repository-event"].includes(node.kind));
  const agent = workflow.nodes.find(node => ["dispatch-event", "publish-fixes"].includes(node.operation))?.agent;
  const setting = { ...(workflow.kind === "managed" ? input[keyFor(workflow.id)] : {}), enabled: true,
    scan_interval_seconds: workflow.intervalSeconds, workspace_dir: workflow.workspace || input.spool_dir,
    parameters: Object.fromEntries(stepDefinition(trigger).fields.filter(field => field.type === "number")
      .map(field => [field.key, Number(trigger[field.key])])),
  };
  delete setting.workflow;
  delete setting.source_dir;
  if (trigger.reviewer) setting.reviewer = trigger.reviewer;
  if (agent) setting.agent = agent;
  else if (source === "pr-updater") setting.agent = "pr-updater";
  else if (source === "spelling") delete setting.agent;
  return { ...input, [keyFor(source)]: setting };
}
