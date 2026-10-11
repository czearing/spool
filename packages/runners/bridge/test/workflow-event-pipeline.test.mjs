import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fixture } from "./fixtures.mjs";
import { definition } from "../workflow-store.mjs";
import { createEventPipeline, filteredEvent } from "../workflow-event-pipeline.mjs";
import { eventRecipe, validateWorkflow } from "../../packages/workflow/index.mjs";
import { createSpoolQueue } from "../queue.mjs";
import { listRuns } from "../workflow-runs.mjs";
import { handoff } from "./updater-fixture.mjs";

function setup(t, id = "pr-reviewer") {
  const f = fixture(t);
  const input = { spool_dir: f.root, [id.replaceAll("-", "_")]: { enabled: true, workspace_dir: f.workspace } };
  const workflow = definition(input, id), runtime = path.join(f.root, ".runner");
  const options = { store: f.store, runtime, verifyPreparation: async () => {} };
  return { ...f, workflow, runtime, options };
}
function chain(workflow, nodes) {
  return { ...workflow, nodes, edges: nodes.slice(1).map((node, index) =>
    ({ id: `edge-${index}`, source: nodes[index].id, target: node.id })) };
}
test("an edited composition executes shared actions in edge order, maps data and preserves durable delivery", async t => {
  const f = setup(t), [source, prepare, agent] = f.workflow.nodes, calls = [];
  const action = (id, operation) => ({ id, kind: "repository", operation, label: id, position: { x: 0, y: 0 } });
  const data = { id: "message", kind: "data", label: "Message", body: '{"text":"Configured evidence"}', position: { x: 0, y: 0 } };
  const value = chain(f.workflow, [source, action("refresh", "refresh"), prepare, action("check", "check"), data,
    { ...agent, prompt: "{{event.prompt}}\n{{input.text}}" }]);
  value.nodes.reverse();
  const pipeline = createEventPipeline(value, { ...f.options, call: async (name, args) => {
    calls.push(name === "bohemia_prepare" ? args.operation : name); return { ready: true };
  } });
  const queue = createSpoolQueue(f.store, { agent: "pr-reviewer", workspace: f.workspace, runner: "pr-reviewer" });
  const prepared = await pipeline.prepare({ prId: 42, workspace: f.workspace }, async () => {
    calls.push("prepare"); queue.setPreparation(f.preparation); return f.preparation;
  });
  assert.deepEqual(prepared, f.preparation);
  const task = await pipeline.deliver({ prompt: "Review PR #42 at its exact source revision." }, description => {
    calls.push("deliver"); return queue.createIssue({ title: "Review #42", description, assigneeAgentId: "pr-reviewer" });
  });
  assert.deepEqual(calls, ["master", "prepare", "bohemia_check", "deliver"]);
  assert.match(f.store.task(task.id).prompt, /Configured evidence/);
  assert.match(f.store.task(task.id).prompt, /spool_update_task_status/);
  assert.equal(listRuns(f.runtime)[0].status, "succeeded");
});
test("the same source and actions work in a newly created custom runner", async t => {
  const f = setup(t), value = { ...f.workflow, id: "my-reviewer", kind: "custom" };
  assert.equal(validateWorkflow(value).length, 3);
  const pipeline = createEventPipeline(value, f.options);
  await pipeline.prepare({ prId: 42, workspace: f.workspace }, async () => f.preparation);
  let prompt;
  const receipt = await pipeline.deliver({ prompt: "Exact event context" }, async text => {
    prompt = text; return { id: "fixture-task" };
  });
  assert.equal(prompt, "Exact event context");
  assert.equal(receipt.id, "fixture-task");
});
for (const before of [true, false]) test(`a reusable filter ${before ? "before" : "after"} preparation holds downstream actions`, async t => {
  const f = setup(t), [source, prepare, agent] = f.workflow.nodes;
  const filter = { id: "condition", kind: "filter", label: "Condition", field: "allowed",
    operator: "exists", position: { x: 0, y: 0 } };
  const pipeline = createEventPipeline(chain(f.workflow, before ? [source, filter, prepare, agent] : [source, prepare, filter, agent]), f.options);
  let prepared = false, delivered = false;
  const run = async () => {
    await pipeline.prepare({ prId: 42, workspace: f.workspace }, async () => { prepared = true; return f.preparation; });
    await pipeline.deliver({ prompt: "Event instructions" }, async () => { delivered = true; return { id: "unexpected" }; });
  };
  await assert.rejects(run(), filteredEvent);
  assert.equal(prepared, !before); assert.equal(delivered, false);
  assert.equal(listRuns(f.runtime)[0].status, "filtered");
});
test("successful custom side effects are not repeated when a native event retries", async t => {
  const f = setup(t), [source, prepare, agent] = f.workflow.nodes;
  const extra = { id: "check", kind: "repository", operation: "check", label: "Check", position: { x: 0, y: 0 } };
  const value = chain(f.workflow, [source, extra, prepare, agent]);
  let actions = 0, preparations = 0;
  for (let retry = 0; retry < 2; retry++) {
    const pipeline = createEventPipeline(value, { ...f.options, call: async () => { actions++; return { ready: true }; } });
    await pipeline.prepare({ prId: 42, workspace: f.workspace }, async () => { preparations++; return f.preparation; });
    await pipeline.deliver({ prompt: "Same event" }, async () => ({ id: "durable-task" }));
  }
  assert.equal(actions, 1); assert.equal(preparations, 2);
});
test("uncertain custom side effects are held rather than automatically repeated", async t => {
  const f = setup(t), [source, prepare, agent] = f.workflow.nodes;
  const extra = { id: "check", kind: "repository", operation: "check", label: "Check", position: { x: 0, y: 0 } };
  const value = chain(f.workflow, [source, extra, prepare, agent]);
  let actions = 0;
  for (let retry = 0; retry < 2; retry++) {
    const pipeline = createEventPipeline(value, { ...f.options, call: async () => { actions++; throw new Error("Uncertain response"); } });
    await assert.rejects(pipeline.prepare({ prId: 42, workspace: f.workspace }, async () => f.preparation), /Uncertain response|previous attempt/);
  }
  assert.equal(actions, 1);
});
test("handoff is refused when later actions invalidate the prepared checkout", async t => {
  const f = setup(t);
  const pipeline = createEventPipeline(f.workflow, { ...f.options, verifyPreparation: async () => { throw new Error("Checkout changed"); } });
  await pipeline.prepare({ prId: 42, workspace: f.workspace }, async () => f.preparation);
  await assert.rejects(pipeline.deliver({ prompt: "Event" }, async () => assert.fail("must not deliver")), /Checkout changed/);
});
test("original-creator continuation runs through the shared Agent operation without changing its session", async t => {
  const f = await handoff(t, "software-engineer", { dispatch: false });
  const workflow = { id: "pr-updater", kind: "managed", name: "Updater", enabled: true, intervalSeconds: 60,
    workspace: "", revision: "", ...eventRecipe("pr-updater") };
  workflow.nodes.at(-1).prompt = "{{event.prompt}}\nInclude configured verification evidence.";
  f.config.eventPipeline = createEventPipeline(workflow, { store: f.store, runtime: f.config.runtimeDirectory, verifyPreparation: async () => {} });
  assert.equal((await f.scan()).dispatched, 1);
  const task = f.store.task(f.taskId);
  assert.equal(task.session_id, f.session);
  assert.match(task.interaction.messages.at(-1).text, /Include configured verification evidence/);
  assert.match(task.interaction.messages.at(-1).text, /PR_UPDATE_RESULT_FILE/);
});
test("report events use the same data and repository operation registry", async t => {
  const f = setup(t, "spelling"), pipeline = createEventPipeline(f.workflow, f.options);
  assert.deepEqual(await pipeline.report({ commit: "a".repeat(40), issues: 2 }), {});
  assert.equal(listRuns(f.runtime)[0].status, "succeeded");
});
test("source withdrawal after preparation does not leave a permanently running execution", async t => {
  const f = setup(t), pipeline = createEventPipeline(f.workflow, f.options);
  await pipeline.prepare({ prId: 42, workspace: f.workspace }, async () => f.preparation);
  pipeline.completeScan();
  assert.equal(listRuns(f.runtime)[0].status, "interrupted");
  await pipeline.prepare({ prId: 42, workspace: f.workspace }, async () => f.preparation);
  await pipeline.deliver({ prompt: "Freshly validated" }, async () => ({ id: "task" }));
  pipeline.completeScan();
  assert.equal(listRuns(f.runtime)[0].status, "succeeded");
});
