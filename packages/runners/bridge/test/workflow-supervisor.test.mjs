import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { supervise } from "../workflow-supervisor.mjs";
import { saveDefinition } from "../workflow-store.mjs";
import { runnerSnapshot } from "../runner-snapshot.mjs";
import { runnerStates } from "../health.mjs";
import { EventEmitter } from "node:events";
import { eventRecipe } from "../../packages/workflow/index.mjs";

async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
function spoolDirectories(root) {
  for (const folder of ["agents", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    mkdirSync(path.join(root, folder), { recursive: true });
}
for (const kind of ["managed", "custom"]) test(`${kind} integration supervision uses its selected event, not its original identity`, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-event-supervisor-")), file = path.join(root, "spool-runners.json");
  const id = kind === "managed" ? "pr-reviewer" : "custom-review";
  spoolDirectories(root);
  mkdirSync(path.join(root, "runners", id), { recursive: true });
  writeFileSync(path.join(root, "runners", id, "run.mjs"), "");
  const graph = eventRecipe("pr-updater");
  writeFileSync(file, JSON.stringify({ spool_dir: root, ...(kind === "managed"
    ? { pr_reviewer: { enabled: true, workflow: graph } }
    : { custom_runners: { [id]: { id, kind, name: id, enabled: true, workspace: "", intervalSeconds: 60, ...graph } } }) }));
  const supervisor = supervise(file, { node: process.execPath, launch: (executable, _args, options) => {
    assert.equal(executable, process.execPath);
    assert.deepEqual(options.stdio, ["pipe", 2, "inherit"], "runner logs must not enter the desktop protocol");
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => queueMicrotask(() => child.emit("close", 0));
    return child;
  } });
  try { assert.equal(supervisor.running.has(id), true); }
  finally { await supervisor.stop(); rmSync(root, { recursive: true, force: true }); }
});
test("saved custom runners execute, drain before updates, disable, and reload without restarting the supervisor", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-supervisor-")), file = path.join(root, "spool-runners.json");
  spoolDirectories(root);
  mkdirSync(path.join(root, "bridge"));
  writeFileSync(path.join(root, "bridge", "custom-run.mjs"), `export { runCustom } from ${JSON.stringify(new URL("../custom-run.mjs", import.meta.url).href)};`);
  writeFileSync(file, JSON.stringify({ spool_dir: root, node_binary: process.execPath }));
  const supervisor = supervise(file);
  const eventsFile = path.join(root, "events.txt");
  const events = () => existsSync(eventsFile) ? readFileSync(eventsFile, "utf8") : "";
  let value = { id: "isolated-check", name: "Isolated check", kind: "custom", enabled: true, workspace: root,
    intervalSeconds: 3600, nodes: [
      { id: "schedule", kind: "schedule", label: "Schedule", position: { x: 0, y: 0 } },
      { id: "script", kind: "command", label: "Script",
        command: "Add-Content events.txt 'old-start'; Start-Sleep -Seconds 2; Add-Content events.txt 'old-end'",
        position: { x: 300, y: 0 } },
    ], edges: [{ id: "first", source: "schedule", target: "script" }] };
  try {
    value = await saveDefinition(file, root, value, "", true);
    await until(() => events().includes("old-start"), "first saved execution");
    const firstPid = supervisor.running.get(value.id).child.pid;
    value.nodes[1].command = "Add-Content events.txt 'new-start'";
    value = await saveDefinition(file, root, value, value.revision);
    await until(() => events().includes("new-start"), "new configuration execution");
    assert.match(events(), /old-start\s+old-end\s+new-start/);
    assert.notEqual(supervisor.running.get(value.id).child.pid, firstPid);
    const secondPid = supervisor.running.get(value.id).child.pid;
    value.nodes[1].position.y = 80;
    value = await saveDefinition(file, root, { ...value, name: "Renamed check" }, value.revision);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(supervisor.running.get(value.id).child.pid, secondPid, "presentation edits must not rerun commands");
    const [state] = await runnerStates([value.id], path.join(root, "runners"));
    assert.equal(state.connected, true);
    await until(async () => (await runnerStates([value.id], path.join(root, "runners")))[0].healthy, "successful new scan");
    const snapshot = await runnerSnapshot(JSON.parse(readFileSync(file, "utf8")), root, path.join(root, "runners"));
    assert.equal(snapshot.runners[0].name, "Renamed check");
    assert.equal(snapshot.runners[0].repository.mode, "none");
    writeFileSync(file, "{invalid");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(supervisor.running.size, 1, "invalid edits do not kill healthy runners");
    const { revision: _revision, ...persisted } = value;
    writeFileSync(file, JSON.stringify({ spool_dir: root, node_binary: process.execPath, custom_runners: { [value.id]: persisted } }));
    value = await saveDefinition(file, root, { ...value, enabled: false }, value.revision);
    await until(() => !supervisor.running.size, "disabled runner drain");
    assert.equal(events().match(/new-start/g).length, 1);
  } finally { await supervisor.stop(); rmSync(root, { recursive: true, force: true }); }
});
test("a real file-triggered runner waits for an event and persists its baseline across restarts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-file-event-")), file = path.join(root, "spool-runners.json");
  spoolDirectories(root);
  mkdirSync(path.join(root, "bridge"));
  writeFileSync(path.join(root, "bridge", "custom-run.mjs"), `export { runCustom } from ${JSON.stringify(new URL("../custom-run.mjs", import.meta.url).href)};`);
  writeFileSync(file, JSON.stringify({ spool_dir: root, node_binary: process.execPath }));
  let supervisor = supervise(file);
  const observed = path.join(root, "chapter.md"), output = path.join(root, "handled.txt");
  let value = { id: "file-events", name: "File events", kind: "custom", enabled: true, workspace: root, intervalSeconds: 1,
    nodes: [
      { id: "trigger", kind: "file-change", label: "File changed", path: "chapter.md", position: { x: 0, y: 0 } },
      { id: "script", kind: "command", label: "Handle event", command: "Add-Content handled.txt 'handled'", position: { x: 280, y: 0 } },
    ], edges: [{ id: "first", source: "trigger", target: "script" }] };
  try {
    value = await saveDefinition(file, root, value, "", true);
    const state = path.join(root, "runners", value.id, ".runner", "workflow-event.json");
    await until(() => existsSync(state), "initial file baseline");
    assert.equal(existsSync(output), false);
    writeFileSync(observed, "chapter one");
    await until(() => existsSync(output), "first file event");
    await until(() => !JSON.parse(readFileSync(state)).pending, "event acknowledged");
    await supervisor.stop();
    supervisor = supervise(file);
    await until(async () => (await runnerStates([value.id], path.join(root, "runners")))[0].healthy, "restarted file runner");
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.equal(readFileSync(output, "utf8").match(/handled/g).length, 1, "restart must not repeat an acknowledged file event");
    writeFileSync(observed, "chapter two");
    await until(() => readFileSync(output, "utf8").match(/handled/g).length === 2, "second file event");
    value = await saveDefinition(file, root, { ...value, enabled: false }, value.revision);
    await until(() => !supervisor.running.size, "file runner drained");
  } finally { await supervisor.stop(); rmSync(root, { recursive: true, force: true }); }
});
