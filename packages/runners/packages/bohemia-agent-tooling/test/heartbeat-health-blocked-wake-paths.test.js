import test from "node:test";
import assert from "node:assert/strict";

import { summarizeBlockedIssues, scoreClauses } from "../tools/heartbeat-health/health.js";

/**
 * The board shape OFF-84 was filed on, reduced to the rows that decide the numbers. OFF-68 is blocked
 * with no blocker and no monitor and OFF-44 waits on it, so the chain has no way back. OFF-55 is a
 * dead end that nothing waits on. OFF-62 waits on a running issue, so it resumes on its own.
 */
const board = [
  {
    id: "off-68",
    identifier: "OFF-68",
    status: "blocked",
    blockedTransitionAt: "2026-09-02T01:58:47Z",
    blockedBy: [],
    monitorNextCheckAt: null,
    unblockDescriptor: null,
  },
  {
    id: "off-44",
    identifier: "OFF-44",
    status: "blocked",
    blockedTransitionAt: "2026-09-02T01:20:00Z",
    blockedBy: [{ id: "off-68", identifier: "OFF-68", status: "blocked" }],
    monitorNextCheckAt: null,
    unblockDescriptor: null,
  },
  {
    id: "off-55",
    identifier: "OFF-55",
    status: "blocked",
    blockedTransitionAt: "2026-09-02T01:15:29Z",
    blockedBy: [],
    monitorNextCheckAt: null,
    unblockDescriptor: null,
  },
  {
    id: "off-62",
    identifier: "OFF-62",
    status: "blocked",
    blockedTransitionAt: "2026-09-02T01:30:00Z",
    blockedBy: [{ id: "off-66", identifier: "OFF-66", status: "in_progress" }],
    monitorNextCheckAt: null,
    unblockDescriptor: null,
  },
];

test("a blocked issue with no blocker and no monitor is counted as carrying no wake path", () => {
  const blocked = summarizeBlockedIssues(board);
  assert.equal(blocked.blockedIssues, 4);
  assert.equal(blocked.withoutBlockers, 2);
  assert.equal(blocked.withoutWakePath, 2);
  assert.deepEqual(
    blocked.issues.map((issue) => issue.identifier),
    ["OFF-55", "OFF-68"],
  );
});

test("a scheduled monitor is a wake path, so the issue is not counted against the clause", () => {
  const withMonitor = board.map((issue) =>
    issue.id === "off-68" ? { ...issue, monitorNextCheckAt: "2026-09-02T03:00:00Z" } : issue,
  );
  const blocked = summarizeBlockedIssues(withMonitor);
  assert.equal(blocked.withoutBlockers, 2, "it still records no first class blocker");
  assert.equal(blocked.withoutWakePath, 1, "but the timer wakes it, so only OFF-55 is left");
  assert.equal(blocked.chainTerminalsWithoutWakePath, 0);
  assert.equal(blocked.strandedDependents, 0, "OFF-44 resumes when the timer fires");
});

test("the chain terminal and the dependents stranded behind it come out of the summary", () => {
  const blocked = summarizeBlockedIssues(board);
  assert.equal(blocked.chainTerminalsWithoutWakePath, 1);
  assert.equal(blocked.strandedDependents, 1);
  assert.equal(blocked.strandedIssueCount, 3, "OFF-68, OFF-44 and OFF-55 all cannot resume");
  assert.deepEqual(
    blocked.chainTerminals.map((terminal) => [
      terminal.identifier,
      terminal.strandedDependentIdentifiers,
    ]),
    [["OFF-68", ["OFF-44"]]],
  );
});

test("a chain whose terminal is still running is not reported as stranded", () => {
  const blocked = summarizeBlockedIssues(board);
  assert.equal(
    blocked.strandedIssues.some((issue) => issue.identifier === "OFF-62"),
    false,
  );
});

test("a stranded issue with no machine readable unblock owner is counted", () => {
  const blocked = summarizeBlockedIssues(board);
  assert.equal(blocked.strandedWithoutUnblockDescriptor, 3);

  const described = board.map((issue) =>
    issue.status === "blocked"
      ? {
          ...issue,
          unblockDescriptor: { owner: { agentId: "agent-1" }, action: "resize the pool and unblock" },
        }
      : issue,
  );
  assert.equal(summarizeBlockedIssues(described).strandedWithoutUnblockDescriptor, 0);
});

