import test from "node:test";
import assert from "node:assert/strict";

import { computeHealth, summarizeChains, readAbandonmentReason } from "../tools/heartbeat-health/health.js";

/**
 * Chains a reader can check by eye, so the chain numbers are pinned against rows rather than against
 * a rerun of the collector.
 *
 * c1 is one attempt that finished cleanly. c2 lost twice and stopped at the cap, which is an
 * abandoned chain. c3 lost once and its retry succeeded, which is a chain the policy saved. c4 lost
 * and carries a scheduled retry, so nothing about it is settled yet. c5 is still running. c6 lost,
 * stopped below the cap and recorded why, which is an abandoned chain that is at least legible.
 */
const rows = [
  {
    id: "c1",
    agentId: "agent-one",
    startedAt: "2026-09-01T23:00:00Z",
    finishedAt: "2026-09-01T23:10:00Z",
    status: "succeeded",
    processLossRetryCount: 0,
  },
  {
    id: "c2",
    agentId: "agent-two",
    startedAt: "2026-09-01T23:00:00Z",
    finishedAt: "2026-09-01T23:05:00Z",
    status: "failed",
    error: "Process lost -- child pid 100 is no longer running",
    processLossRetryCount: 0,
  },
  {
    id: "c2-retry",
    agentId: "agent-two",
    retryOfRunId: "c2",
    startedAt: "2026-09-01T23:06:00Z",
    finishedAt: "2026-09-01T23:11:00Z",
    status: "failed",
    error: "Process lost -- child pid 101 is no longer running",
    processLossRetryCount: 1,
  },
  {
    id: "c3",
    agentId: "agent-three",
    startedAt: "2026-09-01T23:00:00Z",
    finishedAt: "2026-09-01T23:04:00Z",
    status: "failed",
    error: "Process lost -- child pid 102 is no longer running",
    processLossRetryCount: 0,
  },
  {
    id: "c3-retry",
    agentId: "agent-three",
    retryOfRunId: "c3",
    startedAt: "2026-09-01T23:05:00Z",
    finishedAt: "2026-09-01T23:20:00Z",
    status: "succeeded",
    processLossRetryCount: 1,
  },
  {
    id: "c4",
    agentId: "agent-four",
    startedAt: "2026-09-01T23:00:00Z",
    finishedAt: "2026-09-01T23:07:00Z",
    status: "failed",
    error: "Process lost -- child pid 103 is no longer running",
    processLossRetryCount: 0,
    scheduledRetryAt: "2026-09-01T23:09:00Z",
  },
  {
    id: "c5",
    agentId: "agent-five",
    startedAt: "2026-09-01T23:00:00Z",
    status: "running",
    processLossRetryCount: 0,
  },
  {
    id: "c6",
    agentId: "agent-six",
    startedAt: "2026-09-01T23:00:00Z",
    finishedAt: "2026-09-01T23:08:00Z",
    status: "failed",
    error: "Process lost -- child pid 104 is no longer running",
    processLossRetryCount: 0,
    abandonmentReason: "supervisor stopped retrying after the agent was paused",
  },
];

test("the chain population is the wake, not the attempt", () => {
  const chains = summarizeChains(rows);

  assert.equal(chains.rows, 8);
  assert.equal(chains.chains, 6);
  assert.equal(chains.detachedChains, 0);
  assert.equal(chains.branchedChains, 0);
  assert.equal(chains.unreachableRows, 0);
  assert.equal(chains.attempts.maximum, 2);
  assert.equal(chains.attempts.mean, 1.33);
});

test("a chain with a run still going and a chain with a retry scheduled are both unsettled", () => {
  const chains = summarizeChains(rows);

  assert.equal(chains.runningChains, 1);
  assert.equal(chains.awaitingRetryChains, 1);
  assert.equal(chains.settledChains, 4);
});

