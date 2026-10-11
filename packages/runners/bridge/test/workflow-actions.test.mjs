import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { executeWorkflow } from "../custom-run.mjs";
import { createWorkflowEvents } from "../workflow-events.mjs";
import { executionSettings, validateWorkflow } from "../workflow-schema.mjs";
import { SpoolStore } from "../spool-store.mjs";
import { saveDefinition } from "../workflow-store.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-actions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["agents", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, "agents", "editor.md"), "# Editor");
  const store = new SpoolStore(root, { processes: () => [] });
  const value = { id: "book", name: "Book", kind: "custom", enabled: false, workspace: root, intervalSeconds: 1,
    nodes: [
      { id: "trigger", kind: "file-change", label: "File", path: "chapter.md", position: { x: 0, y: 0 } },
      { id: "action", kind: "agent", label: "Review chapter", agent: "editor", prompt: "Review the changed chapter.", position: { x: 280, y: 0 } },
    ], edges: [{ id: "first", source: "trigger", target: "action" }] };
  return { root, store, value };
}
test("repository actions call canonical tools with explicit workspace and never synthesize shell commands", async t => {
  const { value, store } = fixture(t), calls = [];
  value.nodes[1] = { ...value.nodes[1], kind: "repository", operation: "refresh" };
  const deps = { store, call: async (...args) => { calls.push(args); return { ready: true }; } };
  for (const operation of ["refresh", "setup", "build", "check"]) {
    value.nodes[1].operation = operation;
    await executeWorkflow(value, () => {}, () => assert.fail("No shell commands expected"), deps);
  }
  assert.deepEqual(calls, [
    ["bohemia_prepare", { repoRoot: value.workspace, operation: "master" }],
    ["bohemia_prepare", { repoRoot: value.workspace, operation: "setup" }],
    ["bohemia_build", { repoRoot: value.workspace }],
    ["bohemia_check", { repoRoot: value.workspace }],
  ]);
  value.nodes[1].operation = "delete";
  assert.throws(() => validateWorkflow(value), /repository operation/);
});
test("failed preparation never dispatches an agent; a published event is idempotent", async t => {
  const { value, store } = fixture(t);
  value.nodes.splice(1, 0, { id: "prepare", kind: "repository", operation: "setup", label: "Prepare", position: { x: 100, y: 0 } });
  value.edges = [{ id: "first", source: "trigger", target: "prepare" }, { id: "second", source: "prepare", target: "action" }];
  await assert.rejects(executeWorkflow(value, () => {}, undefined, { store, eventId: "test",
    call: async () => { throw new Error("install failed"); } }), /Prepare.*failed/);
  assert.equal(store.tasks().length, 0);
  value.nodes.splice(1, 1); value.edges = [{ id: "first", source: "trigger", target: "action" }];
  const first = await executeWorkflow(value, () => {}, undefined, { store, eventId: "test" });
  const second = await executeWorkflow(value, () => {}, undefined, { store, eventId: "test" });
  assert.equal(first.taskId, second.taskId);
  assert.equal(store.tasks().length, 1);
  assert.match(store.tasks()[0].prompt, /Read the task back/);
  assert.equal(store.metadata(first.taskId).eventId, "test");
});
test("active tasks and workspace reservations hold repository actions before any tool runs", async t => {
  const { root, store, value } = fixture(t);
  value.nodes[1] = { ...value.nodes[1], kind: "repository", operation: "setup" };
  await store.submit({ key: "occupied", agent: "editor", title: "Existing work", prompt: "Do not interrupt", workspace: root });
  await assert.rejects(executeWorkflow(value, () => {}, undefined, { store,
    call: () => assert.fail("Must not touch an occupied workspace") }), /failed/);
  for (const task of store.tasks()) rmSync(task.file);
  mkdirSync(path.join(root, "controls", "workspace-holds"), { recursive: true });
  writeFileSync(path.join(root, "controls", "workspace-holds", "held.json"),
    JSON.stringify({ taskId: "held", agent: "editor", workspace: root }));
  assert.throws(() => store.assertIdle(null, root), /reserved/);
});
test("file events establish a baseline, persist pending retries and detect create, edit and deletion", async t => {
  const { root, value } = fixture(t), file = path.join(root, "chapter.md");
  let events = createWorkflowEvents(value, root);
  assert.equal(await events.next(), null);
  writeFileSync(file, "first chapter");
  const created = await events.next();
  assert.ok(created.id);
  value.name = "Cosmetic"; value.nodes[0].position.y = 50;
  events = createWorkflowEvents(value, root);
  assert.deepEqual(await events.next(), created, "restarts and cosmetic edits preserve a pending event");
  events.complete(created);
  assert.equal(await events.next(), null);
  writeFileSync(file, "revised chapter");
  const edited = await events.next();
  assert.notEqual(edited.id, created.id);
  events.complete(edited);
  rmSync(file);
  const deleted = await events.next();
  assert.equal(deleted.fingerprint, "missing");
  events.complete(deleted);
  assert.equal(await events.next(), null);
});
test("invalid file triggers fail explicitly; execution keys cover typed settings, not presentation", async t => {
  const { value, root } = fixture(t), before = executionSettings(value);
  value.nodes[1].label = "Changed label";
  assert.deepEqual(executionSettings(value), before);
  value.nodes[1].prompt = "Different instructions";
  assert.notDeepEqual(executionSettings(value), before);
  value.nodes[0].path = root;
  await assert.rejects(createWorkflowEvents(value, root).next(), /not a folder/);
  value.nodes[0].path = "chapter.md";
  const file = path.join(root, "spool-runners.json");
  writeFileSync(file, JSON.stringify({ spool_dir: root }));
  const saved = await saveDefinition(file, root, value, "", true);
  assert.equal(saved.nodes[0].kind, "file-change");
  assert.equal(JSON.parse(readFileSync(file)).custom_runners.book.nodes[1].agent, "editor");
  value.nodes[1].agent = "missing";
  await assert.rejects(saveDefinition(file, root, value, saved.revision), /Unknown Spool agent/);
});
