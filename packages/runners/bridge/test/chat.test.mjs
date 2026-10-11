import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./fixtures.mjs";
import { appendEvents } from "../transcript.mjs";
import { monitorConversation } from "../monitor-data.mjs";
import { chatMessages } from "../../monitor/src/chat-model.mjs";

test("streaming deltas, final messages, tools and plans retain one coherent transcript without reasoning", () => {
  const event = (type, data) => ({ type, data, timestamp: "2026-09-23T00:00:00Z" });
  let entries = appendEvents([], [
    event("assistant.message_delta", { content: "Hello " }),
    event("assistant.message_delta", { content: "world" }),
    event("assistant.message", { content: "Hello world" }),
    event("tool.execution_start", { toolCallId: "tool", toolName: "Inspect", arguments: { a: 1 } }),
    event("tool.execution_progress", { toolCallId: "tool", title: "Inspect files" }),
    event("session.plan", { entries: [{ content: "Inspect", status: "in_progress" }] }),
    event("assistant.reasoning", { content: "Private reasoning" }),
  ]);
  entries = appendEvents(entries, [
    event("tool.execution_complete", { toolCallId: "tool", success: true, result: "Done" }),
    event("session.plan", { entries: [{ content: "Inspect", status: "completed" }] }),
  ]);
  assert.equal(entries.filter(e => e.kind === "assistant").length, 1);
  assert.equal(entries[0].text, "Hello world");
  assert.equal(entries.find(e => e.kind === "tool_call").input, '{\n  "a": 1\n}');
  assert.equal(entries.filter(e => e.kind === "plan").length, 1);
  assert.equal(entries.find(e => e.kind === "plan").steps[0].status, "completed");
  const messages = chatMessages(entries, "task");
  assert.equal(messages.length, 3);
  assert.equal(messages[1].content[0].result, "Done");
  assert.doesNotMatch(JSON.stringify(messages), /Private reasoning/);
});

test("orphan tool results and errors remain visible when the matching call is outside the page", () => {
  const messages = chatMessages([{ kind: "tool_result", toolUseId: "prior", content: "Failure", isError: true },
    { kind: "stderr", text: "Provider disconnected" }], "task");
  assert.equal(messages[0].content[0].isError, true);
  assert.equal(messages[0].content[0].result, "Failure");
  assert.match(messages[1].content[0].text, /Provider disconnected/);
});

test("saved usage is exposed without manufacturing zero cost and partial log records wait for newline", t => {
  const f = fixture(t);
  f.put({ id: "one", cost: { input_tokens: 17, total_cost_usd: 0.025 }, turns: 2 }, "completed");
  mkdirSync(path.join(f.root, "logs"));
  const logfile = path.join(f.root, "logs", "one.log");
  const record = JSON.stringify({ type: "assistant.message", data: { content: "Not yet complete" } });
  appendFileSync(logfile, record);
  const before = monitorConversation(f.store, "one");
  assert.equal(before.entries.length, 0);
  appendFileSync(logfile, "\n");
  const after = monitorConversation(f.store, "one");
  assert.equal(after.entries.length, 1);
  assert.equal(after.cursor, Buffer.byteLength(readFileSync(logfile)));
  assert.equal(after.task.cost.input_tokens, 17);
  assert.equal(after.task.cost.output_tokens, undefined);
  assert.equal(after.task.turns, 2);
});
