import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./fixtures.mjs";
import { monitorSnapshot, monitorConversation } from "../monitor-data.mjs";

test("agent-reported blockers are neutral without hiding execution failures or changing queues", t => {
  const f = fixture(t), error = "Local repair verified; publication is blocked.";
  f.put({ id: "blocked", error, session_id: "original-session" }, "failed");
  mkdirSync(path.join(f.root, "logs"));
  const log = path.join(f.root, "logs", "blocked.log");
  const event = (type, data) => JSON.stringify({ type, data }) + "\n";
  const start = event("tool.execution_start", { toolName: "spool-spool_update_task_status",
    toolCallId: "status", arguments: { status: "failed", error } });
  writeFileSync(log, start);
  assert.equal(monitorConversation(f.store, "blocked").task.status, "failed");
  writeFileSync(log, event("tool.execution_complete", { toolCallId: "status", success: false,
    result: { content: "Current task is not running" } }), { flag: "a" });
  assert.equal(monitorConversation(f.store, "blocked").task.error, error);
  writeFileSync(log, start + event("tool.execution_complete", { toolCallId: "status", success: true,
    result: { content: "Task status updated to failed" } }) +
    event("assistant.message", { content: "Later answer ".repeat(30000) }));
  const conversation = monitorConversation(f.store, "blocked");
  assert.equal(conversation.limited, true);
  assert.equal(conversation.task.status, "blocked");
  assert.equal(conversation.task.error, null);
  assert.equal(conversation.task.queueStatus, "failed");
  assert.equal(monitorSnapshot(f.store, []).tasks[0].status, "blocked");
  assert.equal(f.store.task("blocked").status, "failed");
  assert.equal(f.store.task("blocked").error, error);
  f.put({ ...f.store.task("blocked"), error: "Agent exited with code 7" }, "failed");
  assert.equal(monitorConversation(f.store, "blocked").task.error, "Agent exited with code 7");
  writeFileSync(log, event("assistant.message", { content: error }));
  f.put({ ...f.store.task("blocked"), error }, "failed");
  assert.equal(monitorConversation(f.store, "blocked").task.status, "failed");
});

test("successful status receipts distinguish an agent blocker even without an error string", t => {
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
  assert.equal(monitorConversation(f.store, "blocked").task.status, "failed");
  events[1].data.result.isError = false;
  writeFileSync(log, events.map(event => JSON.stringify(event) + "\n").join(""));
  assert.equal(monitorConversation(f.store, "blocked").task.status, "blocked");
  assert.equal(monitorConversation(f.store, "blocked").task.error, null);
});
