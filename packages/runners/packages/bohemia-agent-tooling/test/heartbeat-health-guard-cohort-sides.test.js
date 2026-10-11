/**
 * The guard clauses read as cohort clauses on each side of a cutoff.
 *
 * Every other cohort number is reported for both sides of a split. The two clauses that read the
 * supervisor's own record were reported as one undivided number, so a reader could not tell the
 * stretch before a repair from the stretch after it in the one block that measures the repair.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseSupervisorLog,
  summarizeSupervisorRecord,
  sliceSupervisorRecordBefore,
  sliceSupervisorRecordAt,
} from "../tools/heartbeat-health/supervisor-log.js";
import { computeHealth, scoreGuardClauses } from "../tools/heartbeat-health/health.js";

const HOLE_CLAUSE = "runs the output recency guard skipped and another path terminalized anyway";
const EXPIRY_CLAUSE = "guard skipped runs terminalized at the instant the guard expired";

/** Two guard holes before the cutoff and one after it, so the two sides cannot be confused. */
const RECORD = [
  '[15:00:00] DEBUG: skipping orphan reap for heartbeat run that is still producing output {"runId":"before-one","agentId":"agent-1","recentOutputAgeMs":595000,"processPid":100}',
  '[15:10:00] WARN: reaped orphaned heartbeat runs {"reapedCount":1,"runIds":["before-one"]}',
  '[15:20:00] DEBUG: skipping orphan reap for heartbeat run that is still producing output {"runId":"before-two","agentId":"agent-1","recentOutputAgeMs":595000,"processPid":101}',
  '[15:30:00] WARN: reaped orphaned heartbeat runs {"reapedCount":1,"runIds":["before-two"]}',
  '[17:00:00] DEBUG: skipping orphan reap for heartbeat run that is still producing output {"runId":"after-one","agentId":"agent-2","recentOutputAgeMs":595000,"processPid":200}',
  '[17:10:00] WARN: reaped orphaned heartbeat runs {"reapedCount":1,"runIds":["after-one"]}',
  "[17:20:00] INFO: Server listening on 127.0.0.1:3400",
].join("\n");

const CUTOFF = "2026-09-01T23:30:00.000Z";

function summarized() {
  return summarizeSupervisorRecord(
    parseSupervisorLog(RECORD, { date: "2026-09-01", utcOffsetMinutes: -420 }),
  );
}

function run(id, startedAt, finishedAt) {
  return {
    id,
    agentId: "agent-1",
    status: "succeeded",
    startedAt,
    finishedAt,
    lastOutputAt: finishedAt,
  };
}

/** Runs on both sides of the cutoff, so the split has a cohort on each side to report. */
const RUNS = [
  run("before-one", "2026-09-01T22:00:00.000Z", "2026-09-01T22:10:00.000Z"),
  run("before-two", "2026-09-01T22:20:00.000Z", "2026-09-01T22:30:00.000Z"),
  run("after-one", "2026-09-02T00:00:00.000Z", "2026-09-02T00:10:00.000Z"),
];

test("the record restricted to before a cutoff is a reading in its own right", () => {
  const before = sliceSupervisorRecordBefore(summarized(), CUTOFF);

  assert.equal(before.guardSkippedRuns, 2);
  assert.equal(before.guardHoleRuns, 2);
  assert.deepEqual(
    before.guardHoles.map((hole) => hole.runId),
    ["before-one", "before-two"],
  );
  assert.equal(before.beforeCutoff, CUTOFF);
  assert.equal(before.sinceCutoff, null, "a before slice is not a since slice");
  assert.equal(before.restrictedToCutoff, true);
});

