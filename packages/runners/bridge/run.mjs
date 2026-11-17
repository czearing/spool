import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runManagedRunner } from "../packages/bohemia-agent-tooling/src/index.js";
import { configure, readRunnerConfiguration } from "./config.mjs";
import { engine } from "./sources.mjs";
import { SpoolStore, readJson } from "./spool-store.mjs";
import { createSpoolQueue } from "./queue.mjs";
import { withAdmission } from "./admission.mjs";
import { repositoryCall } from "./repository-call.mjs";
import { trackPreparation } from "./preparation-progress.mjs";
import { createWorkspacePreparer } from "./workspace-preparation.mjs";
import { definition } from "./workflow-store.mjs";
import { createEventPipeline, filteredEvent, bindEventQueue, eventPreparer } from "./workflow-event-pipeline.mjs";
import { eventConfiguration } from "./workflow-event-config.mjs";
import { eventSource } from "@spool/workflow";
import { codespaceReviewer, codespaceReviewInUse, codespaceReviewPending } from "./codespace-reviewer.mjs";
import { createMonitorControls } from "./monitor-controls.mjs";
import { preventIdleSleep } from "./system-wake.mjs";

export async function run(name, entryUrl, suppliedWorkflow, original = readRunnerConfiguration(entryUrl)) {
  const directory = path.dirname(fileURLToPath(entryUrl));
  const workflow = suppliedWorkflow || definition(original, name);
  if (!workflow.enabled) throw new Error(`Runner is disabled: ${workflow.id}`);
  name = eventSource(workflow);
  const input = eventConfiguration(original, workflow);
  const options = configure(input, name, directory);
  const { config, agent, workspace, runtime, interval } = options;
  mkdirSync(runtime, { recursive: true });
  const store = new SpoolStore(input.spool_dir);
  const queue = name === "spelling" ? null : createSpoolQueue(store, { agent, workspace, runner: name,
    nativeDispatch: name === "perf" && config.repositoryProfile === "1js",
    identity: workflow.id, handoffInstructions: config.handoffInstructions, verbatimPrompt: ["perf", "ci", "backlog"].includes(name) });
  const once = !process.argv.includes("--watch");
  const controlledInput = !once && !process.argv.includes("--service");
  let lifecycle, stopRequested = false;
  const remoteReview = name === "pr-reviewer" && config.codespaceReviewConfig ? codespaceReviewer(config) : null;
  if (remoteReview && once) throw new Error("Codespace reviewer must run with --watch so owned authentication and workspace lease survive task handoff");
  const call = trackPreparation(remoteReview
    ? async () => { throw new Error("Codespace review owns its remote preparation; additional local repository actions are unsupported"); }
    : repositoryCall(config), () => lifecycle, runtime);
  const pipeline = createEventPipeline(workflow, { store, runtime, call, observe: update => lifecycle?.observe(update),
    ...(remoteReview ? { verifyPreparation: prepared => remoteReview.verify(prepared) } : {}) });
  config.eventPipeline = pipeline;
  if (queue) bindEventQueue(queue, pipeline);
  const preparer = prepare => {
    const action = createWorkspacePreparer({ store, queue, agent, workspace, call, ...(prepare ? { prepare } : {}) });
    return eventPreparer(pipeline, action, workspace);
  };
  const stop = () => { stopRequested = true; lifecycle?.stop(); };
  const onLifecycle = value => {
    lifecycle = value; value.observe({ configurationRevision: workflow.revision });
    if (stopRequested) lifecycle.stop();
  };
  const control = data => { if (data.toString().includes("stop")) stop(); };
  if (controlledInput) {
    process.stdin.on("data", control);
    process.stdin.once("end", stop);
  }
  const finishScan = scan => async () => {
    try { return await scan(); }
    finally {
      pipeline.completeScan();
      if (remoteReview && !codespaceReviewInUse(store, agent)) await remoteReview.dispose();
    }
  };
  const recoveryControls = remoteReview || config.repositoryProfile === "1js" && ["perf", "backlog"].includes(name)
    ? createMonitorControls(store) : null;
  let releaseWake;
  const wrapScan = async scan => {
    if (remoteReview && !codespaceReviewInUse(store, agent)) await remoteReview.dispose();
    if (recoveryControls && name !== "pr-reviewer" && !releaseWake?.active()) {
      releaseWake?.();
      releaseWake = await preventIdleSleep();
    }
    await recoveryControls?.jobs();
    const result = await withAdmission(input.spool_dir, agent || "runner-spelling", finishScan(scan), workspace);
    if (releaseWake && !store.tasks().some(task => task.agent === agent && ["incoming", "in_progress"].includes(task.status)) &&
        (result.openPrs >= result.maxOpenPrs || result.holding === "No eligible unassigned backlog work remains")) {
      releaseWake();
      releaseWake = undefined;
    }
    return result;
  };
  try {
    if (name === "pr-reviewer") {
      const { runReviewer } = await engine("pr-reviewer/run.mjs");
      const { paperclipReviewerTasks } = await engine("pr-reviewer/lib/task-source.mjs");
      const { prepareReviewWorkspace } = await engine("pr-reviewer/lib/workspace.mjs");
      await runReviewer(entryUrl, {
        config, queue, once, onLifecycle, wrapScan,
        taskSource: cfg => paperclipReviewerTasks(cfg, queue),
        isBusy: async () => store.liveTasks().some(task => task.agent === agent) ||
          !!remoteReview && codespaceReviewPending(store, agent),
        prepareWorkspace: preparer(remoteReview ? options => remoteReview.prepare(options) : prepareReviewWorkspace),
      });
    } else if (name === "livesite") {
      const { runLivesite } = await engine("livesite/run.mjs");
      await runLivesite(entryUrl, { config, queue, once, onLifecycle, wrapScan,
        setupAgentBranch: preparer(),
      });
    } else {
      await runManagedRunner(entryUrl, async value => {
        onLifecycle(value);
        const observe = update => value.observe(update);
        let scan;
        if (name === "backlog") {
          const { createBacklogScan } = await import("./backlog.mjs");
          scan = createBacklogScan({ store, config, queue, workspace, runtime, observe });
        } else if (["perf", "ci"].includes(name)) {
          const { createDiscoveryScan } = await import("./discovery.mjs");
          scan = createDiscoveryScan(name, { store, config, queue, workspace, runtime,
            prepare: preparer(), observe });
        } else if (name === "spelling") {
          const [{ createSpellingScan }, { createSpellingPublisher }] = await Promise.all([
            import("./spelling.mjs"), import("../scanners/spelling/publish.mjs"),
          ]);
          value.observe({ dispatched: 0, taskId: null, scanProgress: null });
          const publish = config.publishAgent && createSpellingPublisher({ store, config, runtime, call, observe });
          scan = createSpellingScan({ store, config, workspace, runtime, call,
            publish: async result => {
              try { return await pipeline.report({ commit: result.commit, workspace, issues: result.issues,
                filesWithIssues: result.filesWithIssues, report: path.join(runtime, "spelling-todo.json") },
              publish ? () => publish(result) : undefined); }
              catch (error) { if (!filteredEvent(error)) throw error; return { filtered: true, holding: error.message }; }
            },
            observe });
        } else {
          const { createUpdater } = await import("./updater.mjs");
          scan = await createUpdater({ store, config, agent, workspace, runtime, callBohemia: call, observe });
        }
        await value.poll({ scan: name === "pr-updater" ? finishScan(scan) : () => wrapScan(scan),
          intervalMs: (name === "spelling" ? Math.min(interval, 300) : interval) * 1000, once });
      });
    }
    if (!lifecycle) throw new Error(`${name} is already running; duplicate launch refused`);
    const status = readJson(path.join(runtime, "status.json"));
    if (status?.lastError) throw new Error(status.lastError);
  } finally {
    releaseWake?.();
    if (remoteReview) await remoteReview.drain(store, agent, () => recoveryControls?.jobs());
    process.stdin.off("data", control);
    process.stdin.off("end", stop);
    process.stdin.pause();
  }
}
