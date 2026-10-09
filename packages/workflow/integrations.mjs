const number = (key, label, value, min = 0, max = 10080) =>
  ({ key, label, type: "number", defaultValue: String(value), min, max });
const text = (key, label, type = "text", description) => ({ key, label, type, description });
export const eventSources = {
  "review-requested": "pr-reviewer", "build-incident": "livesite",
  "update-requested": "pr-updater", "report-ready": "spelling",
  "performance-capacity": "perf",
};
export const integrationNodes = [
  { id: "review-requested", kind: "azure-devops", operation: "review-requested", group: "Triggers",
    label: "Review requested", icon: "globe", description: "Watch assigned PRs. Emits eligible revisions with durable deduplication and assignment reconciliation.",
    fields: [text("reviewer", "Reviewer account"), number("maxAgeDays", "Maximum PR age (days)", 30, 1, 3650),
      number("revisionSettleSeconds", "Changed revision settle time (seconds)", 120, 0, 86400)] },
  { id: "build-incident", kind: "azure-devops", operation: "build-incident", group: "Triggers",
    label: "Build incident", icon: "globe", description: "Watch pipelines for actionable incidents. Recovery tracking and cooldowns belong to the trigger.",
    fields: [number("maxBuilds", "Builds per pipeline", 10, 1, 100), number("stuckMinutes", "Stuck after (minutes)", 90, 1),
      number("persistentFailureMinutes", "Persistent failure (minutes)", 60, 1), number("alertCooldownHours", "Repeat alert cooldown (hours)", 6, 0, 720)] },
  { id: "update-requested", kind: "azure-devops", operation: "update-requested", group: "Triggers",
    label: "PR update requested", icon: "globe", description: "Watch owned PRs for feedback, failures and conflicts. Resolve the original creator and verify completed updates.",
    fields: [number("quietMinutes", "Feedback quiet period (minutes)", 10), number("retryMinutes", "Retry window (minutes)", 120, 1)] },
  { id: "report-ready", kind: "repository-event", operation: "report-ready", group: "Triggers",
    label: "Spelling report ready", icon: "file", description: "Refresh an unoccupied checkout and emit a persisted spelling report.",
    fields: [] },
  { id: "performance-capacity", kind: "azure-devops", operation: "performance-capacity", group: "Triggers",
    label: "Performance capacity available", icon: "globe", description: "Assign one safe New Office production improvement when the perf agent is idle and its open PRs are below the cap.",
    fields: [number("maxOpenPrs", "Maximum open performance PRs", 3, 1, 3)] },
  { id: "prepare-event", kind: "repository", operation: "prepare-event", group: "Repository",
    label: "Prepare event workspace", icon: "folder", description: "Prepare the checkout requested by the trigger. Exact revisions, workspace ownership and continuation safety are verified.",
    fields: [] },
  { id: "dispatch-event", kind: "agent", operation: "dispatch-event", group: "Spool",
    label: "Assign event task", icon: "agent", description: "Deliver the event as a durable agent task, preserving its identity and retry contract.",
    fields: [text("agent", "Agent", "agent"), text("prompt", "Task instructions", "textarea",
      "Keep {{event.prompt}} for the trigger's instructions and delivery contract. Add your instructions around it.")] },
  { id: "resume-event", kind: "agent", operation: "resume-event", group: "Spool",
    label: "Resume original task", icon: "agent", description: "Continue the event's original agent and conversation. Never substitutes another owner.",
    fields: [text("prompt", "Task instructions", "textarea", "{{event.prompt}} contains the current continuation contract.")] },
  { id: "publish-fixes", kind: "repository", operation: "publish-fixes", group: "Repository",
    label: "Publish verified fixes", icon: "globe", description: "Publish the report's eligible prose-only fixes with verified reviewers and durable PR receipts.",
    fields: [text("agent", "Publication owner", "agent")] },
];
export const integrationNames = { repository: "Repository", agent: "Agent", "azure-devops": "Azure DevOps",
  "repository-event": "Repository trigger" };
export const eventSource = workflow => eventSources[workflow.nodes?.find(node => eventSources[node.operation])?.operation];
export function operationAvailable(node, source) {
  if (node.operation === "prepare-event") return !!source && source !== "spelling";
  if (node.operation === "publish-fixes") return source === "spelling";
  if (node.operation === "dispatch-event") return ["pr-reviewer", "livesite", "perf"].includes(source);
  if (node.operation === "resume-event") return source === "pr-updater";
  if (node.kind === "agent" && source && source !== "spelling") return false;
  return true;
}
export function eventRecipe(id, values = {}, layout = []) {
  const operation = Object.keys(eventSources).find(key => eventSources[key] === id);
  const source = integrationNodes.find(node => node.id === operation);
  const actions = id === "spelling" ? [values.agent
    ? { kind: "repository", operation: "publish-fixes", agent: values.agent, label: "Publish fixes" }
    : { kind: "data", body: "{{input}}", label: "Report" }] : [
    { kind: "repository", operation: "prepare-event", label: "Prepare workspace" },
    { kind: "agent", operation: id === "pr-updater" ? "resume-event" : "dispatch-event",
      ...(id !== "pr-updater" ? { agent: values.agent || "" } : {}), prompt: "{{event.prompt}}", label: id === "pr-updater" ? "Resume task" : "Assign task" },
  ];
  const nodes = [{ kind: source.kind, operation, label: source.label,
    ...Object.fromEntries(source.fields.map(field => [field.key, String(values[field.key] ?? field.defaultValue ?? "")])) }, ...actions]
    .map((node, index) => ({ id: `node-${index}`, ...node, label: integrationNames[node.kind] || node.label,
      position: layout.find(saved => saved.id === `node-${index}`)?.position || { x: index * 256, y: 0 } }));
  return { nodes, edges: nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, source: nodes[index].id, target: node.id })) };
}
