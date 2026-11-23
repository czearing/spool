import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync, unlinkSync, linkSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { startApplicationRunners, runMessageControls, startMessageControls } from "../application.mjs";
import { migrateRunnerInstallation } from "../migration.mjs";
import { writeRunnerJson } from "../../packages/bohemia-agent-tooling/src/index.js";
import { readJson, writeJson, SpoolStore } from "../spool-store.mjs";
import { fixture as controlsFixture } from "./fixtures.mjs";
import { createMonitorControls } from "../monitor-controls.mjs";
import { withAdmission } from "../admission.mjs";

async function until(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Application runners did not reach the expected state.");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "spool-application-runners-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = ["broken", "healthy"].map(id => {
    const directory = path.join(root, id), runtime = path.join(directory, ".runner", "automation");
    mkdirSync(runtime, { recursive: true });
    return { id, root: directory, runtime, config: path.join(runtime, "spool-runners.json"),
      service: path.join(runtime, "service.json") };
  });

  const registry = path.join(root, "projects.json");
  const register = values => writeRunnerJson(registry, { version: 1, projects: values });
  register(projects);
  const status = project => JSON.parse(readFileSync(project.service, "utf8"));
  return { projects, registry, register, status };
}

test("message admission recovers an isolated crashed worker and drains its replacement", { timeout: 15000 }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), "spool-message-recovery-"));
  const entry = path.join(root, "worker.mjs"), starts = path.join(root, "starts");
  writeFileSync(entry, `
    import { parentPort, workerData } from "node:worker_threads";
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import path from "node:path";
    const file = path.join(workerData, "starts");
    const count = existsSync(file) ? Number(readFileSync(file, "utf8")) + 1 : 1;
    writeFileSync(file, String(count));
    parentPort.postMessage("ready");
    if (count === 1) setTimeout(() => process.exit(7), 20);
    else parentPort.on("message", () => { writeFileSync(path.join(workerData, "drained"), "yes"); parentPort.close(); });
  `);
  const errors = [];
  const messages = startMessageControls(root, { workerUrl: pathToFileURL(entry), onError: error => errors.push(error) });
  t.after(async () => { await messages.stop(); rmSync(root, { recursive: true, force: true }); });
  await messages.ready;
  await until(() => Number(readFileSync(starts, "utf8")) === 2);
  await until(() => errors.at(-1) === null);
  assert.ok(errors.some(error => error?.message.includes("recovering")));
  await messages.stop();
  assert.equal(readFileSync(path.join(root, "drained"), "utf8"), "yes");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(readFileSync(starts, "utf8"), "2");
});

test("new independent messages wake during another admission and shutdown drains both", { timeout: 10000 }, async t => {
  const f = controlsFixture(t), otherWorkspace = path.join(f.root, "other-workspace");
  mkdirSync(otherWorkspace);
  const controls = createMonitorControls(f.store);
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, statusControl: true, taskControl: true, updatedAt: new Date().toISOString(),
  });
  writeJson(path.join(f.root, "spool.json"), { copilotProviders: Object.fromEntries(
    ["software-engineer", "perf"].map(agent => [agent, {
      command: process.execPath, args: [], workingDirectory: "/workspaces/1JS",
    }])) });
  f.put({ id: "slow", agent: "software-engineer" }, "failed");
  f.put({ id: "fast", agent: "perf", workspace: otherWorkspace }, "failed");
  let release, acquired, scanned;
  const held = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { acquired = resolve; });
  const scanning = new Promise(resolve => { scanned = resolve; });
  const tasks = SpoolStore.prototype.tasks;
  t.mock.method(SpoolStore.prototype, "tasks", function (...args) {
    if (this !== f.store) scanned();
    return tasks.apply(this, args);
  });
  const lock = withAdmission(f.root, "software-engineer", async () => { acquired(); await held; }, f.workspace);
  await ready;
  let service, closing;
  try {
    const slow = { id: randomUUID(), kind: "status", taskId: "slow", status: "in_progress", expectedStatus: "failed" };
    const fast = { ...slow, id: randomUUID(), taskId: "fast" };
    controls.submit(slow);
    service = runMessageControls(f.root);
    await scanning;
    const began = performance.now();
    controls.submit(fast);
    await until(() => controls.receipt(fast.id)?.status === "submitted", 1500);
    t.diagnostic(`Independent arrival admitted in ${Math.round(performance.now() - began)}ms while another agent stayed locked`);
    assert.equal(controls.receipt(slow.id).status, "waiting");
    let stopped = false;
    closing = service.stop().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(stopped, false, "Shutdown must wait for the already-running admission");
    release();
    await lock;
    await closing;
    assert.equal(controls.receipt(slow.id).status, "submitted");
    assert.equal(readdirSync(path.join(f.root, "controls", "requests")).length, 2);
  } finally {
    release();
    await lock;
    await (closing || service?.stop());
  }
});

