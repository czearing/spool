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

test("supersession is terminal, does not retry the old source, and admits only the settled replacement", () => {
  const tasks = reviewTasksFromIssues([{ id: "old-review", assigneeAgentId: "reviewer", status: "superseded",
    title: "Review Azure DevOps pull request #7: Change", description: "Source commit: old-source" }], "reviewer");
  assert.equal(tasks.get("7:old-source").status, "superseded");
  assert.deepEqual(queueableReviews([{ id: "7", sourceCommit: "old-source" }, pr], tasks, { retry: true }), [pr]);
  assert.equal(failedReviewRetry({ id: "7", sourceCommit: "old-source" }, tasks), null);
  assert.equal(revisionAdmission(pr, tasks, { firstSeenAt: 0 }, 119_999, 120_000).admitted, false);
  assert.equal(revisionAdmission(pr, tasks, { firstSeenAt: 0 }, 120_000, 120_000).admitted, true);
  assert.equal(reviewPhase(pr, tasks), "initial", "Supersession is not a completed review");
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
test("an ended blocked review does not automatically retry its unchanged revision", () => {
  const updatedAt = "2026-09-28T00:00:00Z";
  const tasks = new Map([["7:new-source", {
    status: "blocked", taskId: "original", updatedAt, executionPhase: "ended",
  }]]);
  const now = Date.parse(updatedAt) + 86400000;
  assert.equal(failedReviewRetry(pr, tasks, now), null);
  assert.deepEqual(queueableReviews([pr], tasks, { retry: true, now }), []);
  const pushed = { ...pr, sourceCommit: "another-source" };
  assert.deepEqual(queueableReviews([pushed], tasks, { retry: true, now }), [pushed]);
});

test("explicit queued operator input resumes only its original review after safe preparation", () => {
  const updatedAt = "2026-09-28T00:00:00Z", now = Date.parse(updatedAt);
  const issue = { id: "original", assigneeAgentId: "reviewer", status: "failed",
    title: "Review Azure DevOps pull request #7: Original",
    description: "Source commit: new-source", updatedAt, pendingOperatorInput: true };
  for (const executionPhase of ["ended", "waiting_preparation"]) {
    const tasks = reviewTasksFromIssues([{ ...issue, executionPhase }], "reviewer");
    assert.deepEqual(failedReviewRetry(pr, tasks, now), { retryOf: "original", retryUpdatedAt: updatedAt });
    assert.deepEqual(queueableReviews([pr], tasks, { retry: true, now }), [pr]);
    assert.equal(failedReviewRetry({ ...pr, sourceCommit: "other-revision" }, tasks, now), null);
  }
  for (const executionPhase of ["cleanup_blocked", "stopping"]) {
    const tasks = reviewTasksFromIssues([{ ...issue, executionPhase }], "reviewer");
    assert.equal(failedReviewRetry(pr, tasks, now + 86400000), null);
  }
  const delivered = reviewTasksFromIssues([{ ...issue, executionPhase: "ended",
    pendingOperatorInput: false }], "reviewer");
  assert.equal(failedReviewRetry(pr, delivered, now + 86400000), null);
});

test("a mid-turn provider disconnect retries its exact revision after cooldown, not genuine failures", () => {
  const updatedAt = "2026-11-16T20:04:20Z", now = Date.parse(updatedAt);
  const issue = { id: "original", assigneeAgentId: "reviewer", status: "failed",
    title: "Review Azure DevOps pull request #7: Original",
    description: "Source commit: new-source", updatedAt, executionPhase: "ended" };
  for (const error of ["Provider closed during a turn", "Native remote Copilot exited (255)"]) {
    const tasks = reviewTasksFromIssues([{ ...issue, error }], "reviewer");
    assert.equal(failedReviewRetry(pr, tasks, now + 59_999), null);
    assert.deepEqual(failedReviewRetry(pr, tasks, now + 60_000),
      { retryOf: "original", retryUpdatedAt: updatedAt });
    assert.deepEqual(queueableReviews([pr], tasks, { retry: true, now: now + 60_000 }), [pr]);
    assert.equal(failedReviewRetry({ ...pr, sourceCommit: "other-revision" }, tasks, now + 60_000), null);
    for (const executionPhase of ["cleanup_blocked", "stopping"]) {
      const busy = reviewTasksFromIssues([{ ...issue, error, executionPhase }], "reviewer");
      assert.equal(failedReviewRetry(pr, busy, now + 60_000), null);
    }
    for (const status of ["done", "cancelled", "superseded"]) {
      const terminal = reviewTasksFromIssues([{ ...issue, error, status }], "reviewer");
      assert.equal(failedReviewRetry(pr, terminal, now + 60_000), null);
    }
  }
  for (const error of ["Build failed", "Review declined", "Copilot authentication failed", undefined]) {
    const tasks = reviewTasksFromIssues([{ ...issue, error }], "reviewer");
    assert.equal(failedReviewRetry(pr, tasks, now + 86400000), null);
  }
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
