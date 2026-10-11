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

test("profiles retain reviewer scope, livesite thresholds and one full-coverage updater", t => {
  const f = fixture(t), input = { spool_dir: f.root };
  for (const key of ["pr_reviewer", "pr_updater", "livesite"]) input[key] = { enabled: true, workspace_dir: f.workspace };
  assert.deepEqual(configure(input, "pr-reviewer", f.root).config.scopes, profile("pr-reviewer").scopes);
  assert.equal(configure(input, "pr-reviewer", f.root).config.reviewer, profile("pr-reviewer").reviewer);
  for (const key of ["maxBuilds", "stuckMinutes", "persistentFailureMinutes", "alertCooldownHours"]) {
    assert.equal(configure(input, "livesite", f.root).config[key], profile("livesite")[key]);
  }
  assert.deepEqual(configure(input, "pr-updater", f.root).config.shard, { index: 0, total: 1 });
  for (const name of ["docs", "slop", "pr-updater-2"]) {
    assert.throws(() => configure(input, name, f.root), /Unknown runner/);
  }
  assert.throws(() => configure(input, "perf", f.root), /Runner is disabled/);
  renameSync(path.join(f.root, "agents", "pr-updater.md"), path.join(f.root, "retired-agent.md"));
  input.pr_updater = { enabled: true };
  assert.equal(configure(input, "pr-updater", f.root).workspace, f.root);
});

test("reviewer prepares an exact revision without resetting or merging", async t => {
  const f = fixture(t), { prepareReviewWorkspace } = await engine("pr-reviewer/lib/workspace.mjs");
  const sha = "a".repeat(40);
  await prepareReviewWorkspace({ repoRoot: f.workspace, prId: "123", sourceCommit: sha, call: async (tool, args) => {
    assert.equal(tool, "bohemia_prepare"); assert.equal(args.sourceCommit, sha);
    assert.equal(args.reset, false); assert.equal(args.mergeMaster, false);
    return { ready: true, branch: args.branch, commit: sha, repoRoot: args.repoRoot };
  } });
});

test("updaters derive assigned creator repositories instead of task checkout roots", t => {
  const f = fixture(t);
  const input = { spool_dir: f.root, pr_updater: { enabled: true },
    agent_workspaces: { perf: f.workspace, "tech-writer": f.workspace },
    livesite: { enabled: true, agent: "tech-writer", workspace_dir: f.workspace } };
  const config = configure(input, "pr-updater", f.root).config;
  assert.equal(config.taskWorkspaceRoot, undefined);
  assert.equal(config.agentWorkspaces.perf, f.workspace);
  assert.equal(config.agentWorkspaces["tech-writer"], f.workspace);
  input.livesite.workspace_dir = path.join(f.root, "different");
  assert.throws(() => configure(input, "pr-updater", f.root), /Conflicting assigned workspaces/);
  input.livesite.workspace_dir = f.workspace;
  input.pr_updater.task_workspace_root = path.join(f.root, "unwanted");
  assert.throws(() => configure(input, "pr-updater", f.root), /task_workspace_root is retired/);
});

test("creator handoff resumes the original item, agent, workspace and session after shared setup", async t => {
  const f = creatorFixture(t), events = [];
  const registryFile = path.join(f.store.records, "ownership.json");
  writeJson(registryFile, { ...readJson(registryFile), verificationPrIds: ["999"] });
  f.ado.getPullRequest = async () => { events.push("fresh"); return f.pr; };
  const scan = await createUpdater({ ...f.options, callBohemia: async (name, args) => {
    events.push("prepare");
    assert.equal(name, "bohemia_prepare"); assert.equal(args.repoRoot, f.workspace);
    assert.equal(args.mode, "resume"); assert.equal(args.reset, false);
    assert.equal(args.runSetup, true); assert.equal(args.runBuild, false); assert.equal(args.mergeMaster, true);
    return { ready: true, branch: args.branch, commit: f.pr.sourceCommit, repoRoot: args.repoRoot };
  } });
  assert.equal((await scan()).dispatched, 1);
  assert.deepEqual(events, ["prepare", "fresh"]);
  const task = f.store.task("OFF-123");
  assert.equal(task.agent, "perf"); assert.equal(task.workspace, f.workspace);
  assert.equal(task.session_id, "original-session"); assert.equal(task.turns, 12);
  assert.equal(task.prompt, "Fixture work");
  assert.match(task.interaction.messages.at(-1).text, /PR_UPDATE_RESULT/);
  assert.equal(f.store.tasks().length, 1);
  assert.equal((await scan()).dispatched, 0);
});

