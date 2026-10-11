import test from "node:test";
import assert from "node:assert/strict";

import {
  computeHealth,
  summarizeCohort,
  summarizeLiveness,
  summarizeRetries,
  summarizePerAgentLoss,
  massInstants,
} from "../tools/heartbeat-health/health.js";

/**
 * The six per run fields an acceptance clause is written in. Each was measured by hand twice before it
 * became a collector field, so each is pinned here against numbers that can be checked by reading the
 * rows rather than by rerunning the collector.
 */
const rows = [
  {
    id: "l1",
    agentId: "agent-one",
    startedAt: "2026-09-01T23:00:00Z",
    lastOutputAt: "2026-09-01T23:03:00Z",
    finishedAt: "2026-09-01T23:15:00Z",
    status: "failed",
    errorCode: "process_lost",
    error: "Process lost -- child pid 100 is no longer running",
    processLossRetryCount: 1,
  },
  {
    id: "l2",
    agentId: "agent-two",
    startedAt: "2026-09-01T23:01:00Z",
    lastOutputAt: "2026-09-01T23:03:30Z",
    finishedAt: "2026-09-01T23:16:00Z",
    status: "failed",
    errorCode: "process_lost",
    error: "Process lost -- child pid 101 is no longer running",
    processLossRetryCount: 1,
  },
  {
    id: "l3",
    agentId: "agent-three",
    startedAt: "2026-09-01T23:02:00Z",
    lastOutputAt: "2026-09-01T23:03:50Z",
    finishedAt: "2026-09-01T23:24:00Z",
    status: "failed",
    errorCode: "process_lost",
    error: "Process lost -- child pid 102 is no longer running",
    processLossRetryCount: 0,
  },
  {
    id: "l4",
    agentId: "agent-one",
    startedAt: "2026-09-01T23:20:00Z",
    lastOutputAt: "2026-09-01T23:29:00Z",
    finishedAt: "2026-09-01T23:41:00Z",
    status: "failed",
    errorCode: "process_lost",
    error: "Process lost -- child pid 103 is no longer running",
    retryOfRunId: "l1",
    processLossRetryCount: 1,
  },
  {
    id: "r1",
    agentId: "agent-two",
    startedAt: "2026-09-01T23:20:00Z",
    lastOutputAt: "2026-09-01T23:34:00Z",
    finishedAt: "2026-09-01T23:35:00Z",
    status: "succeeded",
    error: null,
    retryOfRunId: "l2",
    processLossRetryCount: 1,
  },
  {
    id: "s1",
    agentId: "agent-four",
    startedAt: "2026-09-01T23:05:00Z",
    lastOutputAt: "2026-09-01T23:09:00Z",
    finishedAt: "2026-09-01T23:10:00Z",
    status: "succeeded",
    error: null,
    processLossRetryCount: 0,
  },
];

test("silence instants carry a run count and a distinct agent count per minute", () => {
  const lost = summarizeLiveness(rows).classes.processLost.massInstants;
  assert.equal(lost.bucketSeconds, 60);
  assert.equal(lost.instantCount, 2);
  assert.deepEqual(lost.instants, [
    { instant: "2026-09-01T23:03:00.000Z", runs: 3, agents: 3 },
    { instant: "2026-09-01T23:29:00.000Z", runs: 1, agents: 1 },
  ]);
  assert.equal(lost.windowCount, 1);
  assert.equal(lost.runsInWindows, 3);
  assert.equal(lost.largestWindowAgents, 3);
});

test("a run with no last output is counted apart rather than dropped from the instants", () => {
  const summary = massInstants([
    { lastOutputAt: "2026-09-01T23:03:00.000Z", agentId: "agent-one" },
    { lastOutputAt: null, agentId: "agent-two" },
  ]);
  assert.equal(summary.runsWithNoLastOutput, 1);
  assert.equal(summary.instantCount, 1);
  assert.equal(summary.instants[0].runs, 1);
});

test("exit status coverage separates an exit code from a signal and from neither", () => {
  const outcome = summarizeLiveness([
    ...rows,
    {
      id: "e1",
      agentId: "agent-five",
      startedAt: "2026-09-01T23:00:00Z",
      lastOutputAt: "2026-09-01T23:01:00Z",
      finishedAt: "2026-09-01T23:02:00Z",
      status: "failed",
      error: "Adapter exited",
      exitCode: 7,
    },
    {
      id: "e2",
      agentId: "agent-five",
      startedAt: "2026-09-01T23:00:00Z",
      lastOutputAt: "2026-09-01T23:01:00Z",
      finishedAt: "2026-09-01T23:02:30Z",
      status: "failed",
      error: "Adapter killed",
      signal: "SIGKILL",
    },
  ]).recordedOutcome;
  assert.equal(outcome.withExitCode, 1);
  assert.equal(outcome.withSignal, 1);
  assert.equal(outcome.of, 6);
  const lost = summarizeLiveness(rows).classes.processLost.recordedOutcome;
  assert.equal(lost.withExitCode, 0);
  assert.equal(lost.withSignal, 0);
  assert.equal(lost.of, 4);
});