test("the two sides of a cutoff partition the record and neither inherits the other's events", () => {
  const summary = summarized();
  const before = sliceSupervisorRecordBefore(summary, CUTOFF);
  const after = sliceSupervisorRecordAt(summary, CUTOFF);

  assert.equal(before.guardHoleRuns + after.guardHoleRuns, summary.guardHoleRuns);
  assert.equal(before.guardSkippedRuns + after.guardSkippedRuns, summary.guardSkippedRuns);
  assert.equal(before.reapedRuns + after.reapedRuns, summary.reapedRuns);

  const beforeIds = new Set(before.guardHoles.map((hole) => hole.runId));
  for (const hole of after.guardHoles) {
    assert.equal(beforeIds.has(hole.runId), false, "a hole belongs to exactly one side");
  }
});

test("a before slice narrows its coverage to the stretch before the cutoff", () => {
  const before = sliceSupervisorRecordBefore(summarized(), CUTOFF);
  assert.ok(before.coverageSpan !== null);
  assert.ok(
    new Date(before.coverageSpan.to).getTime() <= new Date(CUTOFF).getTime(),
    "the before slice cannot claim to have observed past the cutoff",
  );
});

test("no cutoff returns the record unchanged rather than an empty before slice", () => {
  const summary = summarized();
  assert.equal(sliceSupervisorRecordBefore(summary, null), summary);
});

test("a before slice refuses a value that is not an instant and one that is not a record", () => {
  assert.throws(() => sliceSupervisorRecordBefore(summarized(), "not-an-instant"), /instant/);
  assert.throws(() => sliceSupervisorRecordBefore(null, CUTOFF), /supervisor record/);
});

test("with a cutoff supplied both guard clauses are reported on each side of it", () => {
  const health = computeHealth(RUNS, { since: CUTOFF, supervisor: summarized() });

  assert.ok(health.guardClausesBySide, "a split reports the guard clauses per side");
  for (const side of ["before", "after"]) {
    const names = Object.keys(health.guardClausesBySide[side].clauses);
    assert.deepEqual(names, [HOLE_CLAUSE, EXPIRY_CLAUSE], `${side} reports both clauses`);
  }

  assert.equal(health.guardClausesBySide.before.clauses[HOLE_CLAUSE].number, 2);
  assert.equal(health.guardClausesBySide.before.clauses[HOLE_CLAUSE].of, 2);
  assert.equal(health.guardClausesBySide.after.clauses[HOLE_CLAUSE].number, 1);
  assert.equal(health.guardClausesBySide.after.clauses[HOLE_CLAUSE].of, 1);
});

test("the scored clause block agrees with the after side, so the two readings cannot drift", () => {
  const health = computeHealth(RUNS, { since: CUTOFF, supervisor: summarized() });

  for (const name of [HOLE_CLAUSE, EXPIRY_CLAUSE]) {
    assert.deepEqual(
      health.clauses[name],
      health.guardClausesBySide.after.clauses[name],
      `${name} is one reading, reported twice`,
    );
  }
});

test("with no cutoff there is no per side reading, because there is only one cohort", () => {
  const health = computeHealth(RUNS, { supervisor: summarized() });
  assert.equal(health.guardClausesBySide, null);
  assert.equal(health.clauses[HOLE_CLAUSE].number, 3);
});

test("with no record read at all there is no per side reading to report", () => {
  const health = computeHealth(RUNS, { since: CUTOFF });
  assert.equal(health.guardClausesBySide, null);
  assert.equal(health.clauses[HOLE_CLAUSE].pass, null);
});

test("a side the record never observed is not scored, and names the stretch it was refused over", () => {
  const runs = [
    ...RUNS,
    run("much-later", "2026-09-05T09:00:00.000Z", "2026-09-05T09:10:00.000Z"),
  ];
  const health = computeHealth(runs, {
    since: "2026-09-05T08:00:00.000Z",
    supervisor: summarized(),
  });

  const after = health.guardClausesBySide.after;
  assert.equal(after.coverage.coversCohort, false);
  assert.equal(after.clauses[HOLE_CLAUSE].pass, null, "an unobserved side is refused, not passed");
  assert.equal(after.clauses[HOLE_CLAUSE].number, null);
  assert.ok(
    after.clauses[HOLE_CLAUSE].notScoredOver.length > 0,
    "the clause itself names the uncovered stretch rather than leaving it to a neighbouring line",
  );
  assert.equal(
    health.clauses[HOLE_CLAUSE].notScoredOver.length,
    after.clauses[HOLE_CLAUSE].notScoredOver.length,
  );

  // The side the record did observe is still scored, so one refusal does not silence both sides.
  assert.equal(health.guardClausesBySide.before.clauses[HOLE_CLAUSE].pass, false);
  assert.equal(health.guardClausesBySide.before.clauses[HOLE_CLAUSE].number, 3);
});

