import { watch, mkdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { acquireProcessLock, writeRunnerJson } from "../packages/bohemia-agent-tooling/src/index.js";
import { supervise } from "./workflow-supervisor.mjs";

export async function startApplicationRunners(registry) {
  const projects = new Map();
  let stopping = false, shutdown, timer, chain = Promise.resolve();
  const stopProject = async (key, service) => {
    service.report("stopping");
    await service.supervisor.stop();
    service.report("stopped");
    await service.release(); projects.delete(key);
  };
  const sync = async () => {
    if (stopping) return;
    const data = existsSync(registry) ? JSON.parse(readFileSync(registry, "utf8")) : { version: 1, projects: [] };
    if (data.version !== 1 || !Array.isArray(data.projects)) throw new Error("Invalid runner project registry.");
    const wanted = new Set();
    for (const project of data.projects) {
      try {
        if (typeof project.root !== "string" || !path.isAbsolute(project.root)) throw new Error("Invalid runner project directory.");
        const root = realpathSync.native(project.root), key = process.platform === "win32" ? root.toLowerCase() : root;
        wanted.add(key);
        if (projects.has(key)) continue;
        const runtime = path.join(root, ".runner", "automation"), config = path.join(runtime, "spool-runners.json");
        mkdirSync(runtime, { recursive: true });
        const release = await acquireProcessLock(runtime.toLowerCase(), { namespace: "application-runners", timeoutMs: 1000 });
        try {
          if (!existsSync(config)) writeRunnerJson(config, { spool_dir: root, custom_runners: {} });
          let previous;
          const report = (state, error) => {
            const value = { pid: process.pid, state, ...(error ? { error: String(error.message) } : {}) };
            const next = JSON.stringify(value);
            if (next === previous) return;
            try { writeRunnerJson(path.join(runtime, "service.json"), value); previous = next; }
            catch (error) { console.error(`Cannot write runner service status for ${root}:`, error); }
          };
          const supervisor = supervise(config, { root: runtime, project: root, node: process.execPath,
            onError: error => report(error ? "error" : "running", error) });
          projects.set(key, { supervisor, release, report });
        } catch (error) { await release(); throw error; }
      } catch (error) { console.error(`Cannot start runners for project ${project?.root ?? "(invalid)"}:`, error); }
    }
    for (const [key, service] of projects) if (!wanted.has(key)) {
      await stopProject(key, service);
    }
  };
  const stop = () => shutdown ??= (async () => {
    stopping = true; clearTimeout(timer); watcher.close();
    await chain;
    await Promise.all([...projects].map(([key, service]) => stopProject(key, service)));
  })();
  mkdirSync(path.dirname(registry), { recursive: true });
  const watcher = watch(path.dirname(registry), (_event, name) => {
    if (name && name.toString() !== path.basename(registry)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      chain = chain.then(sync).catch(error => { console.error("Application runner configuration failed:", error); });
    }, 50);
  });
  watcher.on("error", error => console.error("Runner project watcher failed:", error));
  chain = sync();
  try { await chain; } catch (error) { chain = Promise.resolve(); await stop(); throw error; }
  return { stop };
}