test("productive lifetime is the start to last output span with a mean and a maximum", () => {
  const lifetime = summarizeLiveness(rows).classes.processLost.productiveLifetimeMinutes;
  assert.equal(lifetime.count, 4);
  assert.equal(lifetime.missing, 0);
  assert.equal(lifetime.minimum, 1.83);
  assert.equal(lifetime.maximum, 9);
  assert.equal(lifetime.mean, 4.08);
});

test("detection latency reports a mean, a minimum, a maximum and a total", () => {
  const latency = summarizeLiveness(rows).classes.processLost.detectionLatencyMinutes;
  assert.equal(latency.count, 4);
  assert.equal(latency.minimum, 12);
  assert.equal(latency.maximum, 20.17);
  assert.equal(latency.mean, 14.17);
  assert.equal(latency.total, 56.67);
});

test("a spread is rounded once at the end, not summed from rounded parts", () => {
  const drifting = [
    {
      id: "d1",
      agentId: "agent-one",
      startedAt: "2026-09-01T23:00:00Z",
      lastOutputAt: "2026-09-01T23:01:00Z",
      finishedAt: "2026-09-01T23:11:00.291Z",
      status: "failed",
      error: "Process lost",
    },
    {
      id: "d2",
      agentId: "agent-two",
      startedAt: "2026-09-01T23:00:00Z",
      lastOutputAt: "2026-09-01T23:01:00Z",
      finishedAt: "2026-09-01T23:11:00.291Z",
      status: "failed",
      error: "Process lost",
    },
  ];
  const latency = summarizeLiveness(drifting).classes.processLost.detectionLatencyMinutes;
  // Each run is 10.004850 minutes. Rounding each to 10.0 first and summing gives 20.0, which is not
  // the number the rows hold. The total has to come from the exact values and round once.
  assert.equal(latency.total, 20.01);
  assert.equal(latency.maximum, 10);
  assert.equal(latency.mean, 10);
});

test("a run with no last output leaves the latency and lifetime counts honest", () => {
  const liveness = summarizeLiveness([
    ...rows,
    {
      id: "n1",
      agentId: "agent-six",
      startedAt: "2026-09-01T23:00:00Z",
      finishedAt: "2026-09-01T23:20:00Z",
      status: "failed",
      errorCode: "process_lost",
      error: "Process lost -- child pid 104 is no longer running",
    },
  ]).classes.processLost;
  assert.equal(liveness.runs, 5);
  assert.equal(liveness.noOutputRuns, 1);
  assert.equal(liveness.detectionLatencyMinutes.count, 4);
  assert.equal(liveness.detectionLatencyMinutes.missing, 1);
  assert.equal(liveness.productiveLifetimeMinutes.missing, 1);
});

test("retry outcome splits the retries by status and counts the rows at the retry cap", () => {
  const retries = summarizeRetries(rows);
  assert.equal(retries.rows, 6);
  assert.equal(retries.retryRuns, 2);
  assert.deepEqual(retries.byStatus, [
    { key: "failed", count: 1 },
    { key: "succeeded", count: 1 },
  ]);
  assert.equal(retries.lostAgain, 1);
  assert.equal(retries.succeeded, 1);
  assert.equal(retries.retryCountCap, 1);
  assert.equal(retries.rowsAtRetryCountCap, 4);
});

test("a loss that was never retried is reported rather than counted as recovered", () => {
  const retries = summarizeRetries(rows);
  assert.equal(retries.lostRunsWithNoRetry, 2);
  assert.equal(retries.lostRunsWithNoRetryShare, 50);
});

test("per agent loss reports the share for every agent and the affected range", () => {
  const perAgent = summarizePerAgentLoss(rows);
  assert.equal(perAgent.agentCount, 4);
  assert.equal(perAgent.affectedAgentCount, 3);
  assert.deepEqual(perAgent.agents, [
    { agentId: "agent-one", startedRuns: 2, processLostRuns: 2, processLostShare: 100 },
    { agentId: "agent-three", startedRuns: 1, processLostRuns: 1, processLostShare: 100 },
    { agentId: "agent-two", startedRuns: 2, processLostRuns: 1, processLostShare: 50 },
    { agentId: "agent-four", startedRuns: 1, processLostRuns: 0, processLostShare: 0 },
  ]);
  assert.equal(perAgent.lowestAffectedShare, 50);
  assert.equal(perAgent.highestAffectedShare, 100);
});

