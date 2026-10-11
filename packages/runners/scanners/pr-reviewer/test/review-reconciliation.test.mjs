import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelIneligibleReviews,
  cancelRemovedReviewerAssignments,
  cancelStaleRevisionReviews,
} from "../lib/review-reconciliation.mjs";

test("withdraws queued work but never kills an in-flight review when a PR becomes ineligible", async () => {
  const cancelled = [];
  const tasks = new Map([
    ["101:commit-a", { status: "reviewing", taskId: "task:reviewing" }],
    ["102:commit-b", { status: "waiting", taskId: "task:waiting" }],
    ["103:commit-c", { status: "completed", taskId: "task:completed" }],
  ]);
  const states = await cancelIneligibleReviews(
    { agentId: "reviewer" },
    [
      { id: "101", sourceCommit: "commit-a", eligible: false },
      { id: "102", sourceCommit: "commit-b", eligible: false },
      { id: "103", sourceCommit: "commit-c", eligible: false },
      { id: "104", sourceCommit: "commit-d", eligible: true },
    ],
    tasks,
    async (_config, taskId) => { cancelled.push(taskId); },
  );

  assert.deepEqual(cancelled, ["task:waiting"]);
  assert.equal(states.has("101:commit-a"), false);
  assert.equal(states.get("102:commit-b"), "cancelled_now");
  assert.equal(states.has("103:commit-c"), false);
});

test("a reviewer's own approval vote cannot cancel the review that cast it", async () => {
  const cancelled = [];
  const states = await cancelIneligibleReviews(
    { agentId: "reviewer" },
    [{ id: "101", sourceCommit: "commit-a", eligible: false, reasons: ["reviewer vote is 10"] }],
    new Map([["101:commit-a", { status: "reviewing", taskId: "task:reviewing" }]]),
    async (_config, taskId) => { cancelled.push(taskId); },
  );

  assert.deepEqual(cancelled, []);
  assert.equal(states.has("101:commit-a"), false);
});

test("reports an already cancelled task without cancelling it again", async () => {
  let calls = 0;
  const states = await cancelIneligibleReviews(
    {},
    [{ id: "101", sourceCommit: "commit-a", eligible: false }],
    new Map([["101:commit-a", { status: "cancelled", taskId: "task:cancelled" }]]),
    async () => { calls += 1; },
  );

  assert.equal(calls, 0);
  assert.equal(states.get("101:commit-a"), "cancelled");
});

test("withdraws queued work for obsolete source revisions without killing an in-flight review", async () => {
  const cancelled = [];
  const states = await cancelStaleRevisionReviews(
    { agentId: "reviewer" },
    [{ id: "101", sourceCommit: "commit-new" }],
    new Map([
      ["101:commit-old", { status: "reviewing", taskId: "task:old-reviewing" }],
      ["101:commit-queued", { status: "waiting", taskId: "task:old-waiting" }],
      ["101:commit-new", { status: "waiting", taskId: "task:current" }],
      ["102:commit-old", { status: "waiting", taskId: "task:other-pr" }],
    ]),
    async (_config, taskId) => { cancelled.push(taskId); },
  );

  assert.deepEqual(cancelled, ["task:old-waiting"]);
  assert.equal(states.has("101:commit-old"), false);
  assert.equal(states.get("101:commit-queued"), "cancelled_now");
  assert.equal(states.has("101:commit-new"), false);
  assert.equal(states.has("102:commit-old"), false);
});

test("withdraws queued work when the reviewer assignment disappears but lets a running review finish", async () => {
  const cancelled = [];
  const states = await cancelRemovedReviewerAssignments(
    { agentId: "reviewer" },
    ["101"],
    new Map([
      ["101:commit-a", { status: "reviewing", taskId: "task:reviewing" }],
      ["101:commit-b", { status: "completed", taskId: "task:completed" }],
      ["101:commit-c", { status: "waiting", taskId: "task:queued" }],
      ["102:commit-a", { status: "waiting", taskId: "task:other-pr" }],
    ]),
    async (_config, taskId) => { cancelled.push(taskId); },
  );
  assert.deepEqual(cancelled, ["task:queued"]);
  assert.equal(states.has("101:commit-a"), false);
  assert.equal(states.get("101:commit-c"), "cancelled_now");
});
