import test from "node:test";
import assert from "node:assert/strict";

import {
  summarizeDispatch,
  computeHealth,
  DISPATCH_GAP_MINUTES,
} from "../tools/heartbeat-health/health.js";

/**
 * A run going quiet says nothing on its own about what silenced it. These rows hold the two cases
 * apart: one lost run went quiet while the supervisor was still starting other runs, and one went
 * quiet inside a window where the supervisor started nothing at all.
 */
const rows = [
  { startedAt: "2026-09-02T01:00:00Z", finishedAt: "2026-09-02T01:05:00Z", status: "succeeded" },
  {
    startedAt: "2026-09-02T01:01:00Z",
    lastOutputAt: "2026-09-02T01:01:30Z",
    finishedAt: "2026-09-02T01:20:00Z",
    status: "failed",
    agentId: "agent-1",
    error: "Process lost while running heartbeat",
  },
  {
    startedAt: "2026-09-02T01:02:00Z",
    lastOutputAt: "2026-09-02T01:10:00Z",
    finishedAt: "2026-09-02T01:30:00Z",
    status: "failed",
    agentId: "agent-2",
    error: "Process lost while running heartbeat",
  },
  { startedAt: "2026-09-02T01:20:00Z", finishedAt: "2026-09-02T01:25:00Z", status: "succeeded" },
  { startedAt: "2026-09-02T01:21:00Z", finishedAt: "2026-09-02T01:26:00Z", status: "succeeded" },
];

test("a window with nothing dispatched is reported as a gap", () => {
  const dispatch = summarizeDispatch(rows);
  assert.equal(dispatch.minimumGapMinutes, DISPATCH_GAP_MINUTES);
  assert.equal(dispatch.gapCount, 1);
  assert.deepEqual(dispatch.widestGap, {
    from: "2026-09-02T01:02:00.000Z",
    to: "2026-09-02T01:20:00.000Z",
    minutes: 18,
  });
});

test("a silence while the supervisor was still dispatching is counted apart from one inside a gap", () => {
  const dispatch = summarizeDispatch(rows);
  assert.equal(dispatch.lostRunsSilencedWhileStillDispatching, 1);
  assert.equal(dispatch.lostRunsSilencedDuringADispatchGap, 1);
  assert.equal(dispatch.lostRunsWithNoSilenceInstant, 0);
  assert.equal(dispatch.silencedWhileStillDispatchingShare, 50);
});

test("a lost run with no silence instant is counted apart rather than assigned to either side", () => {
  const dispatch = summarizeDispatch([
    ...rows,
    {
      startedAt: "2026-09-02T01:40:00Z",
      finishedAt: "2026-09-02T01:50:00Z",
      status: "failed",
      error: "Process lost while running heartbeat",
    },
  ]);
  assert.equal(dispatch.lostRunsWithNoSilenceInstant, 1);
});

test("the clause fails while any lost run went quiet with the supervisor still dispatching", () => {
  const health = computeHealth(rows, { since: "2026-09-02T00:00:00Z" });
  const clause = health.clauses["lost runs silenced while the supervisor was still dispatching"];
  assert.equal(clause.number, 1);
  assert.equal(clause.target, 0);
  assert.equal(clause.pass, false);
});

test("the supervisor clause is not scored when no record was read", () => {
  const health = computeHealth(rows, { since: "2026-09-02T00:00:00Z" });
  const clause =
    health.clauses["runs the output recency guard skipped and another path terminalized anyway"];
  assert.equal(clause.number, null);
  assert.equal(clause.pass, null);
  assert.equal(health.supervisor, null);
});

test("a supplied supervisor record scores the guard hole clause and is carried on the record", () => {
  const supervisor = {
    date: "2026-09-01",
    startupInstants: ["2026-09-02T01:50:38.000Z"],
    startups: 1,
    guardSkippedRuns: 9,
    reapedRuns: 14,
    staleLockTerminalizedRuns: 4,
    guardHoleRuns: 4,
    guardHoles: [],
  };
  const health = computeHealth(rows, { since: "2026-09-02T00:00:00Z", supervisor });
  const clause =
    health.clauses["runs the output recency guard skipped and another path terminalized anyway"];
  assert.equal(clause.number, 4);
  assert.equal(clause.of, 9);
  assert.equal(clause.pass, false);
  assert.equal(health.supervisor.startups, 1);
});

test("the guard expiry clause separates a postponed verdict from a prevented one", () => {
  const postponed = {
    date: "2026-09-01",
    startupInstants: ["2026-09-02T01:50:38.000Z"],
    startups: 1,
    guardSkippedRuns: 12,
    reapedRuns: 20,
    staleLockTerminalizedRuns: 4,
    guardHoleRuns: 10,
    guardExpiryKills: 10,
    guardHolesWithOutputAge: 10,
    guardHoles: [],
  };
  const health = computeHealth(rows, { since: "2026-09-02T00:00:00Z", supervisor: postponed });
  const clause = health.clauses["guard skipped runs terminalized at the instant the guard expired"];
  assert.equal(clause.number, 10);
  assert.equal(clause.of, 10);
  assert.equal(clause.target, 0);
  assert.equal(clause.pass, false);

  const prevented = { ...postponed, guardHoleRuns: 0, guardExpiryKills: 0, guardHolesWithOutputAge: 0 };
  const repaired = computeHealth(rows, { since: "2026-09-02T00:00:00Z", supervisor: prevented });
  assert.equal(
    repaired.clauses["guard skipped runs terminalized at the instant the guard expired"].pass,
    true,
  );
});

test("the guard expiry clause is not scored when no record was read", () => {
  const health = computeHealth(rows, { since: "2026-09-02T00:00:00Z" });
  const clause = health.clauses["guard skipped runs terminalized at the instant the guard expired"];
  assert.equal(clause.number, null);
  assert.equal(clause.pass, null);
});
