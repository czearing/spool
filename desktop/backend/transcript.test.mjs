import assert from "node:assert/strict";
import test from "node:test";
import * as desktop from "./transcript.mjs";
import * as runner from "../../packages/runners/bridge/transcript.mjs";

for (const [name, transcript] of [["desktop", desktop], ["runner", runner]]) {
  test(`${name} retains native input identities without attaching them to assistant replies`, () => {
    const entries = transcript.appendEvents([], [
      { type: "user.message", data: { content: "Repeat", messageId: "first" } },
      { type: "user.message", data: { content: "Repeat", messageId: "second" } },
      { type: "assistant.message", data: { content: "Reply", messageId: "unrelated" } },
    ], "fallback");
    assert.deepEqual(entries.map(entry => entry.messageId), ["first", "second", undefined]);
  });
  test(`${name} single-event assembly preserves streamed messages, tools and plan updates`, () => {
    const event = (type, data) => ({ type, data, timestamp: "now" });
    const previous = Object.freeze([Object.freeze({ kind: "assistant", text: "Earlier", ts: "before", delta: false })]);
    const events = [
      event("assistant.message_delta", { content: "Hello " }),
      event("assistant.message_delta", { content: "world" }),
      event("assistant.message", { content: "Hello world!" }),
      event("tool.execution_start", { toolCallId: "one", toolName: "Read", arguments: { path: "example" } }),
      event("tool.execution_progress", { toolCallId: "one", title: "Read file", arguments: { path: "updated" } }),
      event("session.plan", { entries: [{ content: "Read file", status: "in_progress" }] }),
      event("tool.execution_complete", { toolCallId: "one", success: false, error: "Not available" }),
      event("session.plan", { entries: [{ content: "Read file", status: "completed" }] }),
      event("assistant.reasoning", { content: "PRIVATE" }),
      event("assistant.message_delta", { content: "Finished" }),
      event("session.turn_end", {}),
    ];
    const incremental = [...previous];
    for (const value of events) transcript.appendEvent(incremental, value, "fallback");
    assert.deepEqual(incremental, transcript.appendEvents(previous, events, "fallback"));
    assert.equal(previous.length, 1);
    assert.equal(previous[0].text, "Earlier");
    assert.deepEqual(incremental.map(entry => entry.kind), ["assistant", "assistant", "tool_call", "plan", "tool_result", "assistant"]);
    assert.equal(incremental[1].text, "Hello world!");
    assert.equal(incremental[2].name, "Read file");
    assert.equal(incremental[3].steps[0].status, "completed");
    assert.equal(incremental[4].isError, true);
    assert.equal(incremental[5].delta, false);
    assert.doesNotMatch(JSON.stringify(incremental), /PRIVATE/);
  });
}
