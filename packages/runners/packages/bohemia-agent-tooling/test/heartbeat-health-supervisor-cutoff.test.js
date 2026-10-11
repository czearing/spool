import test from "node:test";
import assert from "node:assert/strict";

import {
  parseSupervisorLog,
  summarizeSupervisorRecord,
  sliceSupervisorRecordAt,
} from "../tools/heartbeat-health/supervisor-log.js";
import { computeHealth } from "../tools/heartbeat-health/health.js";

/**
 * One run skipped by the guard and reaped before the cutoff, one after it. Scoring the whole record
 * against a cohort taken after the cutoff is the defect this surface exists to prevent.
 */
const RECORD = [
  '[15:00:00] DEBUG: skipping orphan reap for heartbeat run that is still producing output {"runId":"before-run","agentId":"agent-1","recentOutputAgeMs":595000,"processPid":100}',
  '[15:10:00] WARN: reaped orphaned heartbeat runs {"reapedCount":1,"runIds":["before-run"]}',
  '[17:00:00] DEBUG: skipping orphan reap for heartbeat run that is still producing output {"runId":"after-run","agentId":"agent-2","recentOutputAgeMs":595000,"processPid":200}',
  '[17:10:00] WARN: reaped orphaned heartbeat runs {"reapedCount":1,"runIds":["after-run"]}',
  "[17:20:00] INFO: Server listening on 127.0.0.1:3400",
].join("\n");

const CUTOFF = "2026-09-01T23:30:00.000Z";

function summarized() {
  return summarizeSupervisorRecord(
    parseSupervisorLog(RECORD, { date: "2026-09-01", utcOffsetMinutes: -420 }),
  );
}

test("the whole record carries both holes and both guard skips", () => {
  const summary = summarized();
  assert.equal(summary.guardSkippedRuns, 2);
  assert.equal(summary.guardHoleRuns, 2);
  assert.equal(summary.sinceCutoff, null);
  assert.deepEqual(
    summary.guardHoles.map((hole) => hole.runId),
    ["before-run", "after-run"],
  );
});

test("the slice keeps only the events at or after the cutoff and recomputes every derived number", () => {
  const sliced = sliceSupervisorRecordAt(summarized(), CUTOFF);
  assert.equal(sliced.sinceCutoff, CUTOFF);
  assert.equal(sliced.guardSkippedRuns, 1);
  assert.equal(sliced.reapedRuns, 1);
  assert.equal(sliced.guardHoleRuns, 1);
  assert.deepEqual(
    sliced.guardHoles.map((hole) => hole.runId),
    ["after-run"],
  );
  assert.equal(sliced.guardHolesWithoutRecordedAuthority, 1);
  assert.deepEqual(sliced.guardHolesByTerminatingPath, [
    { key: "orphan_reap", count: 1, withoutAuthority: 1 },
  ]);
  assert.equal(sliced.startups, 1);
});

test("a cutoff after every recorded event leaves an empty slice rather than the whole record", () => {
  const sliced = sliceSupervisorRecordAt(summarized(), "2026-09-02T06:00:00.000Z");
  assert.equal(sliced.guardHoleRuns, 0);
  assert.equal(sliced.guardSkippedRuns, 0);
  assert.equal(sliced.guardExpiryKills, 0);
  assert.deepEqual(sliced.guardHolesByTerminatingPath, []);
});

test("no cutoff returns the record unchanged, so a reading with no split is not narrowed", () => {
  const summary = summarized();
  assert.equal(sliceSupervisorRecordAt(summary, null), summary);
});

test("a cutoff that is not an instant is refused rather than read as the epoch", () => {
  assert.throws(() => sliceSupervisorRecordAt(summarized(), "not-an-instant"), /instant/);
});

test("a value that is not a summarized record is refused", () => {
  assert.throws(() => sliceSupervisorRecordAt(null, CUTOFF), /supervisor record/);
});

