import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { fixture } from "./fixtures.mjs";
import { createDiscoveryScan, discoveryPrompt } from "../discovery.mjs";
import { createSpoolQueue } from "../queue.mjs";
import { readJson, writeJson } from "../spool-store.mjs";
import { withAdmission } from "../admission.mjs";
import { configure } from "../config.mjs";
import { eventConfiguration } from "../workflow-event-config.mjs";
import { createEventPipeline, bindEventQueue, eventPreparer } from "../workflow-event-pipeline.mjs";
import { eventRecipe, validateWorkflow, operationAvailable } from "@spool/workflow";
import { inspectWorkflow } from "../workflow-inspection.mjs";
import { runnerDetails } from "../runner-details.mjs";

const pr = id => ({ id: String(id), status: "active", branch: `user/calebzearing/bohemia-ci-${id}` });
function setup(t, options = {}) {
  const f = fixture(t), runtime = path.join(f.root, "runtime");
  mkdirSync(runtime);
  writeFileSync(path.join(f.root, "agents", "ci.md"), "Fixture CI agent. Never executed.");
  const config = { agentId: "ci", maxOpenPrs: 1, ado: {}, legacyBranchPrefixes: ["bohemia-ci-", "ci-"] };
  const queue = createSpoolQueue(f.store, { agent: "ci", workspace: f.workspace, runner: "ci",
    identity: "bohemia-ci", verbatimPrompt: true });
  const calls = [], prepare = async args => {
    calls.push(args);
    return args.prepared || { ...f.preparation, branch: `user/calebzearing/${args.branch}` };
  };
  const input = { store: f.store, config, queue, workspace: f.workspace, runtime, prepare,
    listPullRequests: async (_ado, options) => {
      assert.deepEqual(options, { allPages: true, refresh: true });
      return [];
    }, ...options };
  return { ...f, ...input, calls, scan: createDiscoveryScan("ci", input) };
}
test("CI dispatches one prepared task with exact measured-gain instructions and no reset", async t => {
  const f = setup(t), result = await f.scan(), task = f.store.task(result.taskId);
  assert.equal(result.dispatched, 1);
  assert.equal(task.agent, "ci");
  assert.equal(task.prompt, discoveryPrompt("ci"));
  assert.match(task.prompt, /three matched before and after CI runs/);
  assert.match(task.prompt, /preserved coverage, reliability, and runner cost/);
  assert.equal(f.calls[0].reset, false);
  assert.equal(f.calls[0].runSetup, true);
  assert.equal(f.calls[0].runBuild, false);
  assert.match(f.calls[0].branch, /^bohemia-ci-/);
  assert.equal(f.store.metadata(task.id).preparation.ready, true);
  assert.equal(f.store.metadata(task.id).handoff.maxOpenPrs, 1);
  assert.equal((await f.scan()).dispatched, 0);
  assert.equal(f.calls.length, 1);
});
for (const variant of ["normal", "draft", "registered"]) test(`one ${variant} CI PR prevents all preparation`, async t => {
  const existing = { ...pr(1), isDraft: variant === "draft",
    ...(variant === "registered" ? { branch: "user/calebzearing/custom-ci-change" } : {}) };
  const f = setup(t, { listPullRequests: async () => [existing] });
  if (variant === "registered") {
    f.put({ id: "original", agent: "ci" }, "completed");
    writeJson(path.join(f.store.records, "task-original.json"), { preparation: { branch: existing.branch } });
  }
  assert.match((await f.scan()).holding, /Open PR limit reached \(1\/1\)/);
  assert.equal(f.calls.length, 0);
});
test("CI rechecks its one-PR cap after preparation and recovers only once capacity opens", async t => {
  let reads = 0;
  const f = setup(t, { listPullRequests: async () => ++reads === 2 ? [pr(1)] : [] });
  assert.match((await f.scan()).holding, /1\/1/);
  assert.equal(f.store.tasks().length, 0);
  assert.equal((await f.scan()).dispatched, 1);
  assert.equal(f.calls[1].prepared, undefined);
});
test("closed CI PRs and unrelated perf PRs do not consume CI capacity", async t => {
  const f = setup(t, { listPullRequests: async () => [
    { ...pr(1), status: "completed" }, { ...pr(2), status: "abandoned" },
    { ...pr(3), branch: "user/calebzearing/new-office-perf-3" },
  ] });
  assert.equal((await f.scan()).dispatched, 1);
});
test("concurrent CI triggers cannot reserve a second assignment", async t => {
  const f = setup(t);
  const results = await Promise.all([1, 2].map(() => withAdmission(f.root, "ci", f.scan, f.workspace)));
  assert.equal(results.filter(result => result.dispatched === 1).length, 1);
  assert.equal(f.store.tasks().length, 1);
});
test("CI recovers a lost receipt and holds a failed task instead of creating replacement work", async t => {
  const f = setup(t), first = await f.scan(), file = path.join(f.runtime, "ci-discovery.json");
  const state = readJson(file); delete state.taskId; writeJson(file, state);
  assert.equal((await f.scan()).taskId, first.taskId);
  assert.equal(f.calls.length, 1);
  const task = f.store.task(first.taskId);
  unlinkSync(task.file); f.put({ ...task, file: undefined }, "failed");
  assert.match((await f.scan()).holding, /CI discovery failed; inspect the original task/);
  assert.equal(f.calls.length, 1);
});
test("CI respects pause and workspace ownership and surfaces remote errors", async t => {
  const f = setup(t);
  f.store.isPaused = () => true;
  assert.match((await f.scan()).holding, /paused/);
  f.store.isPaused = () => false;
  f.put({ id: "other", agent: "perf" }, "in_progress");
  assert.match((await f.scan()).holding, /owns the agent\/workspace/);
  assert.equal(f.calls.length, 0);
  unlinkSync(f.store.task("other").file);
  const scan = createDiscoveryScan("ci", { ...f, listPullRequests: async () => { throw new Error("ADO unavailable"); } });
  await assert.rejects(scan(), /ADO unavailable/);
});
test("CI schema, preview, dispatch, repository policy and updater routing agree on the fixed cap", async t => {
  const f = setup(t), input = { spool_dir: f.root, ci: { workspace_dir: f.workspace }, pr_updater: { enabled: true } };
  const workflow = { id: "bohemia-ci", name: "Bohemia CI speed", kind: "custom", enabled: true,
    workspace: f.workspace, intervalSeconds: 60, ...eventRecipe("ci", { agent: "ci" }) };
  validateWorkflow(workflow);
  assert.equal(operationAvailable({ operation: "dispatch-event" }, "ci"), true);
  const { config } = configure(eventConfiguration(input, workflow), "ci", f.root);
  assert.equal(config.maxOpenPrs, 1);
  assert.equal(config.agentId, "ci");
  assert.equal(configure(input, "pr-updater", f.root).config.agentWorkspaces.ci, f.workspace);
  assert.equal(runnerDetails({ runner: workflow.id }, workflow, f.runtime).repository.mode, "on-demand");
  const preview = await inspectWorkflow(input, workflow);
  assert.equal(preview.inspection[workflow.nodes.at(-1).id].prompt, discoveryPrompt("ci"));
  const pipeline = createEventPipeline(workflow, { store: f.store, runtime: f.runtime,
    verifyPreparation: async prepared => assert.equal(prepared.repoRoot, f.workspace) });
  bindEventQueue(f.queue, pipeline);
  const scan = createDiscoveryScan("ci", { ...f, config, prepare: eventPreparer(pipeline, f.prepare, f.workspace) });
  const result = await scan();
  assert.equal(f.store.task(result.taskId).prompt, discoveryPrompt("ci"));
  assert.equal(f.store.metadata(result.taskId).preparation.ready, true);
  for (const cap of [0, 2, 3]) {
    const over = structuredClone(workflow); over.nodes[0].maxOpenPrs = String(cap);
    assert.throws(() => validateWorkflow(over), /1 to 1/);
    assert.throws(() => createDiscoveryScan("ci", { ...f, config: { ...config, maxOpenPrs: cap } }), /1 to 1/);
  }
  const altered = structuredClone(workflow); altered.nodes.at(-1).prompt += "\nPublish without measurements.";
  assert.throws(() => validateWorkflow(altered), /one-sentence/);
  altered.nodes.at(-1).prompt = "{{event.prompt}}"; altered.nodes.at(-1).agent = "perf";
  assert.throws(() => validateWorkflow(altered), /ci agent/);
});
