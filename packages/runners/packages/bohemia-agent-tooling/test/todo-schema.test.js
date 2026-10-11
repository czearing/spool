import test from "node:test";
import assert from "node:assert/strict";
import { buildStandardTodoData, readTodoJson } from "../src/todo-schema.js";

test("buildStandardTodoData produces clean structured JSON without prose", () => {
  const data = buildStandardTodoData({
    openTasks: [
      {
        issueId: "issue-1",
        issueIdentifier: "OFF-10",
        metric: "test.metric",
        current: 500,
        target: 100,
        acceptance: 100,
      },
    ],
    transitions: [
      {
        kind: "task_transition",
        transition: "opened",
        issueId: "issue-1",
        current: 500,
      },
    ],
    maxOpenTasks: 3,
  });

  assert.equal(data.version, "1.0.0");
  assert.equal(data.queueCap.open, 1);
  assert.equal(data.queueCap.max, 3);
  assert.equal(data.queueCap.isClosed, false);
  assert.equal(data.queueCap.remainingSlots, 2);
  assert.equal(data.inFlight.length, 1);
  assert.equal(data.inFlight[0].identifier, "OFF-10");
  assert.equal(data.inFlight[0].current, 500);
});

test("buildStandardTodoData flags when queue cap is closed", () => {
  const data = buildStandardTodoData({
    openTasks: [
      { issueId: "1", metric: "m1" },
      { issueId: "2", metric: "m2" },
      { issueId: "3", metric: "m3" },
    ],
    maxOpenTasks: 3,
  });

  assert.equal(data.queueCap.isClosed, true);
  assert.equal(data.queueCap.remainingSlots, 0);
});