test("published event bursts cannot postpone an already scheduled message scan", { timeout: 10000 }, async t => {
  const f = controlsFixture(t);
  createMonitorControls(f.store);
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, statusControl: true, taskControl: true, updatedAt: new Date().toISOString(),
  });
  f.put({ id: "noise" }, "failed");
  const file = path.join(f.root, "queues", "failed", "noise.json"), contents = readFileSync(file);
  let scans = 0;
  const tasks = SpoolStore.prototype.tasks;
  t.mock.method(SpoolStore.prototype, "tasks", function (...args) {
    if (this !== f.store) scans++;
    return tasks.apply(this, args);
  });
  const service = runMessageControls(f.root);
  let events;
  try {
    await until(() => scans > 0);
    await new Promise(resolve => setTimeout(resolve, 50));
    const before = scans;
    events = setInterval(() => writeFileSync(file, contents), 5);
    await until(() => scans > before, 500);
  } finally {
    clearInterval(events);
    await service.stop();
  }
});

test("message controls restore notifications after a watched directory is replaced", { timeout: 10000 }, async t => {
  const f = controlsFixture(t);
  createMonitorControls(f.store);
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, statusControl: true, taskControl: true, updatedAt: new Date().toISOString(),
  });
  let scans = 0;
  const tasks = SpoolStore.prototype.tasks;
  t.mock.method(SpoolStore.prototype, "tasks", function (...args) {
    if (this !== f.store) scans++;
    return tasks.apply(this, args);
  });
  const service = runMessageControls(f.root);
  try {
    await until(() => scans > 0);
    await new Promise(resolve => setTimeout(resolve, 50));
    const directory = path.join(f.root, "controls", "manual"), before = scans;
    renameSync(directory, `${directory}-retired`);
    mkdirSync(directory);
    await until(() => scans > before, 1500);
    await new Promise(resolve => setTimeout(resolve, 50));
    const restored = scans;
    writeJson(path.join(directory, `${randomUUID()}.json`), { status: "failed" });
    await until(() => scans > restored, 500);
  } finally { await service.stop(); }
});

test("message controls ignore temporary writes but wake for the published JSON record", { timeout: 10000 }, async t => {
  const f = controlsFixture(t);
  createMonitorControls(f.store);
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, statusControl: true, taskControl: true, updatedAt: new Date().toISOString(),
  });
  let scans = 0;
  const tasks = SpoolStore.prototype.tasks;
  t.mock.method(SpoolStore.prototype, "tasks", function (...args) {
    if (this !== f.store) scans++;
    return tasks.apply(this, args);
  });
  const service = runMessageControls(f.root);
  try {
    await until(() => scans > 0);
    await new Promise(resolve => setTimeout(resolve, 50));
    const before = scans, temporary = path.join(f.root, "queues", "failed", "arrived.json.fixture.tmp");
    writeFileSync(temporary, JSON.stringify({
      id: "arrived", agent: "software-engineer", status: "failed", prompt: "Fixture; never executed.", workspace: f.workspace,
    }));
    writeFileSync(path.join(f.root, "controls", "manual", "noise.json.fixture.tmp"), "{}");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(scans, before, "Unpublished temporary writes must not wake admission");
    renameSync(temporary, path.join(f.root, "queues", "failed", "arrived.json"));
    await until(() => scans > before, 500);
  } finally { await service.stop(); }
});

