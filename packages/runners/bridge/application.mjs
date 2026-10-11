import { watch, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { acquireProcessLock, writeRunnerJson } from "../packages/bohemia-agent-tooling/src/index.js";
import { supervise } from "./workflow-supervisor.mjs";
import { runnerNames, loadWorkflowConfig } from "./workflow-store.mjs";
import { ensureRunnerEntry } from "./runner-entry.mjs";

export async function startApplicationRunners(registry) {
  const projects = new Map();
  let stopping = false, timer, chain = Promise.resolve();
  const sync = async () => {
    if (stopping) return;
    const data = existsSync(registry) ? JSON.parse(readFileSync(registry, "utf8")) : { version: 1, projects: [] };
    if (data.version !== 1 || !Array.isArray(data.projects)) throw new Error("Invalid runner project registry.");
    const wanted = new Set();
    for (const project of data.projects) {
      if (typeof project.root !== "string" || !path.isAbsolute(project.root)) throw new Error("Invalid runner project directory.");
      const root = path.resolve(project.root), key = process.platform === "win32" ? root.toLowerCase() : root;
      wanted.add(key);
      if (projects.has(key)) continue;
      const runtime = path.join(root, ".runner", "automation"), config = path.join(runtime, "spool-runners.json");
      mkdirSync(runtime, { recursive: true });
      const release = await acquireProcessLock(runtime.toLowerCase(), { namespace: "application-runners", timeoutMs: 1000 });
      try {
        if (!existsSync(config)) writeRunnerJson(config, { spool_dir: root, custom_runners: {} });
        const input = loadWorkflowConfig(config, root);
        for (const id of runnerNames(input)) ensureRunnerEntry(runtime, id);
        const supervisor = supervise(config, { root: runtime, node: process.execPath, onError: error => {
          writeRunnerJson(path.join(runtime, "service.json"), { pid: process.pid, state: error ? "error" : "running",
            ...(error ? { error: String(error.message) } : {}) });
        } });
        projects.set(key, { supervisor, release });
      } catch (error) { await release(); throw error; }
    }
    for (const [key, service] of projects) if (!wanted.has(key)) {
      await service.supervisor.stop(); await service.release(); projects.delete(key);
    }
  };
  const stop = async () => {
    stopping = true; clearTimeout(timer); watcher.close();
    await chain;
    await Promise.all([...projects].map(async ([key, service]) => {
      await service.supervisor.stop(); await service.release(); projects.delete(key);
    }));
  };
  mkdirSync(path.dirname(registry), { recursive: true });
  const watcher = watch(path.dirname(registry), (_event, name) => {
    if (name && name.toString() !== path.basename(registry)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      chain = chain.then(sync).catch(error => { console.error("Application runner configuration failed:", error); });
    }, 50);
  });
  watcher.on("error", error => console.error("Runner project watcher failed:", error));
  try { await sync(); } catch (error) { await stop(); throw error; }
  return { stop };
}
