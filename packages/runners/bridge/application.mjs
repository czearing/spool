import { watch, mkdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { acquireProcessLock, writeRunnerJson } from "../packages/bohemia-agent-tooling/src/index.js";
import { supervise } from "./workflow-supervisor.mjs";
import { SpoolStore } from "./spool-store.mjs";
import { createMonitorControls } from "./monitor-controls.mjs";
import { watchFiles } from "./file-watch.mjs";

export function runMessageControls(root) {
  if (!["agents", ...["incoming", "in_progress", "completed", "failed"].map(queue => path.join("queues", queue))]
    .every(directory => existsSync(path.join(root, directory)))) return { stop: async () => {} };
  const controls = createMonitorControls(new SpoolStore(root));
  let stopped = false, scheduled;
  const running = new Set();
  const watchFailed = error => {
    watcher.close();
    console.error(`Message continuation watcher failed for ${root}:`, error);
  };
  const refresh = () => {
    if (stopped) return;
    try { watcher.sync(); } catch (error) { watchFailed(error); }
    const operation = controls.jobs().catch(error => {
      console.error(`Message continuation failed for ${root}:`, error);
    }).finally(() => { running.delete(operation); });
    running.add(operation);
  };
  const wake = () => {
    if (stopped || scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = undefined;
      refresh();
    }, 25);
  };
  const watcher = watchFiles(() => [
    path.join(root, "queues", "failed"),
    ...["requests", "manual", "native-resumes"].map(directory => path.join(root, "controls", directory)),
  ].map(directory => ({ path: directory, directory: true, accepts: file => path.extname(file) === ".json" })),
  wake, watchFailed, { persistent: true });
  const timer = setInterval(refresh, 1000);
  timer.unref();
  wake();
  return { stop: async () => {
    stopped = true; clearTimeout(scheduled); clearInterval(timer);
    watcher.close();
    await Promise.all(running);
    await controls.stop();
  } };
}

export function startMessageControls(root) {
  const worker = new Worker(new URL("./message-controls-worker.mjs", import.meta.url), {
    workerData: root, stdout: true, stderr: true,
  });
  worker.stdout.pipe(process.stderr, { end: false });
  worker.stderr.pipe(process.stderr, { end: false });
  let stopping = false;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  worker.once("message", message => { if (message === "ready") readyResolve(); });
  const closed = new Promise((resolve, reject) => {
    worker.once("error", error => { readyReject(error); reject(error); });
    worker.once("exit", code => {
      readyReject(new Error(`Message continuation worker stopped before readiness for ${root}`));
      if (stopping && code === 0) resolve();
      else reject(new Error(`Message continuation worker exited (${code}) for ${root}`));
    });
  });
  closed.catch(error => console.error("Message continuation worker failed:", error));
  return { ready, stop: () => {
    if (!stopping) { stopping = true; worker.postMessage("stop"); }
    return closed;
  } };
}

export async function startApplicationRunners(registry) {
  const projects = new Map(), failures = new Map();
  let stopping = false, shutdown, timer, chain = Promise.resolve();
  const stopProject = async (key, service) => {
    service.report("stopping");
    await service.messages.stop();
    await service.supervisor.stop();
    service.report("stopped");
    await service.release(); projects.delete(key);
  };
  const sync = async () => {
    if (stopping) return;
    const data = existsSync(registry) ? JSON.parse(readFileSync(registry, "utf8")) : { version: 1, projects: [] };
    if (data.version !== 1 || !Array.isArray(data.projects)) throw new Error("Invalid runner project registry.");
    const registered = new Set(data.projects.map(project => project?.root));
    for (const root of failures.keys()) if (!registered.has(root)) failures.delete(root);
    const wanted = new Set();
    for (const project of data.projects) {
      try {
        if (typeof project.root !== "string" || !path.isAbsolute(project.root)) throw new Error("Invalid runner project directory.");
        const root = realpathSync.native(project.root), key = process.platform === "win32" ? root.toLowerCase() : root;
        wanted.add(key);
        if (projects.has(key)) { failures.delete(project.root); continue; }
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
          await supervisor.ready;
          const messages = startMessageControls(root);
          try { await messages.ready; }
          catch (error) { await supervisor.stop(); throw error; }
          projects.set(key, { supervisor, messages, release, report });
          failures.delete(project.root);
        } catch (error) { await release(); throw error; }
      } catch (error) {
        const root = project?.root;
        if (failures.get(root) !== error.message) {
          failures.set(root, error.message);
          console.error(`Cannot start runners for project ${root ?? "(invalid)"}:`, error);
        }
      }
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
