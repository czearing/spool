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

test("interrupted isolated migration restores the original workspace and task before retry", async t => {
  const f = fixture(t), isolated = path.join(f.root, "isolated"), key = "migration-recovery";
  f.put({ id: "original", agent: "tech-writer", session_id: "preserved", prompt: "Original brief" }, "completed");
  legacyInterrupted(f, { key, resumeId: "original", workspace: isolated,
    title: "Follow-up", prompt: "New conflict",
    metadata: { workspaceMigration: { reason: "isolated_pr_workspace", previousWorkspace: f.workspace },
      preparation: { ready: true, branch: "topic", commit: "a".repeat(40), repoRoot: isolated } },
  });
  assert.equal(f.store.task("original"), null);
  assert.equal(f.store.recoverSubmission(key), null);
  const restored = f.store.task("original");
  assert.equal(restored.workspace, f.workspace);
  assert.equal(restored.session_id, "preserved");
  assert.equal(restored.prompt, "Original brief");
  assert.equal(f.store.metadata("original"), null);
  assert.equal(f.store.receipt(key).phase, "interrupted");
});

test("a legacy archive is recovered before native continuation without republishing history", async t => {
  const f = fixture(t);
  f.put({ id: "resumable", session_id: "preserved", comments: [] }, "completed");
  const input = { key: "recovery", agent: "pr-updater", workspace: f.workspace,
    resumeId: "resumable", title: "Follow-up", prompt: "New feedback", metadata: { preparation: f.preparation } };
  legacyInterrupted(f, input);
  assert.equal(f.store.tasks().length, 0);
  f.store.recoverSubmission(input.key);
  const recovered = await f.store.submit(input);
  assert.equal(recovered.session_id, "preserved");
  assert.equal(recovered.interaction.messages.filter(message => message.text === "New feedback").length, 1);
  assert.equal((await f.store.submit(input)).id, recovered.id);
  assert.equal(f.store.tasks().length, 1);
});

for (const change of ["none", "live session", "new generation", "wrong archive", "recovery interrupted"]) {
  test(`interrupted publication restores only its original terminal task: ${change}`, async t => {
    const f = fixture(t), key = "restore-original";
    const oldMetadata = { taskId: "original", key: "previous", preparation: { ready: true, branch: "old" } };
    f.put({ id: "original", agent: "perf", session_id: "preserved", prompt: "Original brief",
      comments: [{ author: "perf", message: "Authored evidence" }] }, "completed");
    writeJson(path.join(f.store.records, "task-original.json"), oldMetadata);
    legacyInterrupted(f, { key, workspace: f.workspace, resumeId: "original", prompt: "Stale revision contract" });
    const receipt = f.store.receipt(key), archive = receipt.previous.archive;
    if (change === "live session") {
      const live = new SpoolStore(f.root, { processes: () => [{ Name: "copilot.exe", CommandLine: "--session-id preserved" }] });
      assert.throws(() => live.recoverSubmission(key), /still alive/);
    } else if (change === "new generation") {
      writeJson(path.join(f.store.records, "task-original.json"), { taskId: "original", key: "newer" });
      assert.throws(() => f.store.recoverSubmission(key), /current task generation/);
    } else if (change === "wrong archive") {
      writeJson(archive, { ...readJson(archive), session_id: "another-session" });
      assert.throws(() => f.store.recoverSubmission(key), /archived original task/);
    } else {
      if (change === "recovery interrupted") {
        renameSync(archive, path.join(f.store.queues, "completed", "original.json"));
        writeJson(path.join(f.store.records, "task-original.json"), oldMetadata);
      }
      assert.equal(f.store.recoverSubmission(key), null);
      const restored = f.store.task("original");
      assert.equal(restored.prompt, "Original brief");
      assert.equal(restored.status, "completed");
      assert.equal(restored.session_id, "preserved");
      assert.equal(restored.comments[0].message, "Authored evidence");
      assert.deepEqual(f.store.metadata("original"), oldMetadata);
      assert.equal(f.store.receipt(key).phase, "interrupted");
      assert.equal(f.store.recoverSubmission(key), null);
    }
    if (!["none", "recovery interrupted"].includes(change)) {
      assert.equal(f.store.task("original"), null);
      assert.ok(existsSync(archive));
      assert.equal(f.store.receipt(key).phase, "pending");
    }
  });
}

test("a daemon update between publication and receipt commit does not replay work", async t => {
  const f = fixture(t), key = "published-before-crash";
  const payload = { id: "pending", agent: "pr-updater", title: "Fix", prompt: "Same",
    workspace: f.workspace, created_at: "2026-09-15T00:00:00Z", updated_at: "2026-09-15T00:00:00Z", comments: [] };
  writeJson(path.join(f.store.records, `${digest(key)}.json`), { key, taskId: "pending", phase: "pending", payload });
  writeJson(path.join(f.store.records, "task-pending.json"), { key, taskId: "pending", phase: "pending", payload });
  f.put({ ...payload, updated_at: "2026-09-15T01:00:00Z", session_id: "daemon-session" }, "in_progress");
  const task = await f.store.submit({ key, agent: "pr-updater", workspace: f.workspace });
  assert.equal(task.session_id, "daemon-session");
  assert.equal(f.store.receipt(key).phase, "published");
  assert.equal(f.store.metadata("pending").phase, "published");
  assert.equal(f.store.tasks().length, 1);
});

