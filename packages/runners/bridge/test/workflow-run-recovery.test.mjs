import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { enqueueRun, listRuns, nextRun, readRun, writeRun } from "../workflow-runs.mjs";
import { saveDefinition } from "../workflow-store.mjs";
import { supervise } from "../workflow-supervisor.mjs";
import { withAdmission } from "../admission.mjs";
import { executeBlock } from "../workflow-blocks.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workflow = { id: "recovery", name: "Recovery", kind: "custom", enabled: true, revision: "", workspace: root,
    intervalSeconds: 3600, nodes: [
      { id: "manual", kind: "manual", label: "Manual", position: { x: 0, y: 0 } },
      { id: "data", kind: "data", label: "Data", body: "{{input}}", position: { x: 224, y: 0 } },
    ], edges: [{ id: "edge", source: "manual", target: "data" }] };
  return { root, workflow };
}
async function until(check) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "Execution did not make progress before the deadline");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
test("concurrent acceptance, interrupted summary writes and retained IDs never replay finished work", async t => {
  const { root, workflow } = fixture(t), id = randomUUID();
  const records = await Promise.all(Array.from({ length: 6 }, () => enqueueRun(workflow, root, { value: 1 }, { id })));
  assert.equal(new Set(records.map(run => run.id)).size, 1);
  assert.equal(listRuns(root).length, 1);
  const summary = path.join(root, "executions", `${id}.summary.json`);
  unlinkSync(summary);
  await enqueueRun(workflow, root, { value: 1 }, { id });
  assert.equal(listRuns(root).length, 1, "retry repairs acceptance interrupted before summary persistence");
  const stale = readFileSync(summary);
  writeRun(root, { ...records[0], status: "succeeded", finishedAt: new Date().toISOString() });
  writeFileSync(summary, stale);
  assert.equal(nextRun(root, workflow), null, "stale queued summary must not replay completed detail");
  assert.equal(listRuns(root)[0].status, "succeeded");
  for (let index = 0; index < 201; index++) {
    const run = await enqueueRun(workflow, root, { index });
    writeRun(root, { ...run, status: "succeeded", finishedAt: new Date().toISOString() });
  }
  assert.equal(listRuns(root).length, 200);
  assert.equal(readRun(root, id).expired, true);
  assert.equal((await enqueueRun(workflow, root, { value: 1 }, { id })).status, "succeeded");
  assert.equal(listRuns(root).length, 200, "expired receipts do not repopulate history");
  await assert.rejects(enqueueRun(workflow, root, {}, { id }), /different input/);
  assert.throws(() => readRun(root, "../outside"), /Invalid execution ID/);
});
test("queue capacity and input/output bounds fail explicitly", async t => {
  const { root, workflow } = fixture(t);
  await assert.rejects(enqueueRun(workflow, root, { text: "x".repeat(65536) }), /at most/);
  for (let index = 0; index < 100; index++) await enqueueRun(workflow, root, index);
  await assert.rejects(enqueueRun(workflow, root, 101), error => error.status === 429);
  await assert.rejects(executeBlock({ kind: "http", url: "https://example.invalid", method: "GET" }, workflow,
    { input: {}, fetch: async () => new Response("x".repeat(60001)) }), /60,000/);
  await assert.rejects(executeBlock({ kind: "http", url: "https://example.invalid", bearerEnv: "SPOOL_MISSING_TEST_TOKEN" },
    workflow, { input: {}, fetch: () => assert.fail("Missing credentials must not send a request") }), /not configured/);
});
test("an idle enabled worker wakes, holds admission without spinning, and drains multiple events sequentially", async t => {
  const { root, workflow } = fixture(t);
  for (const folder of ["agents", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed", "bridge"])
    mkdirSync(path.join(root, folder), { recursive: true });
  workflow.nodes[1] = { ...workflow.nodes[1], kind: "command",
    command: "$data=$env:SPOOL_INPUT|ConvertFrom-Json; Add-Content order.txt \"$($data.order)-start\"; Start-Sleep -Milliseconds 100; Add-Content order.txt \"$($data.order)-end\"; $data|ConvertTo-Json -Compress" };
  const file = path.join(root, "spool-runners.json"), runtime = path.join(root, "runners", workflow.id, ".runner");
  writeFileSync(file, JSON.stringify({ spool_dir: root, node_binary: process.execPath }));
  writeFileSync(path.join(root, "bridge", "custom-run.mjs"),
    `export { runCustom } from ${JSON.stringify(new URL("../custom-run.mjs", import.meta.url).href)};`);
  const saved = await saveDefinition(file, root, workflow, "", true);
  const supervisor = supervise(file);
  let unlock;
  try {
    await until(() => {
      try { return JSON.parse(readFileSync(path.join(runtime, "status.json"))).phase === "ready"; }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    });
    const pid = supervisor.running.get(workflow.id).child.pid;
    let locked;
    const acquired = new Promise(resolve => { locked = resolve; });
    const hold = withAdmission(root, "other-runner", () => new Promise(resolve => { unlock = resolve; locked(); }), root);
    await acquired;
    const first = await enqueueRun(saved, runtime, { order: 1 });
    await until(() => JSON.parse(readFileSync(path.join(runtime, "status.json"))).holding?.includes("Another runner"));
    assert.equal(readRun(runtime, first.id).status, "queued");
    const attempt = JSON.parse(readFileSync(path.join(runtime, "status.json"))).lastAttempt;
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(JSON.parse(readFileSync(path.join(runtime, "status.json"))).lastAttempt, attempt, "no self-waking busy loop");
    unlock({}); await hold;
    const second = await enqueueRun(saved, runtime, { order: 2 });
    const third = await enqueueRun(saved, runtime, { order: 3 });
    await until(() => [first, second, third].every(run => readRun(runtime, run.id)?.status === "succeeded"));
    assert.equal(supervisor.running.get(workflow.id).child.pid, pid, "events wake the existing process");
    assert.deepEqual(readFileSync(path.join(root, "order.txt"), "utf8").trim().split(/\r?\n/),
      ["1-start", "1-end", "2-start", "2-end", "3-start", "3-end"]);
    writeFileSync(path.join(root, "queues", "in_progress", "occupied.json"),
      JSON.stringify({ id: "occupied", agent: "owner", workspace: root, prompt: "Fixture" }));
    const blocked = await enqueueRun(saved, runtime, { order: 4 });
    await until(() => readRun(runtime, blocked.id)?.status === "failed");
    assert.match(readRun(runtime, blocked.id).error, /owned by Spool task/);
    assert.equal(readFileSync(path.join(root, "order.txt"), "utf8").includes("4-start"), false);
  } finally { unlock?.({}); await supervisor.stop(); }
});
