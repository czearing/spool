import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { executeWorkflow } from "../custom-run.mjs";
import { executeBlock } from "../workflow-blocks.mjs";
import { mapJson, readField } from "../workflow-data.mjs";
import { enqueueRun, readRun, nextRun, writeRun } from "../workflow-runs.mjs";
import { workflowRunRequest } from "../workflow-run-api.mjs";
import { saveDefinition } from "../workflow-store.mjs";
import { supervise } from "../workflow-supervisor.mjs";

function fixture(t, actions = []) {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-blocks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nodes = [{ id: "trigger", kind: "manual", label: "Manual" }, ...actions]
    .map((node, index) => ({ ...node, position: { x: index * 224, y: 0 } }));
  return { root, workflow: { id: "blocks", kind: "custom", name: "Blocks", enabled: false, workspace: root,
    intervalSeconds: 3600, revision: "", nodes,
    edges: nodes.slice(1).map((node, i) => ({ id: `edge-${i}`, source: nodes[i].id, target: node.id })) } };
}
test("safe mappings preserve JSON values and reject missing or prototype fields", () => {
  const context = { input: { title: 'quoted " text', enabled: false, items: [1, 2] }, steps: {} };
  assert.deepEqual(mapJson('{"title":"{{input.title}}","items":"{{input.items}}"}', context),
    { title: 'quoted " text', items: [1, 2] });
  assert.equal(mapJson('"{{input.enabled}}"', context), false);
  assert.throws(() => mapJson('{"x":"{{input.missing}}"}', context), /missing/);
  assert.throws(() => readField({}, "constructor.name"), /missing/);
  assert.throws(() => readField({}, "__proto__.polluted"), /missing/);
});
test("data, HTTP and script blocks pass real structured input; failed HTTP never continues", async t => {
  const server = createServer((request, response) => {
    if (request.url === "/failure") { response.writeHead(503); response.end("unavailable"); return; }
    response.setHeader("Content-Type", "application/json"); response.end('{"message":"ready"}');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { workflow } = fixture(t, [
    { id: "http", kind: "http", label: "Fetch", url: `http://127.0.0.1:${server.address().port}/ok`, method: "GET" },
    { id: "map", kind: "data", label: "Map", body: '{"text":"{{input.body.message}}"}' },
    { id: "script", kind: "command", label: "Script", command: "$value = $env:SPOOL_INPUT | ConvertFrom-Json; @{ received = $value.text } | ConvertTo-Json -Compress" },
  ]);
  const steps = [];
  await executeWorkflow(workflow, () => {}, undefined, { input: { external: true }, recordStep: step => steps.push(step) });
  assert.deepEqual(steps.at(-1).output, { received: "ready" });
  assert.deepEqual(steps.at(-1).input, { text: "ready" });
  workflow.nodes[1].url = workflow.nodes[1].url.replace("/ok", "/failure");
  const failed = [];
  await assert.rejects(executeWorkflow(workflow, () => {}, undefined, { recordStep: step => failed.push(step) }), /Fetch.*failed/);
  assert.equal(failed.some(step => step.id === "script"), false);
  assert.match(failed.at(-1).error, /503/);
});
test("filters stop downstream side effects without claiming failure", async t => {
  const { workflow } = fixture(t, [
    { id: "condition", kind: "filter", label: "Only open", field: "status", operator: "equals", compare: "open" },
    { id: "script", kind: "command", label: "Side effect", command: "throw 'must not run'" },
  ]);
  const result = await executeWorkflow(workflow, () => {}, () => assert.fail("Filtered actions must not run"), { input: { status: "closed" } });
  assert.equal(result.filtered, true);
  const output = await executeBlock({ kind: "filter", field: "optional", operator: "exists" }, workflow, { input: {} });
  assert.equal(output.filtered, true);
});
test("JSON null and primitive inputs preserve their types through execution", async t => {
  const { root, workflow } = fixture(t, [{ id: "map", kind: "data", label: "Map", body: "{{input}}" }]);
  for (const input of [null, false, 0, "text"]) {
    const receipt = await workflowRunRequest(workflow, root, "RUN", { revision: "", input });
    const record = readRun(root, receipt.id), steps = [];
    assert.equal(record.input, input);
    await executeWorkflow(workflow, () => {}, undefined, { input: record.input, recordStep: step => steps.push(step) });
    assert.equal(steps.at(-1).input, input);
    assert.equal(steps.at(-1).output, input);
  }
});
test("webhooks authenticate before acceptance and preserve idempotency across restarts", async t => {
  const { root, workflow } = fixture(t, [{ id: "map", kind: "data", label: "Map", body: "{{input}}" }]);
  workflow.enabled = true; workflow.nodes[0] = { ...workflow.nodes[0], kind: "webhook", secretEnv: "SPOOL_TEST_WEBHOOK" };
  process.env.SPOOL_TEST_WEBHOOK = "t".repeat(40);
  t.after(() => delete process.env.SPOOL_TEST_WEBHOOK);
  const id = randomUUID(), input = { executionId: id, input: { title: "hello" }, authorization: `Bearer ${process.env.SPOOL_TEST_WEBHOOK}` };
  await assert.rejects(workflowRunRequest(workflow, root, "WEBHOOK", { ...input, authorization: "Bearer wrong" }), /authentication/);
  const result = await workflowRunRequest(workflow, root, "WEBHOOK", input);
  assert.equal(result.id, id);
  assert.deepEqual(await workflowRunRequest(workflow, root, "WEBHOOK", input), result);
  await assert.rejects(workflowRunRequest(workflow, root, "WEBHOOK", { ...input, input: { other: 1 } }), /different input/);
  assert.deepEqual(nextRun(root, workflow).input, { title: "hello" });
  assert.equal(JSON.stringify(readRun(root, id)).includes(process.env.SPOOL_TEST_WEBHOOK), false);
  await assert.rejects(workflowRunRequest({ ...workflow, enabled: false }, root, "WEBHOOK", input), /not enabled/);
});
test("interrupted and stale accepted runs are held instead of replaying uncertain side effects", async t => {
  const { root, workflow } = fixture(t, [{ id: "map", kind: "data", label: "Map", body: "{{input}}" }]);
  const first = await enqueueRun(workflow, root, {});
  writeRun(root, { ...first, status: "running" });
  assert.equal(nextRun(root, workflow), null);
  assert.equal(readRun(root, first.id).status, "interrupted");
  const second = await enqueueRun(workflow, root, {});
  workflow.nodes[1].body = '{"changed":true}';
  assert.equal(nextRun(root, workflow), null);
  assert.equal(readRun(root, second.id).status, "failed");
});
test("disabled workflows execute manual events through the real supervisor, without enabling a schedule", async t => {
  const { root, workflow } = fixture(t, [{ id: "map", kind: "data", label: "Map", body: '{"answer":"{{input.answer}}"}' }]);
  mkdirSync(path.join(root, "bridge"));
  writeFileSync(path.join(root, "bridge", "custom-run.mjs"), `export { runCustom } from ${JSON.stringify(new URL("../custom-run.mjs", import.meta.url).href)};`);
  const file = path.join(root, "spool-runners.json");
  writeFileSync(file, JSON.stringify({ spool_dir: root, node_binary: process.execPath }));
  const saved = await saveDefinition(file, root, workflow, "", true);
  const supervisor = supervise(file), runtime = path.join(root, "runners", workflow.id, ".runner");
  try {
    assert.equal(supervisor.running.size, 0);
    const queued = await enqueueRun(saved, runtime, { answer: 42 });
    const deadline = Date.now() + 15000;
    while (readRun(runtime, queued.id)?.status !== "succeeded") {
      if (Date.now() > deadline) assert.fail(JSON.stringify(readRun(runtime, queued.id)));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual(readRun(runtime, queued.id).steps[0].output, { answer: 42 });
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(supervisor.running.size, 0);
  } finally { await supervisor.stop(); }
});