test("a record carrying totals but no instants is returned whole and marked as not restricted", () => {
  const totalsOnly = {
    date: "2026-09-01",
    startupInstants: [],
    startups: 1,
    guardSkippedRuns: 9,
    reapedRuns: 14,
    staleLockTerminalizedRuns: 4,
    guardHoleRuns: 4,
    guardHoles: [],
  };
  const sliced = sliceSupervisorRecordAt(totalsOnly, CUTOFF);
  assert.equal(sliced.guardHoleRuns, 4, "the totals are not replaced by a fabricated zero");
  assert.equal(sliced.guardSkippedRuns, 9);
  assert.equal(sliced.sinceCutoff, null);
  assert.equal(sliced.restrictedToCutoff, false);
});

test("the guard clauses are scored on the slice, not on the whole record", () => {
  const runs = [
    {
      id: "after-run",
      agentId: "agent-2",
      status: "succeeded",
      startedAt: "2026-09-02T00:00:00.000Z",
      finishedAt: "2026-09-02T00:05:00.000Z",
      lastOutputAt: "2026-09-02T00:05:00.000Z",
    },
  ];
  const health = computeHealth(runs, { since: CUTOFF, supervisor: summarized() });

  assert.equal(health.supervisor.guardHoleRuns, 2, "the whole record is still reported");
  assert.equal(health.supervisorScored.guardHoleRuns, 1, "the slice is what the clauses read");
  assert.equal(
    health.clauses["runs the output recency guard skipped and another path terminalized anyway"]
      .number,
    1,
  );
  assert.equal(
    health.clauses["runs the output recency guard skipped and another path terminalized anyway"].of,
    1,
  );
});

test("with no cutoff the clauses read the whole record and nothing is sliced away", () => {
  const runs = [
    {
      id: "after-run",
      agentId: "agent-2",
      status: "succeeded",
      startedAt: "2026-09-02T00:00:00.000Z",
      finishedAt: "2026-09-02T00:05:00.000Z",
      lastOutputAt: "2026-09-02T00:05:00.000Z",
    },
  ];
  const health = computeHealth(runs, { supervisor: summarized() });
  assert.equal(health.supervisorScored.guardHoleRuns, 2);
  assert.equal(
    health.clauses["runs the output recency guard skipped and another path terminalized anyway"]
      .number,
    2,
  );
});

test("a cohort the record never observed is not scored, rather than passing at zero of zero", () => {
  const runs = [
    {
      id: "later-run",
      agentId: "agent-3",
      status: "succeeded",
      startedAt: "2026-09-03T09:00:00.000Z",
      finishedAt: "2026-09-03T09:05:00.000Z",
      lastOutputAt: "2026-09-03T09:05:00.000Z",
    },
  ];
  const health = computeHealth(runs, {
    since: "2026-09-03T08:00:00.000Z",
    supervisor: summarized(),
  });

  assert.equal(health.supervisorScored.guardHoleRuns, 0, "the slice is empty");
  assert.equal(health.supervisorCoverage.coversCohort, false);
  const clause =
    health.clauses["runs the output recency guard skipped and another path terminalized anyway"];
  assert.equal(clause.pass, null, "an unobserved cohort is refused, not passed");
  assert.equal(clause.number, null);
  assert.equal(
    health.clauses["guard skipped runs terminalized at the instant the guard expired"].pass,
    null,
  );
  assert.ok(
    health.supervisorCoverage.uncoveredSpans.length > 0,
    "the stretch the record never observed is named",
  );
});

test("a cohort the record did observe is scored, and the observed stretch is reported", () => {
  const runs = [
    {
      id: "after-run",
      agentId: "agent-2",
      status: "succeeded",
      startedAt: "2026-09-02T00:00:00.000Z",
      finishedAt: "2026-09-02T00:20:00.000Z",
      lastOutputAt: "2026-09-02T00:20:00.000Z",
    },
  ];
  const health = computeHealth(runs, { since: CUTOFF, supervisor: summarized() });
  assert.equal(health.supervisorCoverage.coversCohort, true);
  assert.ok(health.supervisorCoverage.observedSpan !== null);
  assert.equal(
    health.clauses["runs the output recency guard skipped and another path terminalized anyway"]
      .pass,
    false,
  );
});
