import { spawn } from "node:child_process";
import { watch, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configure, readConfiguration } from "./config.mjs";
import { definition, runnerNames, runnerSetting } from "./workflow-store.mjs";
import { validateWorkflow, managedIds, executionSettings } from "./workflow-schema.mjs";
import { listRuns } from "./workflow-runs.mjs";
import { eventSource } from "../packages/workflow/index.mjs";
import { eventConfiguration } from "./workflow-event-config.mjs";
import { runtimeRoot } from "./runtime-root.mjs";

export function supervise(file, { root = path.dirname(file), filter, launch = spawn, retryMs = 5000, node, onError = () => {} } = {}) {
  filter = filter?.toLowerCase();
  const running = new Map(), retries = new Map();
  let desired = new Map(), stopped = false, scheduled;
  function start(id) {
    if (stopped || running.has(id) || !desired.has(id)) return;
    const spec = desired.get(id), entry = path.join(root, "runners", id, "run.mjs");
    const child = launch(node || spec.input.node_binary || process.execPath, [entry, "--watch"], {
      cwd: root, windowsHide: true, stdio: ["pipe", node ? 2 : "inherit", "inherit"],
      env: { ...process.env, SPOOL_DIR: spec.input.spool_dir, SPOOL_RUNNERS_RUNTIME: root,
        SPOOL_RUNNER_CONFIG_FILE: file, SPOOL_RUNNER_CONFIG: JSON.stringify(spec.input) },
    });
    const record = { child, key: spec.key, draining: false, notified: new Set() };
    running.set(id, record);
    child.stdin.on("error", error => console.error(`[${id}] Control pipe: ${error.message}`));
    child.once("error", error => console.error(`[${id}] Launch failed: ${error.message}`));
    child.once("close", (code, signal) => {
      running.delete(id);
      if (stopped || !desired.has(id)) return;
      console.error(`[${id}] Exited (${code ?? signal}); ${record.draining ? "applying configuration" : "retrying"}.`);
      const timer = setTimeout(() => { retries.delete(id); start(id); }, record.draining ? 0 : retryMs);
      retries.set(id, timer);
    });
  }
  function drain(id, record) {
    if (record.draining) return;
    record.draining = true;
    console.log(`[${id}] Configuration changed; waiting for the current scan to finish.`);
    record.child.stdin.end("stop\n");
  }
  function reload() {
    if (stopped) return;
    try {
      const input = readConfiguration(file), next = new Map();
      if (!node && process.env.SPOOL_DIR) input.spool_dir = process.env.SPOOL_DIR;
      input.ado ??= {};
      for (const [key, name] of [["organization", "ADO_ORGANIZATION"], ["project", "ADO_PROJECT"], ["repository", "ADO_REPOSITORY"]])
        if (process.env[name]) input.ado[key] = process.env[name];
      for (const id of runnerNames(input)) {
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
        const workspaces = ["pr-reviewer", "livesite"].includes(source) ? undefined : input.agent_workspaces;
        next.set(id, { input, key: JSON.stringify([execution, setting.enabled, input.ado, workspaces, input.spool_dir, input.node_binary]) });
      }
      desired = next;
      onError(null);
      for (const [id, record] of running) if (next.get(id)?.key !== record.key) drain(id, record);
      for (const id of next.keys()) if (!retries.has(id)) start(id);
      for (const [id, record] of running) if (!record.draining && !managedIds.includes(id)) {
        const pending = listRuns(path.join(root, "runners", id, ".runner")).filter(run => ["queued", "running"].includes(run.status));
        if (pending.some(run => run.status === "queued" && !record.notified.has(run.id))) record.child.stdin.write("run\n");
        record.notified = new Set(pending.map(run => run.id));
      }
    } catch (error) {
      console.error(`Runner configuration rejected; existing runners unchanged: ${error.stack}`);
      onError(error);
    }
  }
  const watcher = watch(path.dirname(file), (_event, name) => {
    if (name && name.toString() !== path.basename(file)) return;
    clearTimeout(scheduled); scheduled = setTimeout(reload, 100);
  });
  watcher.on("error", error => console.error(`Runner configuration watcher failed: ${error.stack}`));
  mkdirSync(path.join(root, "runners"), { recursive: true });
  const executions = watch(path.join(root, "runners"), { recursive: true }, (_event, name) => {
    if (!name?.toString().replaceAll("\\", "/").match(/^[^/]+\/\.runner\/executions\/[a-f0-9-]+\.json$/)) return;
    clearTimeout(scheduled); scheduled = setTimeout(reload, 100);
  });
  executions.on("error", error => console.error(`Workflow event watcher failed: ${error.stack}`));
  reload();
  return { reload, running, async stop() {
    stopped = true; watcher.close(); executions.close(); clearTimeout(scheduled);
    for (const timer of retries.values()) clearTimeout(timer);
    await Promise.all([...running].map(([id, record]) => new Promise(resolve => {
      record.child.once("close", resolve); drain(id, record);
    })));
  } };
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
