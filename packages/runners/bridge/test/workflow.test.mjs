import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateWorkflow } from "../workflow-schema.mjs";
import { saveDefinition, definition, loadWorkflowConfig } from "../workflow-store.mjs";
import { executeWorkflow } from "../custom-run.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "runner-workflow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "spool-runners.json");
  writeFileSync(file, JSON.stringify({ spool_dir: root, ado: { author_account: "preserve" } }));
  const value = { id: "book-check", name: "Book check", kind: "custom", enabled: false, workspace: root,
    intervalSeconds: 60, revision: "", nodes: [
      { id: "schedule", kind: "schedule", label: "Schedule", position: { x: 0, y: 0 } },
      { id: "script", kind: "command", label: "Check", command: "Write-Output 'safe test'", position: { x: 300, y: 0 } },
    ], edges: [{ id: "first", source: "schedule", target: "script" }] };
  return { root, file, value };
}
test("create and edit persist safely, preserve other settings, and reject stale revisions", async t => {
  const { root, file, value } = fixture(t);
  const saved = await saveDefinition(file, root, value, "", true);
  assert.ok(saved.revision);
  assert.match(readFileSync(path.join(root, "runners", value.id, "run.mjs"), "utf8"), /runCustom/);
  assert.equal(loadWorkflowConfig(file, root).ado.author_account, "preserve");
  const edited = await saveDefinition(file, root, { ...saved, intervalSeconds: 120 }, saved.revision);
  assert.equal(definition(loadWorkflowConfig(file, root), value.id).intervalSeconds, 120);
  assert.notEqual(saved.revision, edited.revision);
  await assert.rejects(saveDefinition(file, root, saved, saved.revision), /changed elsewhere/);
  await assert.rejects(saveDefinition(file, root, value, "", true), /already exists/);
});
test("project ownership, absolute paths, IDs and connected execution graph are enforced", async t => {
  const { root, file, value } = fixture(t);
  const other = path.join(root, "other"); mkdirSync(other);
  await assert.rejects(saveDefinition(file, other, value, "", true), /another project/);
  for (const bad of ["../escape", "constructor", "new"]) assert.throws(() => validateWorkflow({ ...value, id: bad }), /ID/);
  assert.throws(() => validateWorkflow({ ...value, workspace: "relative" }), /absolute/);
  assert.throws(() => validateWorkflow({ ...value, edges: [] }), /sequence/);
  assert.throws(() => validateWorkflow({ ...value, intervalSeconds: 0 }), /interval/);
  assert.throws(() => validateWorkflow({ ...value, nodes: [value.nodes[0], { ...value.nodes[1], command: "" }] }), /command/);
});
test("existing editor entries upgrade to the shared engine without replacing handwritten scripts", async t => {
  const { root, file, value } = fixture(t), entry = path.join(root, "runners", value.id, "run.mjs");
  let saved = await saveDefinition(file, root, value, "", true);
  writeFileSync(entry, `import { runCustom } from "../../bridge/custom-run.mjs";\nawait runCustom(${JSON.stringify(value.id)}, import.meta.url);\n`);
  saved = await saveDefinition(file, root, saved, saved.revision);
  assert.ok(readFileSync(entry, "utf8").includes(new URL("../custom-run.mjs", import.meta.url).href));
  writeFileSync(entry, "// User-owned script");
  await assert.rejects(saveDefinition(file, root, saved, saved.revision), /not editor-managed/);
  assert.equal(readFileSync(entry, "utf8"), "// User-owned script");
});
test("step order follows edges rather than array or canvas positions, failures stop subsequent steps", async t => {
  const { value } = fixture(t);
  value.nodes.push({ ...value.nodes[1], id: "after", command: "after" });
  value.edges.push({ id: "second", source: "script", target: "after" });
  value.nodes.reverse();
  assert.deepEqual(validateWorkflow(value).map(node => node.id), ["schedule", "script", "after"]);
  const commands = [];
  await executeWorkflow(value, () => {}, async (_file, args) => { commands.push(args.at(-1)); return { stdout: "", stderr: "" }; });
  assert.equal(commands.length, 2);
  commands.length = 0;
  await assert.rejects(executeWorkflow(value, () => {}, async (_file, args) => {
    commands.push(args.at(-1)); throw new Error("test failure");
  }), /Check.*failed/);
  assert.equal(commands.length, 1);
});
test("real PowerShell execution runs in the isolated directory and fails on native nonzero exits", async t => {
  const { root, value } = fixture(t);
  value.nodes[1].command = "Set-Content -LiteralPath 'proof.txt' -Value 'isolated'";
  await executeWorkflow(value);
  assert.equal(readFileSync(path.join(root, "proof.txt"), "utf8").trim(), "isolated");
  value.nodes[1].command = "& $env:ComSpec /c 'exit 7'";
  await assert.rejects(executeWorkflow(value), /failed/);
});
