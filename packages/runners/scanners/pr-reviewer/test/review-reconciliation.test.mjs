import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelIneligibleReviews,
  cancelRemovedReviewerAssignments,
  cancelStaleRevisionReviews,
  notifyReviewRevisionChanges,
} from "../lib/review-reconciliation.mjs";

test("in-flight source and target updates notify once across scans without cancelling work", async () => {
  const source = "a".repeat(40), next = "b".repeat(40), target = "c".repeat(40), master = "d".repeat(40);
  const tasks = new Map([
    [`101:${source}`, { status: "reviewing", taskId: "active-review", targetCommit: target }],
    [`102:${source}`, { status: "completed", taskId: "finished-review", targetCommit: target }],
  ]);
  const sent = [], notify = async (...args) => { sent.push(args); return true; };
  const detected = [{ id: "101", sourceCommit: next, targetCommit: master },
    { id: "102", sourceCommit: next, targetCommit: master }];
  const first = await notifyReviewRevisionChanges(detected, tasks, {}, notify);
  assert.equal(first.notifications.length, 1);
  assert.equal(sent[0][0], "active-review");
  assert.equal(sent[0][1].sourceChanged, true);
  assert.equal(sent[0][1].targetChanged, true);
  const saved = JSON.parse(JSON.stringify(first.observations));
  assert.equal((await notifyReviewRevisionChanges(detected, tasks, saved, notify)).notifications.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(tasks.get(`101:${source}`).status, "reviewing");
  const targetOnly = await notifyReviewRevisionChanges([{ ...detected[0], targetCommit: target }], tasks, saved, notify);
  assert.equal(targetOnly.notifications[0].sourceChanged, false);
  assert.equal(targetOnly.notifications[0].targetChanged, true);
});

test("target-only changes notify on the first scan using the assigned preparation revision", async () => {
  const source = "a".repeat(40), target = "c".repeat(40);
  const tasks = new Map([[`101:${source}`, { status: "reviewing", taskId: "active-review", targetCommit: target }]]);
  const sent = await notifyReviewRevisionChanges(
    [{ id: "101", sourceCommit: source, targetCommit: "d".repeat(40) }], tasks, {}, async () => true);
  assert.equal(sent.notifications.length, 1);
  assert.equal(sent.notifications[0].sourceChanged, false);
  assert.equal(sent.notifications[0].targetChanged, true);
});

test("notification failures remain retryable without failing the running review or scan", async () => {
  const source = "a".repeat(40), target = "c".repeat(40);
  const tasks = new Map([[`101:${source}`, { status: "reviewing", taskId: "active-review", targetCommit: target }]]);
  const detected = [{ id: "101", sourceCommit: "b".repeat(40), targetCommit: target }];
  const failed = await notifyReviewRevisionChanges(detected, tasks, {}, async () => { throw new Error("Offline"); });
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.observations["active-review"].sourceCommit, source);
  const retried = await notifyReviewRevisionChanges(detected, tasks, failed.observations, async () => true);
  assert.equal(retried.notifications.length, 1);
  assert.equal(tasks.get(`101:${source}`).status, "reviewing");
});

test("queued notifications retain their observation until native delivery is acknowledged", async () => {
  const source = "a".repeat(40), target = "c".repeat(40);
  const tasks = new Map([[`101:${source}`, { status: "reviewing", taskId: "active-review", targetCommit: target }]]);
  const detected = [{ id: "101", sourceCommit: "b".repeat(40), targetCommit: target }];
  const pending = await notifyReviewRevisionChanges(detected, tasks, {}, async () => false);
  assert.equal(pending.notifications.length, 0);
  assert.equal(pending.observations["active-review"].sourceCommit, source);
  const accepted = await notifyReviewRevisionChanges(detected, tasks, pending.observations, async () => true);
  assert.equal(accepted.notifications.length, 1);
  assert.equal(accepted.observations["active-review"].sourceCommit, detected[0].sourceCommit);
});

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

test("unavailable comparison history holds an existing waiting review without cancelling it", async () => {
  const states = await cancelIneligibleReviews({}, [
    { id: "101", sourceCommit: "commit-a", eligible: false, comparisonDeferred: true },
  ], new Map([["101:commit-a", { status: "waiting", taskId: "task:waiting" }]]),
  async () => assert.fail("Uncertain discovery must not withdraw a valid queued review"));
  assert.equal(states.size, 0);
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
