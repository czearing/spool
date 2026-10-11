import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { configure } from "../config.mjs";
import { engine, enginePath, engineRoot } from "../sources.mjs";
import { createUpdater } from "../updater.mjs";
import { assertCreatorWorkspaceReleased, resolveSpoolCreator } from "../creator-routing.mjs";
import { preparationBlocked } from "../../packages/bohemia-pr-mcp/src/resume-state.mjs";
import { digest, writeJson } from "../spool-store.mjs";
import { fixture } from "./fixtures.mjs";
import { finishTask } from "./continuation-fixtures.mjs";

const { readReviewProcedure, reviewPrompt } = await engine("lib/creator-review.mjs");

import { handoff } from "./updater-fixture.mjs";

test("generic continuation reloads the original creator role without replacing its conversation", async t => {
  const f = await handoff(t, "tech-writer", { dispatch: false });
  const file = path.join(f.root, "agents", "tech-writer.md");
  writeFileSync(file, "---\nmodel: fixture\n---\nFix the shared engine, never manually edit prose.\n");
  assert.equal((await f.scan()).dispatched, 1);
  let task = f.store.task(f.taskId), metadata = f.store.metadata(f.taskId);
  assert.equal(task.session_id, f.session);
  assert.match(task.interaction.messages.at(-1).text, /Current creator instructions/);
  assert.match(task.interaction.messages.at(-1).text, /never manually edit prose/);
  assert.doesNotMatch(task.interaction.messages.at(-1).text, /model: fixture/);
  assert.equal(metadata.updatePrompt.roleSource, file);
  assert.equal(metadata.updatePrompt.roleSha256, digest("Fix the shared engine, never manually edit prose."));
  finishTask(f, f.taskId);
  writeFileSync(file, "Use the corrected engine and the regression template.\n");
  f.pr.sourceCommit = "c".repeat(40);
  assert.equal((await f.scan()).dispatched, 1);
  task = f.store.task(f.taskId);
  assert.equal(task.session_id, f.session);
  assert.match(task.interaction.messages.at(-1).text, /corrected engine and the regression template/);
  assert.doesNotMatch(task.interaction.messages.at(-1).text, /never manually edit prose/);
});

test("branch mismatch checks out the PR in the assigned repository without reset or cloning", async t => {
  const calls = [];
  const f = await handoff(t, "tech-writer", { prepare: (args, count) => {
    calls.push(args);
    if (count === 1) throw preparationBlocked("Original branch belongs to another work item", "branch_mismatch");
    return { ready: true, repoRoot: args.repoRoot, branch: args.branch, commit: "b".repeat(40) };
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].reset, false);
  assert.equal(calls[1].reset, false);
  assert.equal(calls[1].mode, "checkout");
  assert.equal(calls[1].seedRoot, undefined);
  assert.equal(calls[1].repoRoot, f.workspace);
  assert.equal(f.task.workspace, f.workspace);
  assert.equal(f.task.session_id, f.session);
  assert.equal(f.task.turns, 12);
  assert.equal(f.metadata.workspaceMigration, undefined);
  assert.equal(resolveSpoolCreator(f.store, f.pr).workspace, f.workspace);
  assert.equal(f.metadata.contract.cwd, f.workspace);
  assert.equal(f.metadata.contract.identifier, f.taskId);
  finishTask(f, f.taskId);
  f.pr.sourceCommit = "c".repeat(40);
  assert.equal((await f.scan()).dispatched, 1);
  assert.equal(calls[2].repoRoot, f.workspace);
  assert.equal(calls[2].mode, "resume");
  assert.equal(f.store.metadata(f.taskId).workspaceMigration, undefined);
  assert.equal(resolveSpoolCreator(f.store, f.pr).workspace, f.workspace);
  assert.equal(existsSync(path.join(path.dirname(f.workspace), "spool-work-items")), false);
});

test("untyped preparation failures never migrate or dispatch the original creator", async t => {
  const f = await handoff(t, "tech-writer", { dispatch: false, prepare: () => {
    throw preparationBlocked("Another Git operation is in progress; original work preserved");
  } });
  assert.equal((await f.scan()).dispatched, 0);
  assert.equal(f.preparations(), 1);
  assert.equal(f.store.task(f.taskId).workspace, f.workspace);
  assert.equal(f.store.task(f.taskId).status, "completed");
});

test("parallel capability never bypasses assigned-agent admission or creates a task checkout", async t => {
  const f = await handoff(t, "software-engineer", { dispatch: false });
  writeJson(path.join(f.root, "controls", "capabilities.json"), { parallelTaskExecutionVersion: 1 });
  f.put({ id: "other-author-session", agent: "software-engineer", session_id: "another-session",
    workspace: path.join(f.root, "other-pr") }, "in_progress");
  assert.equal((await f.scan()).dispatched, 0);
  assert.equal(f.preparations(), 0);
  const other = f.store.task("other-author-session");
  renameSync(other.file, path.join(f.store.queues, "completed", "other-author-session.json"));
  assert.equal((await f.scan()).dispatched, 1);
  const task = f.store.task(f.taskId), metadata = f.store.metadata(f.taskId);
  assert.equal(task.session_id, f.session);
  assert.equal(task.agent, "software-engineer");
  assert.equal(task.independent_workspace, false);
  assert.equal(metadata.independentWorkspace, false);
  assert.equal(task.workspace, f.workspace);
  assert.equal(metadata.workspaceMigration, undefined);
  assert.equal(resolveSpoolCreator(f.store, f.pr).workspace, task.workspace);
  assert.equal(task.prompt, f.brief);
  assert.ok(!task.interaction.messages.at(-1).text.includes(f.brief));
  assert.equal((await f.scan()).dispatched, 0, "The same original session is never dispatched twice");
});

test("a deleted task checkout returns to the assigned agent repository without recreating it", async t => {
  const calls = [];
  const f = await handoff(t, "software-engineer", { dispatch: false, prepare: args => {
    calls.push(args);
    return { ready: true, repoRoot: args.repoRoot, branch: args.branch, commit: "b".repeat(40) };
  } });
  writeJson(path.join(f.root, "controls", "capabilities.json"), { parallelTaskExecutionVersion: 1 });
  const missing = path.join(f.root, "spool-work-items", f.taskId);
  f.config.agentWorkspaces["software-engineer"] = f.workspace;
  f.config.creatorWorkspaceSeed = f.workspace;
  const task = f.store.task(f.taskId);
  writeJson(task.file, { ...task, workspace: missing });
  const registryFile = path.join(f.store.records, "ownership.json");
  const registry = JSON.parse(readFileSync(registryFile, "utf8"));
  registry.pullRequests[0].workspace = missing;
  writeJson(registryFile, registry);
  assert.equal((await f.scan()).dispatched, 1);
  assert.equal(calls[0].seedRoot, undefined);
  assert.equal(calls[0].repoRoot, f.workspace);
  assert.equal(f.store.task(f.taskId).session_id, f.session);
  assert.equal(f.store.metadata(f.taskId).workspaceMigration.previousWorkspace, missing);
  assert.equal(f.store.metadata(f.taskId).workspaceMigration.reason, "assigned_agent_workspace");
  assert.equal(resolveSpoolCreator(f.store, f.pr).workspace, f.workspace);
  assert.equal(existsSync(missing), false);
  finishTask(f, f.taskId);
  f.pr.sourceCommit = "c".repeat(40);
  assert.equal((await f.scan()).dispatched, 1);
  assert.equal(calls[1].repoRoot, f.workspace);
  assert.equal(resolveSpoolCreator(f.store, f.pr).workspace, f.workspace);
  const metadata = f.store.metadata(f.taskId);
  const current = f.store.task(f.taskId);
  writeJson(current.file, { ...current, runner_metadata: { ...metadata, prId: "other" } });
  assert.throws(() => resolveSpoolCreator(f.store, f.pr), /ownership\/workspace is inconsistent/);
});

test("recovery cannot steal a live agent preparation before its submission receipt exists", async t => {
  let release, started;
  const preparing = new Promise(resolve => { started = resolve; });
  const continuePreparation = new Promise(resolve => { release = resolve; });
  const f = await handoff(t, "software-engineer", { dispatch: false, prepare: async args => {
    started();
    await continuePreparation;
    return { ready: true, repoRoot: args.repoRoot, branch: args.branch, commit: "b".repeat(40) };
  } });
  writeJson(path.join(f.root, "controls", "capabilities.json"), { parallelTaskExecutionVersion: 1 });
  const first = f.scan();
  await preparing;
  try {
    assert.equal((await f.scan()).dispatched, 0);
    const { readJobs } = await engine("pr-updater/lib/telemetry.mjs");
    const jobs = readJobs(path.join(f.root, ".runner", "jobs.jsonl"), 10);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].state, "in_progress", "A second scanner must not label live preparation interrupted");
    assert.equal(f.preparations(), 1);
  } finally {
    release();
    assert.equal((await first).dispatched, 1);
  }
});

