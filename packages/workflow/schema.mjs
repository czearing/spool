import { isTrigger, stepDefinition, stepError, nodeCatalog } from "./catalog.mjs";
import { eventSource } from "./integrations.mjs";

export const managedIds = ["pr-reviewer", "pr-updater", "livesite", "spelling"];
export function executionSettings(value) {
  return [value.workspace, value.intervalSeconds, validateWorkflow(value).map(node =>
    [node.id, node.kind, node.operation, ...(stepDefinition(node)?.fields || []).map(field => node[field.key])])];
}
export const validId = id => typeof id === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(id) && !["new", "constructor", "prototype"].includes(id);
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const text = (value, max) => typeof value === "string" && value.length <= max;
export function validateWorkflow(value) {
  if (!value || typeof value !== "object" || !validId(value.id)) fail("Choose a valid runner ID.");
  if (!text(value.name, 80) || !value.name.trim()) fail("Enter a runner name.");
  if (typeof value.enabled !== "boolean") fail("Invalid enabled setting.");
  const managed = managedIds.includes(value.id);
  if (value.kind !== (managed ? "managed" : "custom")) fail("Runner type cannot be changed.");
  if (!text(value.workspace, 1024) || value.workspace && !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value.workspace) ||
      !value.workspace && eventSource(value) !== "pr-updater") fail("Enter an absolute working directory.");
  if (!Number.isSafeInteger(value.intervalSeconds) || value.intervalSeconds < 1 || value.intervalSeconds > 604800)
    fail("Check interval must be between 1 second and 7 days.");
  if (!Array.isArray(value.nodes) || value.nodes.length < 2 || value.nodes.length > 32 ||
      !Array.isArray(value.edges) || value.edges.length !== value.nodes.length - 1) fail("Connect all steps in one sequence.");
  const nodes = new Map();
  for (const node of value.nodes) {
    if (!node || !validId(node.id) || nodes.has(node.id) || node.block || !nodeCatalog.some(item => item.kind === node.kind) ||
        !text(node.label, 80) || !node.label.trim() || !node.position ||
        ![node.position.x, node.position.y].every(n => Number.isFinite(n) && Math.abs(n) <= 100000))
      fail("Invalid workflow step.");
    const error = stepError(node);
    if (error) fail(error);
    if (node.kind === "agent" && node.operation !== "resume-event" && !validId(node.agent)) fail("Choose a valid agent.");
    nodes.set(node.id, node);
  }
  const triggers = value.nodes.filter(isTrigger);
  if (triggers.length !== 1) fail("A runner needs exactly one trigger.");
  const next = new Map(), incoming = new Set(), edgeIds = new Set();
  for (const edge of value.edges) {
    if (!edge || !validId(edge.id) || edgeIds.has(edge.id) || !nodes.has(edge.source) || !nodes.has(edge.target) ||
        next.has(edge.source) || incoming.has(edge.target) || edge.target === triggers[0].id)
      fail("Connect steps in a single sequence without branches or loops.");
    next.set(edge.source, edge.target); incoming.add(edge.target); edgeIds.add(edge.id);
  }
  const ordered = [], visited = new Set();
  for (let id = triggers[0].id; id; id = next.get(id)) {
    if (visited.has(id)) fail("Workflow loops are not supported.");
    visited.add(id); ordered.push(nodes.get(id));
  }
  if (ordered.length !== nodes.size) fail("Every step must be connected to the trigger.");
  const source = eventSource(value);
  if (source === "perf" && (ordered.at(-1).prompt !== "{{event.prompt}}" || ordered.at(-1).agent !== "perf"))
    fail("Performance discovery uses the perf agent and its exact one-sentence event prompt.");
  if (managed && !source) fail("Choose an integration event for this existing runner.");
  const preparations = ordered.filter(node => node.operation === "prepare-event");
  if (source && source !== "spelling" && (preparations.length !== 1 ||
      ordered.at(-1).operation !== (source === "pr-updater" ? "resume-event" : "dispatch-event")))
    fail("This event needs one Repository / Prepare event workspace action and a final Agent / Assign event task or Resume original task action.");
  if (!source && ordered.some(node => ["prepare-event", "dispatch-event", "resume-event", "publish-fixes"].includes(node.operation)))
    fail("Event actions require an integration trigger.");
  if (source === "spelling" && ordered.some(node => ["prepare-event", "dispatch-event", "resume-event"].includes(node.operation)))
    fail("Report events do not contain an agent handoff contract.");
  if (source !== "spelling" && ordered.some(node => node.operation === "publish-fixes"))
    fail("Publish verified fixes requires a report event.");
  if (ordered.slice(0, -1).some(node => node.kind === "agent"))
    fail("Agent handoff must be the final step; the agent completes its work asynchronously.");
  return ordered;
}
