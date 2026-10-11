/**
 * The as of projection surface.
 *
 * The endpoint this collector reads is mutable, so a number quoted from an earlier read cannot be
 * re-scored later: runs that were still running have since acquired an error, a finish instant and a
 * terminal status, and the lost cohort grows every time the same cutoff is asked for. These tests pin
 * the projection that reads the rows back as they stood at a chosen instant, using recorded columns
 * only.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { projectRunAsOf, projectRunsAsOf } from "../tools/heartbeat-health/as-of.js";
import { computeHealth } from "../tools/heartbeat-health/health.js";

const instant = new Date("2026-09-02T00:30:00.000Z");

const stillRunningAtInstant = {
  id: "later",
  agentId: "agent-one",
  startedAt: "2026-09-02T00:10:00Z",
  lastOutputAt: "2026-09-02T00:20:00Z",
  finishedAt: "2026-09-02T00:45:00Z",
  status: "failed",
  error: "Process lost",
  errorCode: "process_lost",
  exitCode: null,
  signal: null,
};

const endedBeforeInstant = {
  id: "earlier",
  agentId: "agent-two",
  startedAt: "2026-09-02T00:00:00Z",
  lastOutputAt: "2026-09-02T00:05:00Z",
  finishedAt: "2026-09-02T00:20:00Z",
  status: "failed",
  error: "Process lost",
  errorCode: "process_lost",
};

const startedAfterInstant = {
  id: "unborn",
  agentId: "agent-three",
  startedAt: "2026-09-02T00:40:00Z",
  finishedAt: "2026-09-02T00:50:00Z",
  status: "failed",
  error: "Process lost",
};

test("a run that had not ended yet reads as running rather than as lost", () => {
  const projected = projectRunAsOf(stillRunningAtInstant, instant);
  assert.equal(projected.status, "running");
  assert.equal(projected.finishedAt, null);
  assert.equal(projected.error, null);
  assert.equal(projected.errorCode, null);
  assert.equal(projected.lastOutputAt, "2026-09-02T00:20:00Z");
});

test("a run that had already ended is returned untouched", () => {
  const projected = projectRunAsOf(endedBeforeInstant, instant);
  assert.deepEqual(projected, endedBeforeInstant);
});

test("a run that had not started yet is dropped rather than counted as a started run", () => {
  assert.equal(projectRunAsOf(startedAfterInstant, instant), null);
});

test("output stamped after the instant had not been recorded yet", () => {
  const projected = projectRunAsOf(
    { ...endedBeforeInstant, lastOutputAt: "2026-09-02T00:35:00Z" },
    instant,
  );
  assert.equal(projected.lastOutputAt, null);
});

test("a row carrying no start instant is left for the undated count to report", () => {
  const undated = { id: "undated", startedAt: null, status: "running" };
  assert.deepEqual(projectRunAsOf(undated, instant), undated);
});

test("the projection never edits the row it was given", () => {
  const before = JSON.stringify(stillRunningAtInstant);
  projectRunAsOf(stillRunningAtInstant, instant);
  assert.equal(JSON.stringify(stillRunningAtInstant), before);
});

test("an instant with no offset is read as utc, not as the local time of the host", () => {
  const original = process.env.TZ;
  process.env.TZ = "Asia/Tokyo";
  try {
    const projected = projectRunsAsOf(
      [stillRunningAtInstant, endedBeforeInstant, startedAfterInstant],
      "2026-09-02T00:30:00",
    );
    assert.deepEqual(
      projected.map((run) => run.id),
      ["later", "earlier"],
    );
    assert.equal(projected[0].status, "running");
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("an unparsable instant is refused rather than read as the epoch", () => {
  assert.throws(() => projectRunsAsOf([], "not an instant"), /--as-of needs an instant/);
});

test("the projection shrinks the lost cohort back to what the earlier read returned", () => {
  const rows = [stillRunningAtInstant, endedBeforeInstant, startedAfterInstant];
  const now = computeHealth(rows, { since: "2026-09-02T00:00:00Z" });
  assert.equal(now.after.startedRuns, 3);
  assert.equal(now.after.processLostRuns, 3);

  const asOf = computeHealth(projectRunsAsOf(rows, "2026-09-02T00:30:00Z"), {
    since: "2026-09-02T00:00:00Z",
    asOf: "2026-09-02T00:30:00Z",
  });
  assert.equal(asOf.after.startedRuns, 2);
  assert.equal(asOf.after.processLostRuns, 1);
  assert.equal(asOf.query.asOf, "2026-09-02T00:30:00.000Z");
});

test("a reading with no as of instant says so rather than leaving the field out", () => {
  const health = computeHealth([endedBeforeInstant], { since: "2026-09-02T00:00:00Z" });
  assert.equal(health.query.asOf, null);
});

test("computeHealth refuses an as of instant it cannot parse", () => {
  assert.throws(
    () => computeHealth([], { asOf: "yesterday" }),
    /asOf needs an instant/,
  );
});

test("two projections of the same rows at the same instant are byte identical", () => {
  const rows = [stillRunningAtInstant, endedBeforeInstant, startedAfterInstant];
  const first = JSON.stringify(projectRunsAsOf(rows, "2026-09-02T00:30:00Z"));
  const second = JSON.stringify(projectRunsAsOf(rows, "2026-09-02T00:30:00Z"));
  assert.equal(first, second);
});