test("restart recovers a prepared journal entry without permanently blocking the updater lane", async t => {
  const f = creatorFixture(t), telemetry = await engine("pr-updater/lib/telemetry.mjs");
  const key = `spool-creator:pr-updater:123:conflict-${f.pr.sourceCommit}:0`;
  const at = new Date().toISOString();
  telemetry.jobQueued(f.config.telemetryFile, { jobId: key, prId: f.pr.id, prUrl: f.pr.url,
    trigger: "conflict", reason: "merge conflict", at, agent: "perf" });
  telemetry.jobStarted(f.config.telemetryFile, { jobId: key, at });
  telemetry.jobPrepared(f.config.telemetryFile, { jobId: key, at, branch: f.pr.branch });
  const scan = await createUpdater({ ...f.options, callBohemia: async (_name, args) =>
    ({ ready: true, branch: args.branch, commit: f.pr.sourceCommit, repoRoot: args.repoRoot }) });
  assert.equal((await scan()).dispatched, 1);
  assert.equal(f.store.task("OFF-123").session_id, "original-session");
  assert.equal(f.store.tasks().length, 1);
  assert.equal(telemetry.readJobs(f.config.telemetryFile)[0].error, null);
});

for (const changedHead of [false, true]) test(`normal creator pipeline recovers archive-to-publication failure with fresh head=${changedHead}`, async t => {
  const f = creatorFixture(t);
  const prepare = async (_name, args) =>
    ({ ready: true, branch: args.branch, commit: f.pr.sourceCommit, repoRoot: args.repoRoot });
  const telemetry = await engine("pr-updater/lib/telemetry.mjs");
  const key = `spool-creator:pr-updater:123:conflict-${f.pr.sourceCommit}:0`, at = new Date().toISOString();
  telemetry.jobQueued(f.config.telemetryFile, { jobId: key, prId: f.pr.id, prUrl: f.pr.url, at, agent: "perf" });
  telemetry.jobFailed(f.config.telemetryFile, { jobId: key, at, phase: "dispatch", error: "legacy publication interrupted" });
  legacyInterrupted(f, { key, resumeId: "OFF-123", prompt: "Old feedback",
    metadata: { runner: "pr-updater", contract: { agent: "perf", cwd: f.workspace } } });
  assert.equal(f.store.task("OFF-123"), null);
  if (changedHead) f.pr.sourceCommit = "b".repeat(40);
  const restarted = await createUpdater({ ...f.options, callBohemia: prepare });
  assert.equal((await restarted()).dispatched, 1);
  const task = f.store.task("OFF-123");
  assert.equal(task.agent, "perf");
  assert.equal(task.session_id, "original-session");
  assert.equal(task.turns, 12);
  assert.equal(task.interaction.messages.length, 1);
  assert.equal(f.store.tasks().length, 1);
  assert.equal(f.store.metadata(task.id).contract.head, f.pr.sourceCommit);
});

test("published handoff survives a lost dispatch journal and still receives independent result verification", async t => {
  const f = creatorFixture(t);
  const options = { ...f.options, callBohemia: async (_name, args) =>
    ({ ready: true, branch: args.branch, commit: f.pr.sourceCommit, repoRoot: args.repoRoot }) };
  assert.equal((await (await createUpdater(options))()).dispatched, 1);
  const metadata = f.store.metadata("OFF-123");
  const lines = readFileSync(f.config.telemetryFile, "utf8").trim().split("\n")
    .map(line => JSON.parse(line)).filter(row => row.state !== "dispatched");
  writeFileSync(f.config.telemetryFile, lines.map(row => JSON.stringify(row)).join("\n") + "\n");
  writeJson(f.config.stateFile, { pullRequests: {}, builds: {} });
  const task = f.store.task("OFF-123");
  f.pr.sourceCommit = "b".repeat(40);
  f.pr.mergeStatus = "succeeded";
  task.comments.push({ author: "perf", message: `PR_UPDATE_RESULT: ${JSON.stringify({
    submissionId: metadata.key, fingerprint: metadata.contract.fingerprint, head: f.pr.sourceCommit, findings: [],
    repair: { evidence: "Fixture merged and published", verification: { command: "fixture targeted test", expected: "pass", actual: "pass" } },
  })}`, created_at: new Date().toISOString() });
  writeJson(task.file, task);
  renameSync(task.file, path.join(f.store.queues, "completed", `${task.id}.json`));
  const restarted = await createUpdater({ ...options, callBohemia: async () => assert.fail("Do not prepare or dispatch an already published task") });
  assert.equal((await restarted()).dispatched, 0);
  const proof = readJson(path.join(f.store.records, `verification-${task.id}.json`));
  assert.equal(proof?.ok, true);
  assert.equal(proof.submissionId, metadata.key);
  const { readJobs } = await engine("pr-updater/lib/telemetry.mjs");
  assert.equal(readJobs(f.config.telemetryFile)[0].outcome, "completed");
});

test("a missing dispatched task is an explicit verification failure, not endless healthy waiting", async t => {
  const f = creatorFixture(t);
  const options = { ...f.options, callBohemia: async (_name, args) =>
    ({ ready: true, branch: args.branch, commit: f.pr.sourceCommit, repoRoot: args.repoRoot }) };
  assert.equal((await (await createUpdater(options))()).dispatched, 1);
  const task = f.store.task("OFF-123");
  renameSync(task.file, path.join(f.root, "missing-task-fixture.json"));
  await assert.rejects(await createUpdater(options), /missing its durable task/);
});