test("the guard clause scorer refuses a record it was told does not cover the span", () => {
  const summary = summarized();

  const scored = scoreGuardClauses(summary, { coversSpan: true });
  assert.equal(scored[HOLE_CLAUSE].number, 3);
  assert.equal(scored[HOLE_CLAUSE].pass, false);
  assert.equal(scored[HOLE_CLAUSE].notScoredOver, null);

  const refused = scoreGuardClauses(summary, {
    coversSpan: false,
    uncovered: [{ from: "2026-09-02T00:00:00.000Z", to: "2026-09-02T06:00:00.000Z" }],
  });
  assert.equal(refused[HOLE_CLAUSE].pass, null);
  assert.equal(refused[HOLE_CLAUSE].number, null);
  assert.equal(refused[EXPIRY_CLAUSE].pass, null);
  assert.equal(refused[HOLE_CLAUSE].notScoredOver.length, 1);
});

test("no record at all is not scored, and carries no uncovered stretch to blame it on", () => {
  const clauses = scoreGuardClauses(null);
  assert.equal(clauses[HOLE_CLAUSE].pass, null);
  assert.equal(
    clauses[HOLE_CLAUSE].notScoredOver,
    null,
    "a record that was never read is not a record that stopped short",
  );
});

/**
 * A refusal has to say which of the two things happened. A record that was never read and a record
 * that was read and stops short of the cohort are different findings with different repairs, and the
 * refusal is the only line a reader gets. Reporting the stretch the cohort retained as the stretch
 * the record observed collapses the second into the first, and tells an operator that a record
 * covering a day and a half observed nothing at all.
 */
test("a refusal names the span the record observed, not the empty span the cohort retained", () => {
  const runs = [
    ...RUNS,
    run("much-later", "2026-09-05T09:00:00.000Z", "2026-09-05T09:10:00.000Z"),
  ];
  const health = computeHealth(runs, {
    since: "2026-09-05T08:00:00.000Z",
    supervisor: summarized(),
  });

  const coverage = health.supervisorCoverage;
  assert.equal(coverage.coversCohort, false);
  assert.equal(coverage.scopedSpan, null, "the cohort retained none of the record");
  assert.ok(coverage.recordSpan !== null, "the record itself observed a span and says so");
  assert.equal(coverage.recordSpan.from, "2026-09-01T22:00:00.000Z");
  assert.equal(coverage.recordSpan.to, "2026-09-02T00:20:00.000Z");
  assert.ok(
    new Date(coverage.recordSpan.to).getTime() < new Date(coverage.cohortSpan.from).getTime(),
    "the record stops before the cohort starts, which is why the clause is refused",
  );
});

test("a cohort the record does cover reports the same span for the record and for what it retained", () => {
  const health = computeHealth(RUNS, { since: CUTOFF, supervisor: summarized() });
  const coverage = health.supervisorCoverage;

  assert.equal(coverage.coversCohort, true);
  assert.equal(coverage.recordSpan.from, "2026-09-01T22:00:00.000Z");
  assert.equal(coverage.recordSpan.to, "2026-09-02T00:20:00.000Z");
  assert.equal(coverage.scopedSpan.to, "2026-09-02T00:20:00.000Z");
  assert.equal(
    coverage.scopedSpan.from,
    CUTOFF,
    "what the cohort retained starts at the cutoff, while the record started before it",
  );
});
