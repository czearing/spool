import { integrationNodes, eventSources, eventRecipe, stepDefinition, executionSettings, integrationNames, eventSource } from "@spool/workflow";
import { profile } from "./sources.mjs";

const defaults = { "pr-reviewer": "pr-reviewer", livesite: "software-engineer", perf: "perf" };
export function managedParameters(id, setting) {
  const base = profile(id), result = {};
  const fields = integrationNodes.find(node => eventSources[node.operation] === id).fields.filter(field => field.type === "number");
  if (setting.parameters != null && (typeof setting.parameters !== "object" || Array.isArray(setting.parameters) ||
      Object.keys(setting.parameters).some(key => !fields.some(field => field.key === key))))
    throw new Error(`Unsupported policy parameters for ${id}.`);
  for (const field of fields) {
    const value = setting.parameters?.[field.key] ?? base[field.key] ?? Number(field.defaultValue);
    if (!Number.isSafeInteger(value) || value < field.min || value > field.max)
      throw new Error(`${field.label} must be an integer from ${field.min} to ${field.max}.`);
    result[field.key] = value;
  }
  return result;
}
export function handoffInstructions(setting) {
  const value = setting.handoff_instructions ?? "";
  if (typeof value !== "string" || value.length > 16384 || value.includes("\0"))
    throw new Error("Additional task instructions must be text under 16,385 characters.");
  return value;
}
export const withHandoffInstructions = (prompt, instructions = "") =>
  instructions.trim() ? `${prompt}\n\n## Additional runner instructions\n${instructions}` : prompt;
export function managedDefinition(input, id, setting) {
  if (setting.workflow) return { ...setting.workflow, nodes: setting.workflow.nodes.map((node, index) => {
    const display = setting.editor?.nodes?.find(saved => saved.id === node.id);
    return { ...node, label: display?.label || integrationNames[node.kind] || stepDefinition(node)?.label,
      position: display?.position || { x: index * 256, y: 0 } };
  }) };
  const base = profile(id);
  return eventRecipe(id, { ...managedParameters(id, setting),
    reviewer: setting.reviewer || input.ado?.author_account || base.reviewer || "",
    agent: setting.agent || defaults[id] || "",
  }, setting.editor?.nodes);
}
export function applyManagedSettings(setting, value, current) {
  const source = value.nodes.find(node => ["azure-devops", "repository-event"].includes(node.kind));
  const previous = current.nodes.find(node => node.id === source.id);
  for (const field of stepDefinition(source).fields) {
    if (eventSource(value) !== value.id || source[field.key] === previous?.[field.key]) continue;
    if (field.type === "number") { setting.parameters ??= {}; setting.parameters[field.key] = Number(source[field.key]); }
    else if (field.key === "reviewer") setting.reviewer = source.reviewer;
  }
  const agent = value.nodes.find(node => ["dispatch-event", "publish-fixes"].includes(node.operation))?.agent;
  const original = current.nodes.find(node => ["dispatch-event", "publish-fixes"].includes(node.operation))?.agent;
  if (eventSource(value) === value.id && agent !== original) {
    if (agent) setting.agent = agent;
    else if (value.id === "spelling") delete setting.agent;
  }
  if (setting.workflow || JSON.stringify(executionSettings(value)) !== JSON.stringify(executionSettings(current)))
    setting.workflow = { nodes: value.nodes.map(({ position, label, ...node }) => node), edges: value.edges };
}