test("a committed receipt repairs an interrupted task index without republishing", async t => {
  const f = fixture(t), key = "index-interrupted";
  const task = await f.store.submit({ key, agent: "perf", title: "Fix", prompt: "Work", workspace: f.workspace });
  writeJson(path.join(f.store.records, `task-${task.id}.json`), { ...f.store.receipt(key), phase: "pending" });
  assert.equal(f.store.recoverSubmission(key).task.id, task.id);
  assert.equal(f.store.metadata(task.id).phase, "published");
  assert.equal(f.store.tasks().length, 1);
});

test("withdrawn runner-owned work remains an inspectable cancelled receipt", async t => {
  const f = fixture(t);
  const queue = createSpoolQueue(f.store, { agent: "pr-updater", workspace: f.workspace, runner: "test" });
  queue.setPreparation({ ready: true, repoRoot: f.workspace, branch: "fixture", commit: "a".repeat(40) });
  const issue = { title: "Obsolete", description: "Old revision", assigneeAgentId: "pr-updater", submissionId: "old-revision" };
  const task = await queue.createIssue(issue);
  assert.equal(await queue.cancelIssue(task.id, "Revision changed"), true);
  assert.equal((await queue.getIssue(task.id)).status, "cancelled");
  assert.equal((await queue.listIssues())[0].status, "cancelled");
  assert.equal((await queue.findSubmission(issue.submissionId)).status, "cancelled");
  assert.equal((await queue.createIssue(issue)).id, task.id);
  assert.equal((await queue.createIssue(issue)).status, "cancelled");
  assert.equal(f.store.tasks().length, 0);
});

test("withdrawal interrupted before metadata update still reconciles without losing or relaunching work", async t => {
  const f = fixture(t);
  const queue = createSpoolQueue(f.store, { agent: "pr-updater", workspace: f.workspace, runner: "test" });
  queue.setPreparation({ ready: true, repoRoot: f.workspace, branch: "fixture", commit: "a".repeat(40) });
  const issue = { title: "Obsolete", description: "Old revision", assigneeAgentId: "pr-updater", submissionId: "withdraw-crash" };
  const task = await queue.createIssue(issue);
  const directory = path.join(f.store.queues, ".runner-withdrawn");
  mkdirSync(directory);
  const archive = path.join(directory, `${task.id}.json`);
  renameSync(f.store.task(task.id).file, archive);
  const key = f.store.metadata(task.id).key;
  assert.equal(f.store.metadata(task.id).cancelled, undefined);
  assert.equal(f.store.recoverSubmission(key).task.withdrawn, true);
  assert.equal((await queue.findSubmission(issue.submissionId)).status, "cancelled");
  assert.equal((await queue.createIssue(issue)).status, "cancelled");
  assert.equal(f.store.tasks().length, 0);
  writeJson(archive, { ...readJson(archive), id: "mismatched-task" });
  await assert.rejects(queue.findSubmission(issue.submissionId), /Invalid Spool task/);
});

test("successful publication remains successful while the daemon rewrites its copy", async t => {
  const f = fixture(t);
  const store = new SpoolStore(f.root, { processes: () => [], publish(source, target) {
    linkSync(source, target);
    const active = path.join(f.root, "queues", "in_progress", path.basename(target));
    renameSync(target, active);
    writeFileSync(active, "{");
  } });
  const task = await store.submit({ key: "daemon-race", agent: "pr-updater", title: "Fix", prompt: "Work", workspace: f.workspace });
  assert.ok(task.id);
  assert.equal(store.receipt("daemon-race").phase, "published");
  assert.throws(() => store.tasks(), /Cannot read/);
});

test("task reads tolerate bounded daemon rewrites but still reject persistent corruption", async t => {
  const f = fixture(t), file = path.join(f.root, "rewritten.json");
  writeFileSync(file, "{");
  const ready = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(`
    const { workerData } = require("node:worker_threads");
    const { writeFileSync } = require("node:fs");
    const ready = new Int32Array(workerData.ready);
    Atomics.store(ready, 0, 1); Atomics.notify(ready, 0);
    setTimeout(() => writeFileSync(workerData.file, '{"complete":true}'), 50);
  `, { eval: true, workerData: { file, ready: ready.buffer } });
  const exited = new Promise((resolve, reject) => { worker.once("exit", resolve); worker.once("error", reject); });
  Atomics.wait(ready, 0, 0, 5000);
  assert.deepEqual(readJson(file), { complete: true });
  await exited;
});