test("an unblock descriptor missing an owner or an action does not count as recorded", () => {
  const partial = board.map((issue) =>
    issue.id === "off-55" ? { ...issue, unblockDescriptor: { action: "someone does something" } } : issue,
  );
  assert.equal(summarizeBlockedIssues(partial).strandedWithoutUnblockDescriptor, 3);

  const empty = board.map((issue) =>
    issue.id === "off-55" ? { ...issue, unblockDescriptor: { owner: { agentId: "a" }, action: "  " } } : issue,
  );
  assert.equal(summarizeBlockedIssues(empty).strandedWithoutUnblockDescriptor, 3);
});

test("the window bounds the transition clause but not the chain reading", () => {
  const blocked = summarizeBlockedIssues(board, { since: "2026-09-02T01:50:00Z" });
  assert.equal(blocked.blockedIssuesInWindow, 1, "only OFF-68 entered blocked inside the window");
  assert.equal(blocked.withoutWakePath, 1);
  assert.equal(blocked.chainTerminalsWithoutWakePath, 1, "the chain is a fact about the board now");
  assert.equal(blocked.strandedDependents, 1);
});

test("a blocker cycle strands the issues in it rather than spinning the walk", () => {
  const cycle = [
    {
      id: "a",
      identifier: "OFF-A",
      status: "blocked",
      blockedBy: [{ id: "b", identifier: "OFF-B", status: "blocked" }],
    },
    {
      id: "b",
      identifier: "OFF-B",
      status: "blocked",
      blockedBy: [{ id: "a", identifier: "OFF-A", status: "blocked" }],
    },
  ];
  const blocked = summarizeBlockedIssues(cycle);
  assert.equal(blocked.strandedIssueCount, 2);
  assert.equal(blocked.blockerCycles > 0, true);
});

test("the three board clauses score off the summary and are not scored when the board is not read", () => {
  const cohort = {
    liveness: {
      terminatedRuns: 0,
      insideOutputRecencyGuard: { count: 0 },
      atOutputRecencyGuardBoundary: { count: 0 },
      recordedOutcome: { withoutOutcome: 0 },
      classes: {
        processLost: {
          runs: 0,
          massInstants: { windowCount: 0 },
          detectionLatencyMinutes: { count: 0, mean: null, maximum: null },
        },
      },
    },
  };

  const scored = scoreClauses(cohort, summarizeBlockedIssues(board));
  assert.equal(scored["issues blocked with no blocker"].number, 2);
  assert.equal(scored["issues blocked with no blocker"].pass, false);
  assert.equal(scored["issues blocked with no blocker"].chainTerminalsWithoutWakePath, 1);
  assert.equal(scored["issues blocked with no blocker"].strandedDependents, 1);
  assert.equal(scored["blocked chain terminals with no wake path"].number, 1);
  assert.equal(scored["blocked chain terminals with no wake path"].pass, false);
  assert.equal(scored["stranded blocked issues recording no unblock owner and action"].number, 3);
  assert.equal(scored["stranded blocked issues recording no unblock owner and action"].of, 3);

  const unread = scoreClauses(cohort, null);
  for (const name of [
    "issues blocked with no blocker",
    "blocked chain terminals with no wake path",
    "stranded blocked issues recording no unblock owner and action",
  ]) {
    assert.equal(unread[name].pass, null, `${name} scores null rather than passing by default`);
  }
});

test("a healthy board passes all three clauses", () => {
  const healthy = [
    {
      id: "off-62",
      identifier: "OFF-62",
      status: "blocked",
      blockedTransitionAt: "2026-09-02T01:30:00Z",
      blockedBy: [{ id: "off-66", identifier: "OFF-66", status: "in_progress" }],
      monitorNextCheckAt: null,
      unblockDescriptor: null,
    },
  ];
  const blocked = summarizeBlockedIssues(healthy);
  assert.equal(blocked.withoutWakePath, 0);
  assert.equal(blocked.chainTerminalsWithoutWakePath, 0);
  assert.equal(blocked.strandedIssueCount, 0);
  assert.equal(blocked.strandedWithoutUnblockDescriptor, 0);
});
