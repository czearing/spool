import assert from "node:assert/strict";
import fs, { mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { fixture } from "./fixtures.mjs";
import { monitorSnapshot, monitorConversation } from "../monitor-data.mjs";
import { agentReportedFailure, backfillTaskFailures, settleFailureBackfill } from "../task-failure.mjs";

test("legacy blockers reconcile asynchronously without hiding execution failures or changing queues", async t => {
  const f = fixture(t), error = "Local repair verified; publication is blocked.";
  f.put({ id: "blocked", error, session_id: "original-session" }, "failed");
  mkdirSync(path.join(f.root, "logs"));
  const log = path.join(f.root, "logs", "blocked.log");
  const event = (type, data) => JSON.stringify({ type, data }) + "\n";
  const start = event("tool.execution_start", { toolName: "spool-spool_update_task_status",
    toolCallId: "status", arguments: { status: "failed", error } });
  writeFileSync(log, start);
  await backfillTaskFailures(f.root, [f.store.task("blocked")]);
  assert.equal(monitorConversation(f.store, "blocked").task.status, "failed");
  writeFileSync(log, event("tool.execution_complete", { toolCallId: "status", success: false,
    result: { content: "Current task is not running" } }), { flag: "a" });
  await backfillTaskFailures(f.root, [f.store.task("blocked")]);
  assert.equal(monitorConversation(f.store, "blocked").task.error, error);
  writeFileSync(log, start + event("tool.execution_complete", { toolCallId: "status", success: true,
    result: { content: "Task status updated to failed" } }) +
    event("assistant.message", { content: "Later answer ".repeat(30000) }));
  await backfillTaskFailures(f.root, [f.store.task("blocked")]);
  const conversation = monitorConversation(f.store, "blocked");
  assert.equal(conversation.limited, true);
  assert.equal(conversation.task.status, "blocked");
  assert.equal(conversation.task.error, null);
  assert.equal(conversation.task.queueStatus, "failed");
  assert.equal(monitorSnapshot(f.store, []).tasks[0].status, "blocked");
  assert.equal(f.store.task("blocked").status, "failed");
  assert.equal(f.store.task("blocked").error, error);
  f.put({ ...f.store.task("blocked"), error: "Agent exited with code 7" }, "failed");
  await backfillTaskFailures(f.root, [f.store.task("blocked")]);
  assert.equal(monitorConversation(f.store, "blocked").task.error, "Agent exited with code 7");
  writeFileSync(log, event("assistant.message", { content: error }));
  f.put({ ...f.store.task("blocked"), error }, "failed");
  await backfillTaskFailures(f.root, [f.store.task("blocked")]);
  assert.equal(monitorConversation(f.store, "blocked").task.status, "failed");
});

test("successful status receipts distinguish an agent blocker even without an error string", async t => {
  const f = fixture(t);
  f.put({ id: "blocked", error: null }, "failed");
  mkdirSync(path.join(f.root, "logs"));
  const log = path.join(f.root, "logs", "blocked.log");
  const events = [
    { type: "tool.execution_start", data: { toolName: "spool_update_task_status", toolCallId: "status",
      arguments: JSON.stringify({ status: "failed" }) } },
    { type: "tool.execution_complete", data: { toolCallId: "status", success: true,
      result: { isError: true, content: [{ type: "text", text: "Task status updated to failed" }] } } },
  ];
  writeFileSync(log, events.map(event => JSON.stringify(event) + "\n").join(""));
  await backfillTaskFailures(f.root, [f.store.task("blocked")]);
  assert.equal(monitorConversation(f.store, "blocked").task.status, "failed");
  events[1].data.result.isError = false;
  writeFileSync(log, events.map(event => JSON.stringify(event) + "\n").join(""));
  await backfillTaskFailures(f.root, [f.store.task("blocked")]);
  assert.equal(monitorConversation(f.store, "blocked").task.status, "blocked");
  assert.equal(monitorConversation(f.store, "blocked").task.error, null);
});

test("typed failure provenance needs no transcript and cannot hide a different execution error", () => {
  const task = { id: "new", status: "failed", error: "Needs credentials",
    failure_origin: { source: "agent", error: "Needs credentials" } };
  assert.equal(agentReportedFailure(undefined, task), true);
  assert.equal(agentReportedFailure(undefined, { ...task, error: "Process crashed" }), false);
  assert.equal(agentReportedFailure(undefined, { ...task, failure_origin: { source: "execution", error: task.error } }), false);
});
test("backfill accepts a final receipt without a newline and ignores malformed result shapes", async t => {
  const f = fixture(t);
  f.put({ id: "partial", error: null }, "failed");
  mkdirSync(path.join(f.root, "logs"));
  const events = [
    { type: "tool.execution_start", data: { toolName: "spool_update_task_status", toolCallId: "bad", arguments: { status: "failed" } } },
    { type: "tool.execution_complete", data: { toolCallId: "bad", success: true, result: { contents: "not an array" } } },
    { type: "tool.execution_start", data: { toolName: "spool_update_task_status", toolCallId: "good", arguments: { status: "failed" } } },
    { type: "tool.execution_complete", data: { toolCallId: "good", success: true, result: { content: "Task status updated to failed" } } },
  ];
  writeFileSync(path.join(f.root, "logs", "partial.log"), events.map(event => JSON.stringify(event)).join("\n"));
  await backfillTaskFailures(f.root, [f.store.task("partial")]);
  assert.equal(agentReportedFailure(f.root, f.store.task("partial")), true);
});

test("list presentation never synchronously opens or scans historical transcripts", async t => {
  const f = fixture(t);
  f.put({ id: "old", error: "Old failure" }, "failed");
  mkdirSync(path.join(f.root, "logs"));
  writeFileSync(path.join(f.root, "logs", "old.log"), "Not a receipt\n".repeat(100000));
  const task = f.store.task("old");
  const reads = ["openSync", "readFileSync", "readSync"].map(name =>
    t.mock.method(fs, name, () => assert.fail("UI classification must not synchronously read the transcript")));
  syncBuiltinESMExports();
  try {
    for (let index = 0; index < 1000; index++) assert.equal(agentReportedFailure(f.root, task), false);
  } finally { for (const read of reads) read.mock.restore(); syncBuiltinESMExports(); }
  await settleFailureBackfill();
});
