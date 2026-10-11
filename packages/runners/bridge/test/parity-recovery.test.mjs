import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { renameSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { configure } from "../config.mjs";
import { engine, profile } from "../sources.mjs";
import { createUpdater } from "../updater.mjs";
import { resolveSpoolCreator } from "../creator-routing.mjs";
import { SpoolStore, writeJson, readJson, digest } from "../spool-store.mjs";
import { workload } from "../workload.mjs";
import { fixture } from "./fixtures.mjs";
import { PREPARATION_BLOCKED } from "../../packages/bohemia-pr-mcp/src/resume-state.mjs";
import { finishTask, legacyInterrupted } from "./continuation-fixtures.mjs";
import { nativeControls } from "./native-controls-fixture.mjs";

import { creatorFixture } from "./creator-fixture.mjs";

for (const change of ["passed", "pending", "failed CI", "changed head", "failed task", "new generation", "live session", "malformed result", "read failure"]) {
  test(`completed repairs are reverified after CI settles without rerunning agents: ${change}`, async t => {
    const f = creatorFixture(t);
    const { readJobs } = await engine("pr-updater/lib/telemetry.mjs");
    f.pr.mergeStatus = "succeeded";
    let buildResult = "failed", preparations = 0;
    f.ado.listBuilds = async () => [{ id: "fixture-build", name: "Buddy", result: buildResult }];
    const options = { ...f.options, callBohemia: async (_name, args) => {
      preparations++;
      return { ready: true, repoRoot: args.repoRoot, branch: args.branch, commit: f.pr.sourceCommit };
    } };
    const scan = await createUpdater(options);
    assert.equal((await scan()).dispatched, 1);
    const metadata = f.store.metadata("OFF-123");
    assert.equal(metadata.contract.repair.type, "build");
    const task = f.store.task("OFF-123");
    f.pr.sourceCommit = "b".repeat(40);
    task.comments.push({ author: "perf", message: `PR_UPDATE_RESULT: ${JSON.stringify({
      submissionId: metadata.key, fingerprint: metadata.contract.fingerprint, head: f.pr.sourceCommit,
      findings: [], repair: { evidence: "Fixture repair published",
        verification: { command: "fixture check", expected: "pass", actual: "pass" } },
    })}` });
    writeJson(task.file, task);
    renameSync(task.file, path.join(f.store.queues, "completed", `${task.id}.json`));
    buildResult = "inProgress";
    assert.equal((await scan()).dispatched, 0);
    const before = readJobs(f.config.telemetryFile)[0];
    assert.equal(before.outcome, "blocked");
    const proofFile = path.join(f.store.records, `verification-${task.id}.json`);
    assert.equal(readJson(proofFile).ok, false);
    f.ado.listOwnPullRequests = async () => [];
    buildResult = change === "pending" ? "inProgress" : change === "failed CI" ? "failed" : "succeeded";
    if (change === "changed head") f.pr.sourceCommit = "c".repeat(40);
    if (change === "failed task") renameSync(f.store.task(task.id).file, path.join(f.store.queues, "failed", `${task.id}.json`));
    if (change === "new generation") {
      const current = f.store.task(task.id);
      writeJson(current.file, { ...current, runner_metadata: { ...metadata, key: "newer-generation" } });
    }
    if (change === "live session") f.store.liveTasks = tasks => tasks;
    if (change === "malformed result") {
      const completed = f.store.task(task.id);
      completed.comments.push({ author: "perf", message: "PR_UPDATE_RESULT: invalid JSON" });
      writeJson(completed.file, completed);
    }
    if (change === "read failure") f.ado.getPullRequest = async () => { throw new Error("fixture authentication unavailable"); };
    const restarted = await createUpdater(options);
    if (change === "read failure") await assert.rejects(restarted, /authentication unavailable/);
    else assert.equal((await restarted()).dispatched, 0);
    assert.equal(readJson(proofFile).ok, change === "passed");
    const after = readJobs(f.config.telemetryFile)[0];
    assert.equal(after.outcome, change === "passed" ? "completed" : "blocked");
    assert.equal(after.doneAt, before.doneAt);
    assert.equal(after.agentMs, before.agentMs);
    assert.equal(preparations, 1);
    assert.equal(f.store.tasks().length, 1);
    if (change === "passed") {
      const journal = readFileSync(f.config.telemetryFile, "utf8");
      assert.equal((await (await createUpdater(options))()).dispatched, 0);
      assert.equal(readFileSync(f.config.telemetryFile, "utf8"), journal, "verified result is not appended every poll");
    }
  });
}

for (const stage of ["prepared", "queued", "accepted"]) {
  test(`a separate runner process exits at ${stage}; recovery hands off exactly once`, async t => {
    const f = creatorFixture(t), input = path.join(f.root, "crash-fixture.json");
    writeJson(input, { root: f.root, config: f.config, pr: f.pr, workspace: f.workspace });
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./fixtures/crash-handoff.mjs", import.meta.url)), input, stage,
    ], { windowsHide: true, encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 71, `${result.error || ""}\n${result.stderr}\n${result.stdout}`);
    if (stage !== "prepared") nativeControls(t, f.root);
    let preparations = 0;
    const options = { ...f.options, callBohemia: async (_name, args) => {
      preparations++;
      return { ready: true, repoRoot: args.repoRoot, branch: args.branch, commit: f.pr.sourceCommit };
    } };
    const scan = await createUpdater(options);
    assert.equal((await scan()).dispatched, stage === "prepared" ? 1 : 0);
    assert.equal(preparations, stage === "prepared" ? 1 : 0);
    assert.equal(f.store.tasks().length, 1);
    const task = f.store.task("OFF-123");
    assert.equal(task.agent, "perf");
    assert.equal(task.session_id, "original-session");
    assert.equal(task.interaction.messages.length, 1);
    assert.equal(f.store.metadata(task.id).phase, "published");
    assert.equal((await (await createUpdater(options))()).dispatched, 0);
    assert.equal(f.store.tasks().length, 1);
  });
}

