import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, unlinkSync } from "node:fs";
import { fixture } from "./fixtures.mjs";
import { createPerformanceScan, performanceDiscoveryPrompt } from "../perf-discovery.mjs";
import { createSpoolQueue } from "../queue.mjs";
import { readJson, writeJson } from "../spool-store.mjs";
import { withAdmission } from "../admission.mjs";
import { configure } from "../config.mjs";
import { eventConfiguration } from "../workflow-event-config.mjs";
import { createEventPipeline, bindEventQueue, eventPreparer } from "../workflow-event-pipeline.mjs";
import { eventRecipe, validateWorkflow } from "../../packages/workflow/index.mjs";
import { inspectWorkflow } from "../workflow-inspection.mjs";
import { runnerDetails } from "../runner-details.mjs";

const pr = id => ({ id: String(id), status: "active", branch: `user/calebzearing/new-office-production-perf-${id}` });
function setup(t, options = {}) {
  const f = fixture(t), runtime = path.join(f.root, "runtime");
  mkdirSync(runtime);
  const config = { agentId: "perf", maxOpenPrs: 3, ado: {}, legacyBranchPrefixes: ["new-office-production-perf-", "new-office-perf-"] };
  const queue = createSpoolQueue(f.store, { agent: "perf", workspace: f.workspace, runner: "perf",
    identity: "new-office-perf", verbatimPrompt: true });
  const calls = [];
  const prepare = async args => {
    calls.push(args);
    return args.prepared || { ...f.preparation, branch: `user/calebzearing/${args.branch}` };
  };
  const scan = createPerformanceScan({ store: f.store, queue, workspace: f.workspace, runtime, config,
    prepare, listPullRequests: async (_ado, value) => {
      assert.deepEqual(value, { allPages: true, refresh: true });
      return [pr(5825353), pr(5825747)];
    }, ...options });
  return { ...f, config, queue, runtime, calls, scan, prepare };
}
test("two open pilot PRs allow exactly one prepared, one-sentence improvement", async t => {
  const f = setup(t), result = await f.scan(), task = f.store.task(result.taskId);
  assert.equal(result.dispatched, 1);
  assert.equal(result.openPrs, 2);
  assert.equal(task.prompt, "Find and implement one more small, safe New Office production-performance improvement distinct from PRs 5825353, 5825747, proving a real production cost reduction and preserved behavior before publishing.");
  assert.equal(task.prompt.split("\n").length, 1);
  assert.equal(task.prompt.match(/[.!?]/g).length, 1);
  assert.equal(f.calls[0].runSetup, true);
  assert.equal(f.calls[0].runBuild, false);
  assert.equal(f.calls[0].reset, false);
  assert.equal(f.store.metadata(task.id).preparation.ready, true);
  assert.equal(f.store.metadata(task.id).handoff.maxOpenPrs, 3);
  assert.equal((await f.scan()).dispatched, 0);
  assert.equal(f.calls.length, 1);
});
for (const count of [3, 4]) test(`${count} open perf PRs hold before preparation, including drafts and registered nonstandard branches`, async t => {
  const f = setup(t, { listPullRequests: async () => [
    pr(1), { ...pr(2), isDraft: true }, { ...pr(3), branch: "user/calebzearing/custom-improvement" },
    ...(count === 4 ? [pr(4)] : []),
    { ...pr(5), status: "completed" }, { ...pr(6), branch: "user/calebzearing/docs-only" },
  ] });
  f.put({ id: "registered", agent: "perf" }, "completed");
  writeJson(path.join(f.store.records, "task-registered.json"), { preparation: { branch: "user/calebzearing/custom-improvement" } });
  const result = await f.scan();
  assert.match(result.holding, new RegExp(`Open PR limit reached \\(${count}/3\\)`));
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.tasks().length, 1);
});
test("capacity reaching three during preparation holds delivery and prepares fresh master when a slot opens", async t => {
  let reads = 0;
  const f = setup(t, { listPullRequests: async () => ++reads === 2 ? [pr(1), pr(2), pr(3)] : [pr(1), pr(2)] });
  assert.match((await f.scan()).holding, /3\/3/);
  assert.equal(f.store.tasks().length, 0);
  const prior = readJson(path.join(f.runtime, "perf-discovery.json"));
  assert.equal((await f.scan()).dispatched, 1);
  assert.equal(f.calls[1].prepared, undefined);
  assert.notEqual(readJson(path.join(f.runtime, "perf-discovery.json")).eventId, prior.eventId);
});
test("closed PRs free capacity after the original task and provider have settled", async t => {
  const f = setup(t);
  const first = await f.scan(), task = f.store.task(first.taskId);
  f.put({ ...task, file: undefined }, "completed");
  unlinkSync(task.file);
  const next = await f.scan();
  assert.equal(next.dispatched, 1);
  assert.notEqual(next.taskId, first.taskId);
  assert.notEqual(f.calls[0].branch, f.calls[1].branch);
});
test("failed discovery holds further assignments rather than churning retries", async t => {
  const f = setup(t);
  const first = await f.scan(), task = f.store.task(first.taskId);
  unlinkSync(task.file);
  f.put({ ...task, file: undefined }, "failed");
  assert.match((await f.scan()).holding, /failed; inspect the original task/);
  assert.equal(f.calls.length, 1);
});
test("a completed task with a surviving provider still owns the perf agent", async t => {
  const f = setup(t), first = await f.scan(), task = f.store.task(first.taskId);
  unlinkSync(task.file);
  f.put({ ...task, file: undefined, session_id: "perf-surviving-session" }, "completed");
  f.store.processes = () => [{ Name: "node.exe", CommandLine: "--session-id perf-surviving-session" }];
  assert.match((await f.scan()).holding, /Existing Spool task or session/);
  assert.equal(f.calls.length, 1);
  f.store.processes = () => [];
  assert.equal((await f.scan()).dispatched, 1);
});
test("a committed submission with an interrupted cursor is recovered without another preparation", async t => {
  const f = setup(t), first = await f.scan(), file = path.join(f.runtime, "perf-discovery.json");
  const state = readJson(file); delete state.taskId; writeJson(file, state);
  const restarted = createPerformanceScan({ store: f.store, config: f.config, queue: f.queue,
    workspace: f.workspace, runtime: f.runtime, prepare: async () => assert.fail("Cannot prepare a delivered event") });
  assert.equal((await restarted()).taskId, first.taskId);
  assert.equal(f.store.tasks().length, 1);
  assert.equal(readJson(file).taskId, first.taskId);
});
test("pause and active work prevent preparation; API and preparation failures surface", async t => {
  const f = setup(t);
  f.store.isPaused = () => true;
  assert.match((await f.scan()).holding, /paused/);
  assert.equal(f.calls.length, 0);
  f.store.isPaused = () => false;
  const failed = createPerformanceScan({ store: f.store, config: f.config, queue: f.queue,
    workspace: f.workspace, runtime: f.runtime, prepare: f.prepare,
    listPullRequests: async () => { throw new Error("Azure unavailable"); } });
  await assert.rejects(failed(), /Azure unavailable/);
  const failedPrepare = createPerformanceScan({ store: f.store, config: f.config, queue: f.queue,
    workspace: f.workspace, runtime: f.runtime, prepare: async () => { throw new Error("Setup failed"); },
    listPullRequests: async () => [] });
  await assert.rejects(failedPrepare(), /Setup failed/);
  assert.equal(f.store.tasks().length, 0);
});
test("concurrent recurring runners share perf admission rather than reserving a fourth PR", async t => {
  const f = setup(t);
  const results = await Promise.all([1, 2].map(() =>
    withAdmission(f.store.root, "perf", f.scan, f.workspace)));
  assert.equal(results.filter(result => result.dispatched === 1).length, 1);
  assert.equal(f.store.tasks().length, 1);
  assert.equal(f.calls.length, 1);
});
test("the custom integration config, preview and real event pipeline preserve the exact prompt and preparation receipt", async t => {
  const f = setup(t), input = { spool_dir: f.root };
  const workflow = { id: "new-office-perf", name: "New Office performance", kind: "custom", enabled: true,
    workspace: f.workspace, intervalSeconds: 60, ...eventRecipe("perf", { agent: "perf", maxOpenPrs: 3 }) };
  validateWorkflow(workflow);
  const { config } = configure(eventConfiguration(input, workflow), "perf", f.root);
  assert.equal(config.maxOpenPrs, 3);
  assert.equal(runnerDetails({ runner: workflow.id }, workflow, f.runtime).repository.mode, "on-demand");
  const preview = await inspectWorkflow(input, workflow);
  assert.equal(preview.inspection[workflow.nodes.at(-1).id].prompt, performanceDiscoveryPrompt());
  const pipeline = createEventPipeline(workflow, { store: f.store, runtime: f.runtime,
    verifyPreparation: async prepared => assert.equal(prepared.repoRoot, f.workspace) });
  bindEventQueue(f.queue, pipeline);
  const scan = createPerformanceScan({ store: f.store, config, queue: f.queue, workspace: f.workspace,
    runtime: f.runtime, prepare: eventPreparer(pipeline, f.prepare, f.workspace), listPullRequests: async () => [] });
  const result = await scan();
  assert.equal(f.store.task(result.taskId).prompt, performanceDiscoveryPrompt());
  assert.equal(f.store.metadata(result.taskId).preparation.ready, true);
  const altered = structuredClone(workflow); altered.nodes.at(-1).prompt += "\nDo something else.";
  assert.throws(() => validateWorkflow(altered), /one-sentence/);
  const over = structuredClone(workflow); over.nodes[0].maxOpenPrs = "4";
  assert.throws(() => validateWorkflow(over), /1 to 3/);
});
