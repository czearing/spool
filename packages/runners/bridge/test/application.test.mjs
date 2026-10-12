import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { startApplicationRunners } from "../application.mjs";
import { writeRunnerJson } from "../../packages/bohemia-agent-tooling/src/index.js";

async function until(check) {
  const deadline = Date.now() + 10000;
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
  const { projects: [missing, healthy], registry, status } = fixture(t);
  rmSync(missing.root, { recursive: true });
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const application = await startApplicationRunners(registry);
  t.after(() => application.stop());
  assert.equal(status(healthy).state, "running");
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /Cannot start runners for project/);
  assert.equal(errors[0][1].code, "ENOENT");
});