for (const change of ["install", "revision", "closed", "draft"]) {
  test(`creator handoff holds ${change} failures without publishing new work`, async t => {
    const f = creatorFixture(t);
    f.ado.getPullRequest = async () => ({ ...f.pr, ...(change === "revision" ? { sourceCommit: "b".repeat(40) }
      : change === "closed" ? { status: "completed" } : change === "draft" ? { isDraft: true } : {}) });
    const scan = await createUpdater({ ...f.options, callBohemia: async (_name, args) => {
      if (change === "install") throw new Error("install failed");
      return { ready: true, branch: args.branch, commit: f.pr.sourceCommit, repoRoot: args.repoRoot };
    } });
    const result = await scan();
    assert.equal(result.dispatched, 0);
    assert.match(result.lastError, change === "install" ? /install failed/ : /revision changed/);
    assert.equal(f.store.task("OFF-123").status, "completed");
  });
}

test("unknown, mismatched and generic-updater ownership never falls back to a guessed agent", async t => {
  const f = creatorFixture(t), file = path.join(f.store.records, "ownership.json");
  const valid = resolveSpoolCreator(f.store, f.pr);
  for (const overrides of [{ agent: "pr-updater" }, { branch: "wrong" }, { verified: false }]) {
    writeJson(file, { version: 1, pullRequests: [{ ...valid, ...overrides }] });
    assert.throws(() => resolveSpoolCreator(f.store, f.pr));
  }
  writeJson(file, { version: 1, pullRequests: [] });
  const scan = await createUpdater({ ...f.options, callBohemia: async () => assert.fail("No guessed preparation") });
  const result = await scan();
  assert.equal(result.dispatched, 0); assert.match(result.holding, /originating work item/);
});

test("future native PR registrations route to their actual originating task without a source import", t => {
  const f = fixture(t), native = path.join(f.store.records, "native-creators");
  mkdirSync(native, { recursive: true });
  f.put({ id: "native-task", agent: "perf" }, "completed");
  const pr = { id: "123", url: "https://dev.azure.com/office/OC/_git/office-bohemia/pullrequest/123", branch: "user/fixture" };
  writeJson(path.join(native, "native-task.json"), { verified: true, originKind: "spool",
    prId: pr.id, prUrl: pr.url, branch: pr.branch, taskId: "native-task", agent: "perf", workspace: f.workspace });
  assert.equal(resolveSpoolCreator(f.store, pr).taskId, "native-task");
  assert.throws(() => resolveSpoolCreator(f.store, { ...pr, branch: "different" }), /does not match/);
});

test("failed creator attempts reuse the shared cooldown across scans and runner restarts", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-16T01:00:00Z") });
  const f = creatorFixture(t);
  const options = { ...f.options, callBohemia: async (_name, args) =>
    ({ ready: true, branch: args.branch, commit: f.pr.sourceCommit, repoRoot: args.repoRoot }) };
  const scan = await createUpdater(options);
  assert.equal((await scan()).dispatched, 1);
  const metadata = f.store.metadata("OFF-123");
  let task = f.store.task("OFF-123");
  finishTask(f, task.id, "failed");
  assert.equal((await scan()).dispatched, 0);
  const restarted = await createUpdater(options);
  const cooldown = f.config.retryMinutes * 60_000;
  assert.ok(cooldown > 0);
  t.mock.timers.tick(cooldown - 1);
  assert.equal((await restarted()).dispatched, 0);
  t.mock.timers.tick(1);
  assert.equal((await restarted()).dispatched, 1);
  task = f.store.task("OFF-123");
  assert.equal(task.agent, "perf");
  assert.equal(task.session_id, "original-session");
  assert.notEqual(f.store.metadata(task.id).key, metadata.key);
  finishTask(f, task.id, "failed");
  assert.equal((await restarted()).dispatched, 0);
  t.mock.timers.tick(cooldown);
  assert.equal((await restarted()).dispatched, 1);
});