test("legacy desktop migration preserves conflicting project settings and accepts an existing migration alias", async t => {
  const { projects: [project] } = fixture(t);
  const home = path.join(project.root, "legacy");
  mkdirSync(home);
  const config = path.join(home, "spool-runners.json");
  writeRunnerJson(config, { spool_dir: project.root, pr_updater: { enabled: true } });
  writeRunnerJson(project.config, { spool_dir: project.root, pr_updater: { enabled: false } });
  const original = readFileSync(config, "utf8"), current = readFileSync(project.config, "utf8");
  await assert.rejects(migrateRunnerInstallation(home, config, [project]), /Both legacy and application/);
  assert.equal(readFileSync(config, "utf8"), original);
  assert.equal(readFileSync(project.config, "utf8"), current);
  unlinkSync(config);
  linkSync(project.config, config);
  await migrateRunnerInstallation(home, config, [project]);
  assert.equal(readFileSync(config, "utf8"), current);
});

test("isolates malformed configuration, recovers when repaired, and records shutdown", async t => {
  const { projects: [broken, healthy], registry, status } = fixture(t);
  writeFileSync(broken.config, "{invalid");
  const application = await startApplicationRunners(registry);
  t.after(() => application.stop());
  assert.equal(status(broken).state, "error");
  assert.equal(status(healthy).state, "running");
  const unchanged = statSync(healthy.service).mtimeMs;
  writeRunnerJson(broken.config, { spool_dir: healthy.root, custom_runners: {} });
  await until(() => status(broken).error?.includes("another project"));
  writeRunnerJson(broken.config, { spool_dir: broken.root, custom_runners: {} });
  await until(() => status(broken).state === "running");
  writeRunnerJson(healthy.config, { spool_dir: healthy.root, custom_runners: {} });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(statSync(healthy.service).mtimeMs, unchanged, "unchanged status must not generate more UI events");
  await Promise.all([application.stop(), application.stop()]);
  assert.equal(status(broken).state, "stopped");
  assert.equal(status(healthy).state, "stopped");
});

