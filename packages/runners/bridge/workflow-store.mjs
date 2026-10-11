import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { acquireProcessLock, writeRunnerJson } from "../packages/bohemia-agent-tooling/src/index.js";
import { configure, keyFor } from "./config.mjs";
import { managedIds, validId, validateWorkflow } from "./workflow-schema.mjs";
import { profile } from "./sources.mjs";
import { SpoolStore } from "./spool-store.mjs";
import { managedDefinition, applyManagedSettings } from "./managed-settings.mjs";
import { eventSource } from "../packages/workflow/index.mjs";
import { eventConfiguration } from "./workflow-event-config.mjs";
import { ensureRunnerEntry } from "./runner-entry.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const reject = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function runnerNames(config) {
  const custom = Object.keys(config.custom_runners || {});
  if (custom.some(id => !validId(id) || managedIds.includes(id))) reject("Invalid custom runner identity.");
  return [...managedIds.filter(id => Object.hasOwn(config, keyFor(id))), ...custom];
}
export const runnerSetting = (config, id) => managedIds.includes(id) ? config[keyFor(id)] : config.custom_runners?.[id];
export function definition(config, id) {
  if (!validId(id) || !runnerNames(config).includes(id)) reject("Runner not found.", 404);
  const settings = runnerSetting(config, id);
  if (!managedIds.includes(id)) return { ...settings, revision: hash(settings) };
  const graph = managedDefinition(config, id, settings), source = eventSource(graph);
  return { id, kind: "managed", name: settings.editor?.name || id, enabled: settings.enabled === true,
    workspace: source === "pr-updater" ? "" : (source === "spelling" && settings.source_dir) || settings.workspace_dir || "",
    intervalSeconds: settings.scan_interval_seconds ?? profile(id).pollSeconds ?? 60, ...graph,
    revision: hash(settings) };
}
export function loadWorkflowConfig(file, root) {
  const config = JSON.parse(readFileSync(file, "utf8"));
  const physical = value => { const resolved = realpathSync.native(value); return process.platform === "win32" ? resolved.toLowerCase() : resolved; };
  if (physical(config.spool_dir) !== physical(root)) reject("Runners belong to another project.", 403);
  runnerNames(config);
  return config;
}
export async function saveDefinition(file, root, value, expectedRevision, create = false, home = path.dirname(file)) {
  validateWorkflow(value);
  const agentStep = value.nodes.find(node => node.kind === "agent");
  if (agentStep?.agent) new SpoolStore(root).validateAgent(agentStep.agent);
  if (value.workspace && (!existsSync(value.workspace) || !statSync(value.workspace).isDirectory()))
    reject("Working directory does not exist on the runner machine.");
  const release = await acquireProcessLock(realpathSync.native(file).toLowerCase(), { namespace: "runner-editor", timeoutMs: 5000 });
  try {
    const original = readFileSync(file, "utf8"), config = loadWorkflowConfig(file, root);
    const exists = runnerNames(config).includes(value.id);
    if (create ? exists || managedIds.includes(value.id) : !exists) reject(create ? "Runner already exists." : "Runner not found.", create ? 409 : 404);
    if (!create && definition(config, value.id).revision !== expectedRevision) reject("Runner changed elsewhere. Reload before saving.", 409);
    const { revision: _revision, inspection: _inspection, ...saved } = value;
    if (value.kind === "managed") {
      const setting = config[keyFor(value.id)];
      const current = definition(config, value.id);
      applyManagedSettings(setting, value, current);
      if (setting.scan_interval_seconds !== undefined || value.intervalSeconds !== current.intervalSeconds)
        setting.scan_interval_seconds = value.intervalSeconds;
      Object.assign(setting, { enabled: value.enabled,
        editor: { name: value.name, nodes: value.nodes.map(({ id, position, label }) => ({ id, position, label })) } });
      if (eventSource(value) === "spelling" && setting.source_dir) setting.source_dir = value.workspace;
      else if (eventSource(value) !== "pr-updater") setting.workspace_dir = value.workspace;
      else if (value.workspace) reject("PR update events use the original agents' workspaces.");
      if (setting.enabled) configure(eventConfiguration(config, value), eventSource(value), path.join(home, "runners", value.id));
    } else {
      config.custom_runners ??= {};
      config.custom_runners[value.id] = saved;
      if (value.enabled && eventSource(value)) configure(eventConfiguration(config, value), eventSource(value), path.join(home, "runners", value.id));
      ensureRunnerEntry(home, value.id);
    }
    if (readFileSync(file, "utf8") !== original) reject("Runner configuration changed. Reload before saving.", 409);
    writeRunnerJson(file, config);
    return definition(config, value.id);
  } finally { await release(); }
}
