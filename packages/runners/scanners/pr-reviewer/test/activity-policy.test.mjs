import assert from "node:assert/strict";
import test from "node:test";
import { observationChanges, scanActivityDecision } from "../lib/activity-policy.mjs";

const pr = {
  id: "42",
  repository: "repo",
  title: "Title",
  eligible: true,
  sourceCommit: "abc",
  reasons: [],
};

test("logs PR observations only when their decision or revision changes", () => {
  const first = observationChanges({}, [pr]);
  assert.deepEqual(first.changed, [pr]);
  assert.deepEqual(observationChanges(first.current, [pr]).changed, []);
  assert.deepEqual(observationChanges(first.current, [{ ...pr, sourceCommit: "def" }]).changed, [
    { ...pr, sourceCommit: "def" },
  ]);
});

test("logs scan summaries on change or heartbeat", () => {
  const first = scanActivityDecision(null, 0, { detected: 1, eligible: 1 }, 1_000);
  assert.equal(first.log, true);
  const stable = scanActivityDecision(first.signature, first.lastLoggedAt, { detected: 1, eligible: 1 }, 2_000);
  assert.equal(stable.log, false);
  const heartbeat = scanActivityDecision(first.signature, first.lastLoggedAt, { detected: 1, eligible: 1 }, 601_000);
  assert.equal(heartbeat.log, true);
  const recovery = scanActivityDecision(first.signature, first.lastLoggedAt, { detected: 1, eligible: 1 }, 2_000, 600_000, true);
  assert.equal(recovery.log, true);
});