test("drains removed projects and starts new ones without restarting the application", async t => {
  const { projects: [first, second], registry, register, status } = fixture(t);
  register([first]);
  const application = await startApplicationRunners(registry);
  t.after(() => application.stop());
  register([second]);
  await until(() => {
    try { return status(second).state === "running" && status(first).state === "stopped"; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  });
  register([second, { ...second, root: path.join(second.root, ".") }]);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(status(second).state, "running");
  await application.stop();
  assert.equal(status(second).state, "stopped");
});

test("an unavailable project directory does not prevent healthy runners from starting", async t => {
  const { projects: [missing, healthy], registry, register, status } = fixture(t);
  rmSync(missing.root, { recursive: true });
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const application = await startApplicationRunners(registry);
  t.after(() => application.stop());
  assert.equal(status(healthy).state, "running");
  assert.equal(errors.length, 1, errors.map(args => args.map(value => value?.stack || value).join(" ")).join("\n"));
  assert.match(errors[0][0], /Cannot start runners for project/);
  assert.equal(errors[0][1].code, "ENOENT");
  mkdirSync(missing.root);
  register([missing, healthy]);
  await until(() => {
    try { return status(missing).state === "running"; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  });
  assert.equal(errors.length, 1, "unchanged startup failures must be reported once, without preventing recovery");
});

test("status-file write failures are reported without terminating application-owned runners", async t => {
  const { projects: [blocked, healthy], registry, status } = fixture(t);
  mkdirSync(blocked.service);
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const application = await startApplicationRunners(registry);
  t.after(() => application.stop());
  assert.equal(status(healthy).state, "running");
  assert.ok(errors.some(([message]) => message.includes("Cannot write runner service status")));
  await application.stop();
  assert.equal(status(healthy).state, "stopped");
});

test("native engine startup failures release project ownership and allow a later retry", async t => {
  const { projects: [project], registry, register, status } = fixture(t);
  register([project]);
  t.mock.method(console, "error", () => {});
  const previous = process.env.SPOOL_RUNNER_ENGINE;
  process.env.SPOOL_RUNNER_ENGINE = path.join(project.root, "missing-engine.exe");
  let failed;
  try { failed = await startApplicationRunners(registry); }
  finally {
    if (previous === undefined) delete process.env.SPOOL_RUNNER_ENGINE;
    else process.env.SPOOL_RUNNER_ENGINE = previous;
  }
  await failed.stop();
  assert.equal(status(project).state, "error");
  const recovered = await startApplicationRunners(registry);
  t.after(() => recovered.stop());
  assert.equal(status(project).state, "running");
});

test("desktop message recovery stays off the UI thread and retains workspace admission without an enabled scanner", async t => {
  t.mock.method(SpoolStore.prototype, "tasks", () => {
    throw new Error("Message history must not be read on the desktop event loop");
  });
  const { projects: [project], registry, register } = fixture(t);
  register([project]);
  const agent = "software-engineer", workspace = path.join(project.root, "workspace");
  for (const directory of ["agents", workspace, ...["incoming", "in_progress", "completed", "failed"]
    .map(queue => path.join(project.root, "queues", queue))]) {
    mkdirSync(path.isAbsolute(directory) ? directory : path.join(project.root, directory), { recursive: true });
  }
  writeFileSync(path.join(project.root, "agents", `${agent}.md`), "Fixture agent. Never executed.");
  writeJson(path.join(project.root, "spool.json"), {
    copilotProviders: { [agent]: { command: process.execPath, args: [], workingDirectory: "/workspaces/1JS" } },
  });
  const controls = path.join(project.root, "controls");
  mkdirSync(controls);
  mkdirSync(path.join(controls, "paused"));
  writeFileSync(path.join(controls, "paused", agent), "Pause automation, not direct operator chat");
  writeJson(path.join(controls, "capabilities.json"), { version: 1, interactive: true, statusControl: true,
    taskControl: true, updatedAt: new Date().toISOString() });
  const application = await startApplicationRunners(registry);
  t.after(() => application.stop());
  const id = randomUUID(), session = randomUUID(), lock = path.join(workspace, "repository-mcp.lock");
  const message = { id, text: "How could we measure this?", status: "queued", created_at: new Date().toISOString() };
  writeJson(lock, { pid: process.pid });
  writeJson(path.join(project.root, "queues", "failed", "original.json"), {
    id: "original", agent, title: "Original", prompt: "Original request", workspace, session_id: session,
    status: "failed", provider: null, interaction: { phase: "waiting_preparation", messages: [message],
      chat_return: { status: "completed", error: null } },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  const jobs = path.join(controls, "manual"), requests = path.join(controls, "requests");
  await until(() => readdirSync(jobs).some(name =>
    readJson(path.join(jobs, name))?.detail?.includes("repository MCP operation")));
  assert.equal(readdirSync(requests).length, 0, "Live repository work must not be interrupted");
  unlinkSync(lock);
  await until(() => readdirSync(requests).some(name => name.endsWith(".json")));
  const name = readdirSync(requests).find(name => name.endsWith(".json")), request = readJson(path.join(requests, name));
  assert.equal(request.kind, "status");
  assert.equal(request.taskId, "original");
  assert.equal(request.metadata.dashboardPrepared, true);
  const original = readJson(path.join(project.root, "queues", "failed", "original.json"));
  assert.equal(original.session_id, session);
  assert.equal(readFileSync(path.join(controls, "paused", agent), "utf8"), "Pause automation, not direct operator chat");
  assert.deepEqual(original.interaction.messages, [message], "Resume must not duplicate or rewrite operator input");
  writeJson(path.join(controls, "results", name), { result: { status: "accepted" } });
  await until(() => readdirSync(jobs).length === 0);
  assert.equal(readdirSync(path.join(controls, "workspace-holds")).length, 0);
  await application.stop();
  assert.equal(readdirSync(requests).length, 1);
});
