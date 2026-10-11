import assert from "node:assert/strict";
import test from "node:test";
import {
  queryReviewerTasks,
  queueableReviews,
  reviewAdmission,
  reviewPhase,
  observeReviewRevisions,
  revisionAdmission,
  failedReviewRetry,
  continuationEligibility,
} from "../lib/reviewer-status.mjs";
import { reviewTasksFromIssues } from "../lib/task-source.mjs";

const pr = { id: "7", sourceCommit: "new-source" };

test("admits the first review immediately", () => {
  assert.deepEqual(reviewAdmission(pr, new Map()), { admitted: true, reason: null });
});

test("admits a new revision after a completed review", () => {
  const tasks = new Map([["7:old-source", { status: "completed" }]]);
  assert.deepEqual(reviewAdmission(pr, tasks), {
    admitted: true,
    reason: null,
  });
});

test("keeps an existing current-revision task admitted", () => {
  const tasks = new Map([
    ["7:old-source", { status: "completed" }],
    ["7:new-source", { status: "waiting" }],
  ]);
  assert.deepEqual(reviewAdmission(pr, tasks), { admitted: true, reason: null });
  assert.equal(reviewPhase(pr, tasks), "revision");
});

test("labels the first review as initial", () => {
  assert.equal(reviewPhase(pr, new Map()), "initial");
});

test("holds a pushed revision while an older revision review is active", () => {
  const tasks = new Map([["7:old-source", { status: "reviewing" }]]);
  assert.deepEqual(reviewAdmission(pr, tasks), {
    admitted: false,
    reason: "Waiting for the active review to finish",
  });
});

test("does not republish work the reviewer already holds after a restart", () => {
  const assigned = [
    { id: "7", sourceCommit: "waiting" },
    { id: "8", sourceCommit: "reviewing" },
    { id: "9", sourceCommit: "completed" },
    { id: "10", sourceCommit: "failed" },
    { id: "11", sourceCommit: "new" },
  ];
  const tasks = new Map([
    ["7:waiting", { status: "waiting" }],
    ["8:reviewing", { status: "reviewing" }],
    ["9:completed", { status: "completed" }],
    ["10:failed", { status: "failed" }],
  ]);
  assert.deepEqual(
    queueableReviews(assigned, tasks).map((candidate) => candidate.id),
    ["10", "11"],
  );
});

test("recognizes a task already given to the reviewer as reviewer task history", async () => {
  const tasks = await queryReviewerTasks(
    { agentId: "reviewer" },
    async () => reviewTasksFromIssues([{
      id: "issue-7",
      identifier: "OFF-7",
      assigneeAgentId: "reviewer",
      status: "todo",
      title: "Review Azure DevOps pull request #7: New",
      description: "Source commit: new-source",
      createdAt: "2026-01-01T00:00:00Z",
    }], "reviewer"),
  );
  assert.equal(tasks.get("7:new-source")?.status, "waiting");
});

test("failed reviews retry the same task after cooldown and never block a newer revision permanently", () => {
  const updatedAt = "2026-09-28T00:00:00Z", now = Date.parse(updatedAt);
  const tasks = new Map([["7:new-source", { status: "blocked", taskId: "original", updatedAt }]]);
  assert.equal(reviewAdmission(pr, tasks).admitted, true);
  assert.deepEqual(queueableReviews([pr], tasks), []);
  assert.deepEqual(queueableReviews([pr], tasks, { retry: true, now: now + 59_999 }), []);
  assert.deepEqual(queueableReviews([pr], tasks, { retry: true, now: now + 60_000 }), [pr]);
  assert.deepEqual(failedReviewRetry(pr, tasks, now + 60_000), { retryOf: "original", retryUpdatedAt: updatedAt });
  assert.equal(reviewAdmission({ ...pr, sourceCommit: "another-source" }, tasks).admitted, true);
});

test("an unfinished failed review remains eligible after its vote, but not after draft/closure/removal", () => {
  const tasks = new Map([["7:new-source", { status: "blocked" }]]);
  const detected = [{ ...pr, eligible: false, reasons: ["reviewer vote is 10"] }];
  assert.equal(continuationEligibility({ detected }, tasks, true).eligible[0].preserveExistingVote, true);
  for (const reason of ["draft", "status is completed", "authored by the reviewer", "reviewer vote is missing"]) {
    assert.equal(continuationEligibility({ detected: [{ ...detected[0], reasons: [reason] }] }, tasks, true).eligible.length, 0);
  }
  assert.equal(continuationEligibility({ detected }, new Map(), true).eligible.length, 0);
  tasks.set("7:new-source", { status: "completed" });
  assert.equal(continuationEligibility({ detected }, tasks, true).eligible.length, 0);
});

test("initial review is immediate but a replacement revision must settle", () => {
  const tasks = new Map([["7:old-source", { status: "completed" }]]);
  let observed = observeReviewRevisions([pr], {}, 1_000);
  assert.equal(revisionAdmission(pr, new Map(), observed[pr.id], 1_000).admitted, true);
  assert.equal(revisionAdmission(pr, tasks, observed[pr.id], 1_000).admitted, false);
  observed = observeReviewRevisions([pr], observed, 61_000);
  assert.equal(revisionAdmission(pr, tasks, observed[pr.id], 61_000).admitted, false);
  observed = observeReviewRevisions([pr], observed, 121_000);
  assert.equal(revisionAdmission(pr, tasks, observed[pr.id], 121_000).admitted, true);
});

test("rapid pushes and observation gaps restart the stability window", () => {
  const tasks = new Map([["7:old-source", { status: "completed" }]]);
  const observed = observeReviewRevisions([pr], {}, 1_000);
  const revised = { ...pr, sourceCommit: "newer-source" };
  const pushed = observeReviewRevisions([revised], observed, 121_000);
  assert.equal(revisionAdmission(revised, tasks, pushed[pr.id], 121_000).admitted, false);
  const afterOutage = observeReviewRevisions([pr], observed, 301_000);
  assert.equal(afterOutage[pr.id].firstSeenAt, 301_000);
  assert.deepEqual(observeReviewRevisions([], observed, 301_000), {});
});
