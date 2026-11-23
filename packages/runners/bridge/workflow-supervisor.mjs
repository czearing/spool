import { watch, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configure, readConfiguration, runnerEnvironment } from "./config.mjs";
import { definition, loadWorkflowConfig, runnerNames, runnerSetting } from "./workflow-store.mjs";
import { validateWorkflow, managedIds, executionSettings } from "./workflow-schema.mjs";
import { listRuns } from "./workflow-runs.mjs";
import { eventSource } from "@spool/workflow";
import { eventConfiguration } from "./workflow-event-config.mjs";
import { runtimeRoot } from "./runtime-root.mjs";
import { ensureRunnerEntry } from "./runner-entry.mjs";
import { nativeSupervisor } from "./native-supervisor.mjs";

export function runnerPlan(file, { root = path.dirname(file), project, filter, node } = {}) {
  filter = filter?.toLowerCase();
  const input = runnerEnvironment(project ? loadWorkflowConfig(file, project) : readConfiguration(file),
    node ? { ...process.env, SPOOL_DIR: undefined } : process.env), next = [];
  for (const id of runnerNames(input)) {
    if (project) ensureRunnerEntry(root, id);
    const setting = runnerSetting(input, id);
    if (!setting || typeof setting !== "object" || setting.enabled !== undefined && typeof setting.enabled !== "boolean")
      throw new Error(`Invalid runner settings: ${id}`);
    if (!managedIds.includes(id)) validateWorkflow(definition(input, id));
    const pending = !managedIds.includes(id) && listRuns(path.join(root, "runners", id, ".runner"))
      .some(run => ["queued", "running"].includes(run.status));
    if (filter && filter !== id || !runnerSetting(input, id).enabled && !pending) continue;
    const value = definition(input, id);
    if (!managedIds.includes(id)) validateWorkflow(value);
    const source = eventSource(value);
    if (source) configure(eventConfiguration(input, value), source, path.join(root, "runners", id));
    if (!existsSync(path.join(root, "runners", id, "run.mjs"))) throw new Error(`Missing runner entry: ${id}`);
    const { editor: _editor, ...settings } = setting;
    const execution = managedIds.includes(id) ? settings : executionSettings(value);
    const workspaces = ["pr-reviewer", "livesite", "backlog"].includes(source) ? undefined : input.agent_workspaces;
    const queued = !managedIds.includes(id) ? listRuns(path.join(root, "runners", id, ".runner"))
      .filter(run => run.status === "queued").map(run => run.id) : [];
    next.push({ id, key: JSON.stringify([execution, setting.enabled, input.ado, workspaces, input.spool_dir, input.node_binary]),
      executable: node || input.node_binary || process.execPath, entry: path.join(root, "runners", id, "run.mjs"),
      cwd: root, env: { SPOOL_DIR: input.spool_dir, SPOOL_RUNNERS_RUNTIME: root,
        SPOOL_RUNNER_CONFIG_FILE: file, SPOOL_RUNNER_CONFIG: JSON.stringify(input) }, wake: queued });
  }
  return next;
}

export function supervise(file, { root = path.dirname(file), project, filter, node, onError = () => {} } = {}) {
  let engine, watcher, executions, stopped = false, scheduled, revision = 0, configurationError, engineError;
  const running = new Map();
  let recovery, attempts = 0, started = Date.now(), exited = false, lastPlan;
  const report = () => onError(configurationError || engineError || null);
  const launch = () => {
    exited = false; started = Date.now();
    const current = nativeSupervisor({ running, onError: error => { engineError = error; report(); } });
    current.closed.catch(error => {
      if (stopped || engine !== current) return;
      exited = true;
      if (Date.now() - started >= 300000) attempts = 0;
      if (++attempts > 8) {
        engineError = new Error(`Runner engine recovery is blocked after repeated exits: ${error.message}`); report(); return;
      }
      const delay = Math.min(300000, 5000 * 2 ** (attempts - 1)) + Math.random() * 1000;
      engineError = new Error(`Runner engine stopped; recovering in ${Math.ceil(delay / 1000)} seconds.`); report();
      recovery = setTimeout(async () => {
        recovery = undefined;
        if (stopped) return;
        try { engine = launch(); await engine.ready; await reload(); }
        catch (failure) { engineError = failure; report(); }
      }, delay);
    });
    return current;
  };
  async function reload() {
    if (stopped) return;
    const current = ++revision;
    try {
      const plan = runnerPlan(file, { root, project, filter, node }), signature = JSON.stringify(plan);
      if (exited && !recovery && signature !== lastPlan) {
        attempts = 0; engine = launch(); await engine.ready;
      }
      lastPlan = signature;
      await engine.reconcile(plan);
      if (current === revision) { configurationError = null; report(); }
    } catch (error) {
      console.error(`Runner configuration rejected; existing runners unchanged: ${error.stack}`);
      if (current === revision) { configurationError = error; report(); }
    }
  }
  try {
    watcher = watch(path.dirname(file), (_event, name) => {
      if (name && name.toString() !== path.basename(file)) return;
      clearTimeout(scheduled); scheduled = setTimeout(reload, 100);
    });
    watcher.on("error", error => console.error(`Runner configuration watcher failed: ${error.stack}`));
    mkdirSync(path.join(root, "runners"), { recursive: true });
    executions = watch(path.join(root, "runners"), { recursive: true }, (_event, name) => {
      if (!name?.toString().replaceAll("\\", "/").match(/^[^/]+\/\.runner\/executions\/[a-f0-9-]+\.json$/)) return;
      clearTimeout(scheduled); scheduled = setTimeout(reload, 100);
    });
    executions.on("error", error => console.error(`Workflow event watcher failed: ${error.stack}`));
    engine = launch();
  } catch (error) { watcher?.close(); executions?.close(); throw error; }
  async function stop() {
    stopped = true; watcher.close(); executions.close(); clearTimeout(scheduled); clearTimeout(recovery);
    try { await engine.stop(); } catch (error) { if (!exited) throw error; }
  }
  const initial = reload();
  const ready = Promise.all([engine.ready, initial]).catch(async error => {
    try { await stop(); } catch (failure) { console.error("Cannot stop failed runner engine:", failure); }
    throw error;
  });
  return { reload, running, ready, stop, get pid() { return engine.pid; } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const supervisor = supervise(path.resolve(process.argv[2]), { root: runtimeRoot(), filter: process.argv[3] });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true; await supervisor.stop(); process.stdin.pause();
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  process.stdin.on("data", data => { if (data.toString().includes("stop")) void stop(); });
  process.stdin.on("end", () => void stop());
}
