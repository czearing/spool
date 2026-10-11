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

test("reviewer failures resume the same task and conversation once per failure generation", async t => {
  const f = fixture(t);
  const queue = createSpoolQueue(f.store, { agent: "pr-reviewer", workspace: f.workspace, runner: "pr-reviewer" });
  queue.setPreparation({ ready: true, repoRoot: f.workspace, branch: "review/original", commit: "a".repeat(40) });
  const failedAt = "2026-09-28T00:00:00Z";
  f.put({ id: "original-review", agent: "pr-reviewer", session_id: "original-session",
    updated_at: failedAt, comments: [{ author: "reviewer", message: "Approval already verified" }] }, "failed");
  writeJson(path.join(f.store.records, "task-original-review.json"), { runner: "pr-reviewer", taskId: "original-review" });
  const issue = { assigneeAgentId: "pr-reviewer", description: "Finish notification only" };
  const first = await queue.retryIssue("original-review", issue, failedAt);
  assert.equal(first.id, "original-review");
  assert.equal(f.store.task(first.id).session_id, "original-session");
  assert.equal(f.store.task(first.id).comments[0].message, "Approval already verified");
  const continuation = f.store.task(first.id).interaction.messages.at(-1).text;
  assert.ok(continuation.includes(path.join(f.root, "agents", "pr-reviewer.md")));
  assert.match(continuation, /current instructions supersede older reviewer instructions/);
  assert.match(continuation, /Preserve completed work and verified external actions/);
  assert.equal((await queue.retryIssue("original-review", issue, failedAt)).id, first.id);
  assert.equal(f.store.tasks().length, 1);
  finishTask(f, first.id, "failed");
  const nextFailure = "2026-09-28T00:02:00Z";
  f.put({ ...f.store.task(first.id), updated_at: nextFailure }, "failed");
  await assert.rejects(queue.retryIssue(first.id, issue, "2026-09-28T00:01:00Z"), /changed before continuation/);
  assert.equal((await queue.retryIssue(first.id, issue, nextFailure)).id, first.id);
  assert.equal(f.store.task(first.id).session_id, "original-session");
  finishTask(f, first.id, "failed");
  const interruptedAt = "2026-09-28T00:04:00Z";
  f.put({ ...f.store.task(first.id), updated_at: interruptedAt }, "failed");
  f.store.publish = () => assert.fail("Native continuations must never use runner queue publication");
  await queue.retryIssue(first.id, issue, interruptedAt);
  await queue.recoverPendingRetries();
  assert.equal(f.store.task(first.id).status, "incoming");
  assert.equal(f.store.task(first.id).session_id, "original-session");
  assert.equal((await queue.retryIssue(first.id, issue, interruptedAt)).id, first.id);
});

test("operator pause holds every admission and creation lane without modifying tasks", async t => {
  const f = fixture(t);
  f.put({ id: "old", agent: "tech-writer", session_id: "saved" }, "completed");
  const marker = path.join(f.root, "controls", "paused", "tech-writer");
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, "Paused by operator\n");
  assert.deepEqual(f.store.pausedAgents(), ["tech-writer"]);
  assert.throws(() => f.store.assertIdle("tech-writer", f.workspace), /paused by operator/);
  await assert.rejects(f.store.submit({ key: "paused", agent: "tech-writer", resumeId: "old",
    workspace: f.workspace, title: "No launch", prompt: "No launch" }), /paused by operator/);
  assert.match(await workload(f.store, "tech-writer", 1, f.workspace, {}, [], () => assert.fail("No remote scan needed")), /paused by operator/);
  assert.equal(f.store.task("old").status, "completed");
  assert.equal(f.store.metadata("old"), null);
  f.store.assertIdle("perf", f.workspace);
});

test("submission is durable and idempotent without overwriting daemon-owned task data", async t => {
  const f = fixture(t);
  const input = { key: "same-evidence", agent: "pr-updater", title: "Fix", prompt: "Do work", workspace: f.workspace };
  const first = await f.store.submit(input);
  renameSync(first.file, path.join(f.root, "queues", "in_progress", `${first.id}.json`));
  const before = readFileSync(path.join(f.root, "queues", "in_progress", `${first.id}.json`), "utf8");
  assert.equal((await f.store.submit(input)).id, first.id);
  assert.equal(f.store.tasks().length, 1);
  assert.equal(readFileSync(path.join(f.root, "queues", "in_progress", `${first.id}.json`), "utf8"), before);
});

