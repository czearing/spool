import assert from "node:assert/strict";
import test from "node:test";
import { applyReviewerAssignmentPolicy } from "../lib/assignment-policy.mjs";

function pr(id, { old = false, reasons = old ? ["older than 30 days"] : [] } = {}) {
  return {
    id: String(id),
    eligible: reasons.length === 0,
    olderThanMaxAge: old,
    reasons,
  };
}

test("baselines old backlog without queueing it", () => {
  const result = applyReviewerAssignmentPolicy([pr(1, { old: true }), pr(2)], {
    reviewerAssignments: null,
    ageExemptReviewerAssignments: [],
  });
  assert.deepEqual(result.eligible.map(({ id }) => id), ["2"]);
  assert.deepEqual(result.reviewerAssignments, ["1", "2"]);
  assert.deepEqual(result.ageExemptReviewerAssignments, ["2"]);
  assert.deepEqual(result.removedReviewerAssignments, []);
});

test("newly assigned old PR bypasses only the age cutoff", () => {
  const result = applyReviewerAssignmentPolicy([
    pr(1, { old: true }),
    pr(2, { old: true, reasons: ["draft", "older than 30 days"] }),
  ], {
    reviewerAssignments: [],
    ageExemptReviewerAssignments: [],
  });
  assert.deepEqual(result.eligible.map(({ id }) => id), ["1"]);
  assert.deepEqual(result.detected[1].reasons, ["draft"]);
  assert.deepEqual(result.ageExemptReviewerAssignments, ["1", "2"]);
});

test("keeps the assignment exemption across scans and restarts", () => {
  const result = applyReviewerAssignmentPolicy([pr(1, { old: true })], {
    reviewerAssignments: ["1"],
    ageExemptReviewerAssignments: ["1"],
  });
  assert.deepEqual(result.eligible.map(({ id }) => id), ["1"]);
  assert.deepEqual(result.ageExemptReviewerAssignments, ["1"]);
});

test("removes exemptions on unassignment and restores them on reassignment", () => {
  const removed = applyReviewerAssignmentPolicy([], {
    reviewerAssignments: ["1"],
    ageExemptReviewerAssignments: ["1"],
  });
  assert.deepEqual(removed.ageExemptReviewerAssignments, []);
  assert.deepEqual(removed.removedReviewerAssignments, ["1"]);

  const readded = applyReviewerAssignmentPolicy([pr(1, { old: true })], {
    reviewerAssignments: removed.reviewerAssignments,
    ageExemptReviewerAssignments: removed.ageExemptReviewerAssignments,
  });
  assert.deepEqual(readded.eligible.map(({ id }) => id), ["1"]);
});