test("an agent with no recorded id is kept under one name rather than dropped", () => {
  const perAgent = summarizePerAgentLoss([
    { startedAt: "2026-09-01T23:00:00Z", errorCode: "process_lost", error: "Process lost" },
    { startedAt: "2026-09-01T23:01:00Z", status: "succeeded", error: null },
  ]);
  assert.equal(perAgent.agentCount, 1);
  assert.equal(perAgent.agents[0].agentId, "unknown");
  assert.equal(perAgent.agents[0].startedRuns, 2);
  assert.equal(perAgent.agents[0].processLostRuns, 1);
});

test("all six fields come off one cohort with no arithmetic left to the caller", () => {
  const cohort = summarizeCohort(rows);
  const lost = cohort.liveness.classes.processLost;
  assert.ok(lost.massInstants.instantCount > 0);
  assert.equal(lost.recordedOutcome.withExitCode, 0);
  assert.ok(lost.productiveLifetimeMinutes.mean !== null);
  assert.ok(lost.detectionLatencyMinutes.total !== null);
  assert.ok(cohort.retries.retryRuns > 0);
  assert.ok(cohort.perAgentLoss.affectedAgentCount > 0);
});

test("the three loss clauses score off these fields and read fail on a losing cohort", () => {
  const clauses = computeHealth(rows).clauses;
  const windows = clauses["one minute windows losing runs from three or more agents"];
  const outcome = clauses["terminated runs with no recorded outcome"];
  const latency = clauses["detection latency on lost runs in minutes"];
  assert.equal(windows.number, 1);
  assert.equal(windows.target, 0);
  assert.equal(windows.pass, false);
  assert.equal(outcome.target, 0);
  assert.equal(latency.number, 14.17);
  assert.equal(latency.target, 5);
  assert.equal(latency.pass, false);
});

test("a named cause alone cannot pass the exit status clause", () => {
  const named = [
    {
      id: "n1",
      agentId: "agent-one",
      startedAt: "2026-09-01T23:00:00Z",
      lastOutputAt: "2026-09-01T23:01:00Z",
      finishedAt: "2026-09-01T23:20:00Z",
      status: "failed",
      error: "Process lost",
      livenessReason: "process_lost",
      exitCode: null,
      signal: null,
    },
  ];
  const clauses = computeHealth(named).clauses;
  assert.equal(clauses["terminated runs with no recorded outcome"].number, 0);
  assert.equal(clauses["terminated runs with no recorded outcome"].pass, true);
  const exitStatus = clauses["terminated runs with no exit status"];
  assert.equal(exitStatus.number, 1);
  assert.equal(exitStatus.of, 1);
  assert.equal(exitStatus.target, 0);
  assert.equal(exitStatus.pass, false);
});

test("an exit code satisfies the exit status clause", () => {
  const clauses = computeHealth([
    {
      id: "e1",
      agentId: "agent-one",
      startedAt: "2026-09-01T23:00:00Z",
      lastOutputAt: "2026-09-01T23:01:00Z",
      finishedAt: "2026-09-01T23:20:00Z",
      status: "failed",
      error: "Adapter exited with code 7",
      exitCode: 7,
    },
  ]).clauses;
  assert.equal(clauses["terminated runs with no exit status"].number, 0);
  assert.equal(clauses["terminated runs with no exit status"].pass, true);
});

test("the same three clauses read pass on a cohort that lost nothing", () => {
  const clean = [
    {
      id: "c1",
      agentId: "agent-one",
      startedAt: "2026-09-01T23:00:00Z",
      lastOutputAt: "2026-09-01T23:09:00Z",
      finishedAt: "2026-09-01T23:10:00Z",
      status: "succeeded",
      error: null,
      exitCode: 0,
    },
    {
      id: "c2",
      agentId: "agent-two",
      startedAt: "2026-09-01T23:00:00Z",
      lastOutputAt: "2026-09-01T23:07:00Z",
      finishedAt: "2026-09-01T23:08:00Z",
      status: "succeeded",
      error: null,
      exitCode: 0,
    },
  ];
  const clauses = computeHealth(clean).clauses;
  assert.equal(clauses["one minute windows losing runs from three or more agents"].pass, true);
  assert.equal(clauses["terminated runs with no recorded outcome"].pass, true);
  assert.equal(clauses["detection latency on lost runs in minutes"].pass, null);
});
