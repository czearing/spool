import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readRunnerConfiguration, runnerEnvironment } from "../config.mjs";
import { run } from "../run.mjs";
import { writeJson } from "../spool-store.mjs";
import { fixture } from "./fixtures.mjs";

test("runner configuration uses the live file before an inline snapshot and entry-relative defaults", t => {
  const root = mkdtempSync(path.join(tmpdir(), "runner-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "override.json"), entry = pathToFileURL(path.join(root, "runners", "probe", "run.mjs"));
  writeFileSync(path.join(root, "spool-runners.json"), '{"source":"default"}');
  const env = { SPOOL_RUNNER_CONFIG: '{"source":"inline"}', SPOOL_RUNNER_CONFIG_FILE: file };
  writeFileSync(file, '{"source":"file"}');
  assert.deepEqual(readRunnerConfiguration(entry, env), { source: "file", ado: {} });
  writeFileSync(file, '{"source":"updated"}');
  assert.deepEqual(readRunnerConfiguration(entry, env), { source: "updated", ado: {} });
  delete env.SPOOL_RUNNER_CONFIG_FILE;
  assert.deepEqual(readRunnerConfiguration(entry, env), { source: "inline", ado: {} });
  delete env.SPOOL_RUNNER_CONFIG;
  assert.deepEqual(readRunnerConfiguration(entry, env), { source: "default", ado: {} });
});

test("configuration files retain the same effective environment overrides as supervisor plans", t => {
  const root = mkdtempSync(path.join(tmpdir(), "runner-config-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "spool-runners.json"), input = {
    spool_dir: "configured-root", ado: { organization: "configured-org", project: "configured-project",
      repository: "configured-repository", creator_id: "preserved-creator" },
  };
  writeFileSync(file, JSON.stringify(input));
  const env = { SPOOL_RUNNER_CONFIG_FILE: file, SPOOL_DIR: root,
    ADO_ORGANIZATION: "effective-org", ADO_PROJECT: "effective-project", ADO_REPOSITORY: "effective-repository" };
  const expected = { spool_dir: root, ado: { organization: env.ADO_ORGANIZATION, project: env.ADO_PROJECT,
    repository: env.ADO_REPOSITORY, creator_id: "preserved-creator" } };
  assert.deepEqual(readRunnerConfiguration(pathToFileURL(path.join(root, "unused.mjs")), env), expected);
  assert.deepEqual(runnerEnvironment(input, env), expected);
  assert.equal(input.ado.project, "configured-project");
  assert.equal(input.spool_dir, "configured-root");
});

test("managed startup honors the same explicit configuration file as custom startup", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "runner-config-startup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "override.json"), entry = pathToFileURL(path.join(root, "runners", "probe", "run.mjs"));
  writeFileSync(file, JSON.stringify({ pr_reviewer: { enabled: false } }));
  const previousFile = process.env.SPOOL_RUNNER_CONFIG_FILE, previousInline = process.env.SPOOL_RUNNER_CONFIG;
  t.after(() => {
    if (previousFile === undefined) delete process.env.SPOOL_RUNNER_CONFIG_FILE;
    else process.env.SPOOL_RUNNER_CONFIG_FILE = previousFile;
    if (previousInline === undefined) delete process.env.SPOOL_RUNNER_CONFIG;
    else process.env.SPOOL_RUNNER_CONFIG = previousInline;
  });
  process.env.SPOOL_RUNNER_CONFIG_FILE = file;
  process.env.SPOOL_RUNNER_CONFIG = "{}";
  await assert.rejects(run("pr-reviewer", entry), /Runner is disabled: pr-reviewer/);
  const snapshot = readRunnerConfiguration(entry);
  writeFileSync(file, JSON.stringify({ pr_reviewer: { enabled: true } }));
  await assert.rejects(run("pr-reviewer", entry, undefined, snapshot), /Runner is disabled: pr-reviewer/);
});

test("shared runner startup does not load unrelated spelling engines", () => {
  const entry = new URL("../run.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { registerHooks } from "node:module";
    registerHooks({ resolve(name, context, next) {
      if (/^(?:typescript|cspell-lib|harper\\.js)(?:\\/|$)/.test(name))
        throw new Error("Unrelated spelling dependency loaded: " + name);
      return next(name, context);
    } });
    await import(${JSON.stringify(entry)});
  `], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test("message publication and runner status do not load repository setup or review implementations", t => {
  const { root, put } = fixture(t, { nativeMessages: false });
  put({ id: "one", agent: "perf",
    session_id: "saved-session", interaction: { phase: "running" },
  }, "in_progress");
  writeJson(path.join(root, "controls", "capabilities.json"), {
    version: 1, interactive: true, updatedAt: new Date().toISOString(),
  });
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { registerHooks } from "node:module";
    import { existsSync } from "node:fs";
    import assert from "node:assert/strict";
    import path from "node:path";
    registerHooks({ resolve(name, context, next) {
      if (/(?:bohemia-agent-tooling\\/src\\/(?:index|branch-setup)\\.js|codespace-reviewer\\.mjs|workflow-workspace\\.mjs|codespaces\\/(?:review|engineering)\\.mjs)$/.test(name))
        throw new Error("Unrelated preparation dependency loaded while sending: " + name);
      return next(name, context);
    } });
    const { SpoolStore } = await import(${JSON.stringify(new URL("../spool-store.mjs", import.meta.url).href)});
    const { createMonitorControls } = await import(${JSON.stringify(new URL("../monitor-controls.mjs", import.meta.url).href)});
    const { runnerSnapshot } = await import(${JSON.stringify(new URL("../runner-snapshot.mjs", import.meta.url).href)});
    const root = ${JSON.stringify(root)}, id = "39d579ee-01d5-49a4-ac0b-40009d3ed957";
    const snapshot = await runnerSnapshot({ spool_dir: root, livesite: { enabled: false } }, root, path.join(root, "runners"));
    assert.equal(snapshot.runners.length, 1);
    assert.equal(snapshot.runners[0].running, false);
    const controls = createMonitorControls(new SpoolStore(root));
    assert.equal(controls.submit({ id, kind: "message", taskId: "one", message: "Continue the original work." }).status, "queued");
    assert.ok(existsSync(path.join(root, "controls", "requests", id + ".json")));
  `], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
