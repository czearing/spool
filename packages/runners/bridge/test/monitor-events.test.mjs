import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./fixtures.mjs";
import { monitorConversation, logWindow } from "../monitor-data.mjs";

test("individual events have stable UTF-8 byte identities across overlapping windows", t => {
  const f = fixture(t); f.put({ id: "chat" }, "in_progress");
  mkdirSync(path.join(f.root, "logs"));
  const lines = Array.from({ length: 180 }, (_, index) => JSON.stringify({ type: "assistant.message", timestamp: "same-time",
    data: { content: `Message ${index} \u00e9 ${"x".repeat(2000)}` } }) + "\r\n");
  const file = path.join(f.root, "logs", "chat.log");
  writeFileSync(file, lines.join(""));
  const latest = monitorConversation(f.store, "chat", null, true);
  assert.equal(latest.raw, true); assert.ok(latest.logId);
  const older = monitorConversation(f.store, "chat", latest.nextBefore, true);
  const all = [...older.entries, ...latest.entries];
  assert.equal(all.length, 180);
  assert.equal(new Set(all.map(entry => entry.id)).size, 180);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) { assert.equal(all[i].offset, offset); offset += Buffer.byteLength(lines[i]); }
  assert.ok(offset > logWindow);
  writeFileSync(file, lines.join("") + lines[0]);
  const next = monitorConversation(f.store, "chat", null, true);
  for (const entry of latest.entries.filter(entry => entry.offset >= next.nextBefore))
    assert.equal(next.entries.find(value => value.offset === entry.offset)?.id, entry.id);
});

test("individual mode retains deltas, detached progress and turn boundaries without reasoning", t => {
  const f = fixture(t); f.put({ id: "chat" }, "in_progress");
  mkdirSync(path.join(f.root, "logs"));
  const event = (type, data) => JSON.stringify({ type, timestamp: "now", data }) + "\n";
  writeFileSync(path.join(f.root, "logs", "chat.log"),
    event("assistant.message_delta", { content: "Hello " }) + event("assistant.message_delta", { content: "world" }) +
    event("tool.execution_progress", { toolCallId: "earlier", title: "Fetching", arguments: { stage: "fetch" } }) +
    event("tool.execution_progress", { toolCallId: "earlier", title: null, arguments: null }) +
    event("assistant.reasoning", { content: "PRIVATE" }) + event("session.turn_end", {}));
  const result = monitorConversation(f.store, "chat", null, true);
  assert.equal(result.entries.length, 5);
  assert.deepEqual(result.entries.map(entry => entry.kind), ["assistant", "assistant", "tool_progress", "tool_progress", "turn_end"]);
  assert.equal(result.entries[3].name, undefined);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  assert.equal(monitorConversation(f.store, "chat").entries[0].text, "Hello world");
});