test("failed in-place branch preparation preserves the original task and never hands off", async t => {
  const f = await handoff(t, "tech-writer", { dispatch: false, prepare: (_args, count) => {
    if (count === 1) throw preparationBlocked("Wrong branch", "branch_mismatch");
    throw new Error("Fixture installation failed");
  } });
  assert.equal((await f.scan()).dispatched, 0);
  assert.equal(f.preparations(), 2);
  assert.equal(f.store.task(f.taskId).workspace, f.workspace);
  assert.equal(f.store.task(f.taskId).session_id, f.session);
  assert.equal(f.store.metadata(f.taskId), null);
});

test("a missing assigned repository is held without seed provisioning", async t => {
  const f = await handoff(t, "perf", { dispatch: false });
  const missing = path.join(f.root, "missing-assigned-repository");
  f.config.agentWorkspaces.perf = missing;
  assert.equal((await f.scan()).dispatched, 0);
  assert.equal(f.preparations(), 0);
  assert.equal(existsSync(missing), false);
  assert.equal(f.store.task(f.taskId).workspace, f.workspace);
});

test("returning to an assigned repository cannot abandon unpublished work", async t => {
  let inspected = null;
  const f = await handoff(t, "perf", { dispatch: false, assertMigrationSafe: workspace => {
    inspected = workspace;
    throw preparationBlocked("Previous checkout contains unpublished work", "unpublished_workspace");
  } });
  const assigned = path.join(f.root, "assigned");
  mkdirSync(assigned);
  f.config.agentWorkspaces.perf = assigned;
  assert.equal((await f.scan()).dispatched, 0);
  assert.equal(inspected, f.workspace);
  assert.equal(f.preparations(), 0);
  assert.equal(f.store.task(f.taskId).workspace, f.workspace);
});

test("migration safety checks actual uncommitted and unpublished Git work", t => {
  const f = fixture(t);
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: f.workspace, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-b", "master");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  assert.throws(() => assertCreatorWorkspaceReleased(f.workspace), /uncommitted or unpublished/);
  git("update-ref", "refs/remotes/origin/master", "HEAD");
  assert.doesNotThrow(() => assertCreatorWorkspaceReleased(f.workspace));
  writeFileSync(path.join(f.workspace, "uncommitted.txt"), "preserve");
  assert.throws(() => assertCreatorWorkspaceReleased(f.workspace), /uncommitted or unpublished/);
  assert.equal(readFileSync(path.join(f.workspace, "uncommitted.txt"), "utf8"), "preserve");
});