test("guarded submission preserves its immutable contract across interruption and original-task continuation", async t => {
  const f = fixture(t), acceptance = { kind: "bundle-v2", version: 2, verifier: "fixture", rootMaxBytes: 100 };
  const metadata = { acceptance, preparation: { ready: true, repoRoot: f.workspace, branch: "original", commit: "a".repeat(40) } };
  const options = { key: "guarded", agent: "perf", title: "Measure", prompt: "Verify", workspace: f.workspace, metadata };
  const publish = f.store.publish;
  f.store.publish = () => { throw new Error("fixture interrupted publication"); };
  await assert.rejects(f.store.submit(options), /interrupted/);
  assert.equal(f.store.tasks().length, 0);
  f.store.publish = publish;
  const first = await f.store.submit(options);
  assert.deepEqual(first.acceptance, acceptance);
  const registry = readJson(path.join(f.store.records, "bundle-contracts", `${first.id}.json`));
  assert.equal(registry.taskId, first.id);
  assert.deepEqual(registry.acceptance, acceptance);
  finishTask(f, first.id, "completed", { session_id: "saved" });
  await assert.rejects(f.store.submit({ ...options, key: "changed", resumeId: first.id,
    metadata: { ...metadata, acceptance: { ...acceptance, rootMaxBytes: 200 } } }), /cannot replace/);
  const continued = await f.store.submit({ ...options, key: "continued", resumeId: first.id,
    metadata: { preparation: metadata.preparation } });
  assert.deepEqual(continued.acceptance, acceptance);
  assert.deepEqual(f.store.metadata(first.id).acceptance, acceptance);
});

test("queue location overrides stale status and queued tasks protect workspace ownership", t => {
  const f = fixture(t);
  f.put({ id: "active", status: "incoming" }, "in_progress");
  assert.equal(f.store.task("active").status, "in_progress");
  assert.throws(() => f.store.assertIdle("pr-updater", f.workspace), /owned/);
  assert.throws(() => f.store.assertIdle("perf", f.workspace), /owned/);
});

test("single-task lookup does not enumerate unrelated history and follows queue transitions", t => {
  const f = fixture(t);
  f.put({ id: "target" });
  f.store.tasks = () => { throw new Error("Unexpected queue enumeration"); };
  assert.equal(f.store.task("missing"), null);
  let previous = "incoming";
  for (const state of ["incoming", "in_progress", "completed", "failed"]) {
    if (state !== previous) renameSync(path.join(f.store.queues, previous, "target.json"),
      path.join(f.store.queues, state, "target.json"));
    assert.equal(f.store.task("target").status, state);
    previous = state;
  }
});

test("direct and full reads agree on duplicate priority and reject corrupt target identity", t => {
  const f = fixture(t);
  for (const state of ["failed", "completed", "incoming", "in_progress"]) {
    f.put({ id: "target", status: "stale" }, state);
    assert.deepEqual(f.store.task("target"), f.store.tasks().find(task => task.id === "target"));
    assert.equal(f.store.task("target").status, state);
  }
  const target = path.join(f.store.queues, "in_progress", "target.json");
  writeJson(target, { id: "other", agent: "perf", prompt: "Mismatched task" });
  assert.throws(() => f.store.task("target"), /Invalid Spool task/);
  writeFileSync(target, "{");
  assert.throws(() => f.store.task("target"), /Cannot read/);
});

test("a surviving session protects even a terminal task's workspace", t => {
  const f = fixture(t);
  f.put({ id: "finishing", session_id: "session-fixture" }, "completed");
  const store = new SpoolStore(f.root, { processes: () => [{ Name: "copilot.exe", CommandLine: "--session-id session-fixture" }] });
  assert.throws(() => store.assertIdle("pr-updater", f.workspace), /owned/);
});

test("follow-up preserves task identity, session, cost, comments and workspace", async t => {
  const f = fixture(t);
  f.put({ id: "old", session_id: "original-session", turns: 9, cost: { total_cost_usd: 1.2 },
    comments: [{ author: "agent", message: "Previous result", created_at: "2026-09-14T00:00:00Z" }] }, "completed");
  const task = await f.store.submit({ key: "new-evidence", agent: "pr-updater", resumeId: "old",
    title: "Follow-up", prompt: "New feedback", workspace: f.workspace, metadata: { preparation: f.preparation } });
  assert.equal(task.id, "old");
  assert.equal(task.session_id, "original-session");
  assert.equal(task.turns, 9);
  assert.equal(task.cost.total_cost_usd, 1.2);
  assert.equal(task.comments[0].message, "Previous result");
  assert.equal(task.workspace, f.workspace);
  assert.equal(task.status, "incoming");
  assert.equal(existsSync(path.join(f.root, "queues", "completed", "old.json")), false);
});

test("an unverified legacy payload cannot create a replacement conversation", async t => {
  const f = fixture(t), key = "interrupted";
  const payload = { id: "old", agent: "pr-updater", title: "Resume", prompt: "New", workspace: f.workspace,
    session_id: "saved-session", updated_at: "2026-09-15T00:00:00Z", comments: [], cost: {}, turns: 2 };
  writeJson(path.join(f.store.records, `${digest(key)}.json`), { key, taskId: "old", phase: "pending", payload });
  await assert.rejects(f.store.submit({ key, agent: "pr-updater", resumeId: "old", workspace: f.workspace }), /existing Spool task/);
  assert.equal(f.store.task("old"), null);
});