test("an abandoned chain is a settled chain whose last run was lost and never retried", () => {
  const chains = summarizeChains(rows);

  assert.equal(chains.abandonedChains, 2);
  assert.equal(chains.abandonedShare, 50);
  assert.deepEqual(
    chains.abandonedChainDetail.map((entry) => entry.terminalId),
    ["c6", "c2-retry"],
  );
  assert.deepEqual(
    chains.byOutcome.map((entry) => `${entry.count} ${entry.key}`),
    ["2 lost", "2 succeeded"],
  );
});

test("the cap and the reason column separate a policy that stopped from one that ran out", () => {
  const chains = summarizeChains(rows);

  assert.equal(chains.retryCountCap, 1);
  assert.equal(chains.abandonedAtRetryCountCap, 1);
  assert.equal(chains.abandonedWithRecordedReason, 1);
  assert.equal(chains.abandonedWithoutRecordedReason, 1);
  assert.equal(readAbandonmentReason(rows[7]), "supervisor stopped retrying after the agent was paused");
  assert.equal(readAbandonmentReason(rows[2]), null);
});

test("a chain that finished is scored on the run the chain ended with", () => {
  const chains = summarizeChains(rows);

  assert.equal(chains.succeededChains, 2);
  assert.equal(chains.succeededShare, 50);
});

test("a run whose root is outside the read is one chain rather than none", () => {
  const chains = summarizeChains([
    {
      id: "late-retry",
      retryOfRunId: "before-the-window",
      startedAt: "2026-09-01T23:30:00Z",
      finishedAt: "2026-09-01T23:35:00Z",
      status: "succeeded",
    },
  ]);

  assert.equal(chains.chains, 1);
  assert.equal(chains.detachedChains, 1);
  assert.equal(chains.settledChains, 1);
  assert.equal(chains.succeededChains, 1);
});

test("an empty read scores no chain clause by default", () => {
  const chains = summarizeChains([]);

  assert.equal(chains.chains, 0);
  assert.equal(chains.abandonedShare, null);
  assert.equal(chains.succeededShare, null);
  assert.equal(chains.retryCountCap, null);
});

test("the chain clauses come out of the same command as the row clauses", () => {
  const clauses = computeHealth(rows, { since: null }).clauses;

  const abandonment = clauses["settled wake chains abandoned with no further attempt"];
  assert.equal(abandonment.number, 50);
  assert.equal(abandonment.of, 4);
  assert.equal(abandonment.target, 5);
  assert.equal(abandonment.pass, false);

  const cap = clauses["chains abandoned at the retry count cap while loss is above its target"];
  assert.equal(cap.number, 1);
  assert.equal(cap.pass, false);

  const reason = clauses["abandoned chains with no recorded reason"];
  assert.equal(reason.number, 1);
  assert.equal(reason.pass, false);

  const succeeded = clauses["succeeded share of settled wake chains"];
  assert.equal(succeeded.number, 50);
  assert.equal(succeeded.target, 57);
  assert.equal(succeeded.pass, false);
});

test("the cap clause is not scored against a repair it does not own once loss is rare", () => {
  const quiet = [];
  for (let index = 0; index < 40; index += 1) {
    quiet.push({
      id: `q${index}`,
      agentId: "agent-quiet",
      startedAt: "2026-09-01T23:00:00Z",
      finishedAt: "2026-09-01T23:05:00Z",
      status: "succeeded",
      processLossRetryCount: 0,
    });
  }
  quiet.push({
    id: "q-lost",
    agentId: "agent-quiet",
    startedAt: "2026-09-01T23:00:00Z",
    finishedAt: "2026-09-01T23:05:00Z",
    status: "failed",
    error: "Process lost -- child pid 900 is no longer running",
    processLossRetryCount: 1,
  });

  const clauses = computeHealth(quiet, { since: null }).clauses;
  const cap = clauses["chains abandoned at the retry count cap while loss is above its target"];

  assert.equal(clauses["process lost share"].pass, true);
  assert.equal(cap.number, 1);
  assert.equal(cap.pass, true);
});
