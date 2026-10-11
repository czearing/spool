import assert from "node:assert/strict";
import test from "node:test";
import { assignmentKey, newlyAssigned } from "../lib/assignments.mjs";

const pr = {
  organization: "office",
  project: "OC",
  repository: "repo",
  id: "42",
  sourceCommit: "commit-a",
};

test("first observation queues an assignment once", () => {
  assert.deepEqual(newlyAssigned([], [pr]), [pr]);
  assert.deepEqual(newlyAssigned([assignmentKey(pr)], [pr]), []);
});

test("removal and later reassignment creates a new assignment cycle", () => {
  assert.deepEqual(newlyAssigned([], [pr]), [pr]);
});

test("a new source commit creates a new review cycle", () => {
  assert.deepEqual(newlyAssigned([assignmentKey(pr)], [{ ...pr, sourceCommit: "commit-b" }]), [
    { ...pr, sourceCommit: "commit-b" },
  ]);
});
