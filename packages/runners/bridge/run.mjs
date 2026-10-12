import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runManagedRunner } from "../packages/bohemia-agent-tooling/src/index.js";
import { configure, readConfiguration } from "./config.mjs";
import { engine } from "./sources.mjs";
import { SpoolStore, readJson } from "./spool-store.mjs";
import { createSpoolQueue } from "./queue.mjs";
import { withAdmission } from "./admission.mjs";
import { callBohemia } from "../packages/bohemia-pr-mcp/src/client.mjs";
import { trackPreparation } from "./preparation-progress.mjs";
import { createWorkspacePreparer } from "./workspace-preparation.mjs";
import { definition } from "./workflow-store.mjs";
import { createEventPipeline, filteredEvent, bindEventQueue, eventPreparer } from "./workflow-event-pipeline.mjs";
import { eventConfiguration } from "./workflow-event-config.mjs";
import { eventSource } from "@spool/workflow";

export async function run(name, entryUrl, suppliedWorkflow) {
  const directory = path.dirname(fileURLToPath(entryUrl));
  const original = process.env.SPOOL_RUNNER_CONFIG ? JSON.parse(process.env.SPOOL_RUNNER_CONFIG)
    : readConfiguration(path.join(directory, "..", "..", "spool-runners.json"));
  const workflow = suppliedWorkflow || definition(original, name);
  if (!workflow.enabled) throw new Error(`Runner is disabled: ${workflow.id}`);
  name = eventSource(workflow);
  const input = eventConfiguration(original, workflow);
  const options = configure(input, name, directory);
  const { config, agent, workspace, runtime, interval } = options;
  mkdirSync(runtime, { recursive: true });
  const store = new SpoolStore(input.spool_dir);
  const queue = name === "spelling" ? null : createSpoolQueue(store, { agent, workspace, runner: name,
    identity: workflow.id, handoffInstructions: config.handoffInstructions, verbatimPrompt: name === "perf" });
  const once = !process.argv.includes("--watch");
  let lifecycle, stopRequested = false;
  const call = trackPreparation(callBohemia, () => lifecycle, runtime);
  const pipeline = createEventPipeline(workflow, { store, runtime, call, observe: update => lifecycle?.observe(update) });
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
  if (!once) {
    process.stdin.on("data", control);
    process.stdin.once("end", stop);
  }
  const finishScan = scan => async () => {
    try { return await scan(); } finally { pipeline.completeScan(); }
  };
  const wrapScan = scan => withAdmission(input.spool_dir, agent || "runner-spelling", finishScan(scan), workspace);
  try {
    if (name === "pr-reviewer") {
      const { runReviewer } = await engine("pr-reviewer/run.mjs");
      const { paperclipReviewerTasks } = await engine("pr-reviewer/lib/task-source.mjs");
      const { prepareReviewWorkspace } = await engine("pr-reviewer/lib/workspace.mjs");
      await runReviewer(entryUrl, {
        config, queue, once, onLifecycle, wrapScan,
        taskSource: cfg => paperclipReviewerTasks(cfg, queue),
        isBusy: async () => store.liveTasks().some(task => task.agent === agent),
        prepareWorkspace: preparer(prepareReviewWorkspace),
      });
    } else if (name === "livesite") {
      const { runLivesite } = await engine("livesite/run.mjs");
      await runLivesite(entryUrl, { config, queue, once, onLifecycle, wrapScan,
        setupAgentBranch: preparer(),
      });
    } else if (name === "perf") {
      const { createPerformanceScan } = await import("./perf-discovery.mjs");
      await runManagedRunner(entryUrl, async value => {
        onLifecycle(value);
        const action = createWorkspacePreparer({ store, queue, agent, workspace, call });
        const prepare = eventPreparer(pipeline, async options => {
          if (!options.prepared) return action(options);
          store.assertIdle(agent, workspace);
          queue.setPreparation(options.prepared);
          return options.prepared;
        }, workspace);
        const scan = createPerformanceScan({ store, config, queue, workspace, runtime, prepare,
          observe: update => value.observe(update) });
        await value.poll({ scan: () => wrapScan(scan), intervalMs: interval * 1000, once });
      });
    } else if (name === "spelling") {
      const [{ createSpellingScan }, { createSpellingPublisher }] = await Promise.all([
        import("./spelling.mjs"), import("../scanners/spelling/publish.mjs"),
      ]);
      await runManagedRunner(entryUrl, async value => {
        onLifecycle(value);
        value.observe({ dispatched: 0, taskId: null, scanProgress: null });
        const publish = config.publishAgent && createSpellingPublisher({ store, config, runtime, call });
        const scan = createSpellingScan({ store, config, workspace, runtime, call,
          publish: async result => {
            try { return await pipeline.report({ commit: result.commit, workspace, issues: result.issues,
            filesWithIssues: result.filesWithIssues, report: path.join(runtime, "spelling-todo.json") },
            publish ? () => publish(result) : undefined); }
            catch (error) { if (!filteredEvent(error)) throw error; return { filtered: true, holding: error.message }; }
          },
          observe: update => value.observe(update) });
        await value.poll({ scan: () => wrapScan(scan), intervalMs: Math.min(interval, 300) * 1000, once });
      });
    } else {
      const { createUpdater } = await import("./updater.mjs");
      await runManagedRunner(entryUrl, async value => {
        onLifecycle(value);
        const scan = await createUpdater({ store, config, agent, workspace, runtime, callBohemia: call,
          observe: update => value.observe(update) });
        await value.poll({ scan: finishScan(scan), intervalMs: interval * 1000, once });
      });
    }
    if (!lifecycle) throw new Error(`${name} is already running; duplicate launch refused`);
    const status = readJson(path.join(runtime, "status.json"));
    if (status?.lastError) throw new Error(status.lastError);
  } finally {
    process.stdin.off("data", control);
    process.stdin.off("end", stop);
    process.stdin.pause();
  }
}
