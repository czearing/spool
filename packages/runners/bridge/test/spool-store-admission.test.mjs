import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import path from "node:path";
import test from "node:test";
import { SpoolStore, digest, readJson, writeJson } from "../spool-store.mjs";
import { createSpoolQueue } from "../queue.mjs";
import { withAdmission } from "../admission.mjs";
import { fixture } from "./fixtures.mjs";
import { workload } from "../workload.mjs";
import { finishTask, legacyInterrupted } from "./continuation-fixtures.mjs";

test("malformed queue data and unknown agents fail closed", async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, "queues", "incoming", "broken.json"), "{");
  assert.throws(() => f.store.tasks(), /Cannot read/);
  assert.throws(() => f.store.validateAgent("missing"), /Unknown/);
  assert.throws(() => f.store.task("../escape"), /Invalid/);
});

test("the shared adapter refuses unprepared work and preserves active/imported tasks", async t => {
  const f = fixture(t);
  const queue = createSpoolQueue(f.store, { agent: "pr-updater", workspace: f.workspace, runner: "test" });
  const issue = { title: "Fixture", description: "Task", assigneeAgentId: "pr-updater" };
  await assert.rejects(queue.createIssue(issue), /preparation/);
  queue.setPreparation({ ready: true, branch: "user/fixture", commit: "a".repeat(40), repoRoot: f.workspace });
  const task = await queue.createIssue(issue);
  assert.equal(task.status, "todo");
  const stored = f.store.task(task.id);
  renameSync(stored.file, path.join(f.root, "queues", "in_progress", `${stored.id}.json`));
  assert.equal(await queue.cancelIssue(stored.id, "obsolete"), false);
  assert.equal(f.store.task(stored.id).status, "in_progress");
});

test("two runner processes cannot simultaneously admit the same agent", async t => {
  const f = fixture(t);
  let release, entered = 0;
  const first = withAdmission(f.root, "pr-updater", async () => {
    entered++;
    return new Promise(resolve => { release = resolve; });
  });
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  const second = await withAdmission(f.root, "pr-updater", async () => { entered++; });
  assert.equal(entered, 1);
  assert.match(second.holding, /Another runner/);
  release();
  await first;
});

test("different agents sharing a workspace cannot prepare concurrently", async t => {
  const f = fixture(t);
  let release;
  const first = withAdmission(f.root, "perf", () => new Promise(resolve => { release = resolve; }), f.workspace);
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  const second = await withAdmission(f.root, "tech-writer", () => assert.fail("workspace admitted twice"), f.workspace);
  assert.match(second.holding, /Another runner/);
  release();
  await first;
});

test("task-scoped admission permits parallel sessions of one role while preserving workspace and task locks", async t => {
  const f = fixture(t), other = path.join(f.root, "other");
  let release;
  const first = withAdmission(f.root, "software-engineer", () => new Promise(resolve => { release = resolve; }), f.workspace, "original-a");
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(await withAdmission(f.root, "software-engineer", () => "parallel", other, "original-b"), "parallel");
  assert.match((await withAdmission(f.root, "software-engineer", () => assert.fail("Duplicate task"), other, "original-a")).holding, /Another runner/);
  assert.match((await withAdmission(f.root, "software-engineer", () => assert.fail("Shared workspace"), f.workspace, "original-b")).holding, /Another runner/);
  release();
  await first;
});

test("independent PR continuations preserve distinct sessions and reject duplicate sessions or workspaces", async t => {
  const f = fixture(t);
  for (const [id, session] of [["a", "session-a"], ["b", "session-b"], ["duplicate", "session-a"], ["collision", "session-c"]]) {
    f.put({ id, agent: "software-engineer", session_id: session }, "completed");
  }
  const submit = (id, directory = id) => {
    const workspace = path.join(f.root, directory);
    mkdirSync(workspace, { recursive: true });
    return f.store.submit({ key: `feedback-${id}`, agent: "software-engineer", resumeId: id,
      workspace, title: "Continuation", prompt: "New feedback only", metadata: {
        runner: "pr-updater", independentWorkspace: true,
        workspaceMigration: { reason: "isolated_pr_workspace", previousWorkspace: f.workspace },
        preparation: { ready: true, repoRoot: workspace, branch: "topic", commit: "a".repeat(40) },
        contract: { submissionId: `feedback-${id}`, identifier: id, agent: "software-engineer", cwd: workspace, branch: "topic" },
      } });
  };
  assert.equal((await submit("a")).session_id, "session-a");
  const b = await submit("b");
  assert.equal(b.session_id, "session-b");
  assert.equal(b.independent_workspace, true);
  assert.equal(f.store.tasks().filter(task => task.status === "incoming").length, 2);
  await assert.rejects(submit("duplicate"), /owned/);
  await assert.rejects(submit("collision", "a"), /owned/);
  assert.throws(() => f.store.assertIdle("software-engineer", f.workspace), /owned/);
});

test("migration admission holds both old and isolated workspaces until handoff completes", async t => {
  const f = fixture(t), isolated = path.join(f.root, "isolated");
  let release;
  const first = withAdmission(f.root, "perf", () => new Promise(resolve => { release = resolve; }), [f.workspace, isolated]);
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  const second = await withAdmission(f.root, "tech-writer", () => assert.fail("isolated workspace admitted twice"), isolated);
  assert.match(second.holding, /Another runner/);
  release();
  await first;
  assert.equal(await withAdmission(f.root, "tech-writer", () => "released", isolated), "released");
});

