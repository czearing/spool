import test from "node:test";
import assert from "node:assert/strict";

import {
  computeHealth,
  summarizeCohort,
  summarizeLiveness,
  summarizeBlockedIssues,
  classifyTermination,
  isProcessLost,
  normalizeErrorSignature,
  scoreClauses,
} from "../tools/heartbeat-health/health.js";
import { createRunsSource } from "../tools/heartbeat-health/runs-source.js";

const rows = [
  {
    startedAt: "2026-09-01T21:00:00Z",
    finishedAt: "2026-09-01T21:10:00Z",
    status: "succeeded",
    error: null,
  },
  {
    startedAt: "2026-09-01T21:30:00Z",
    lastOutputAt: "2026-09-01T21:45:00Z",
    status: "failed",
    error: "Process lost while running heartbeat 41f0c2aa-1111-2222-3333-444455556666",
  },
  {
    startedAt: "2026-09-01T22:39:16Z",
    finishedAt: "2026-09-01T22:59:16Z",
    status: "succeeded",
    error: null,
  },
  {
    startedAt: "2026-09-01T23:00:00Z",
    finishedAt: "2026-09-01T23:05:00Z",
    status: "failed",
    error: "Adapter exited with code 7",
  },
  { startedAt: null, status: "queued", error: null },
];

test("a lost run is recognised by its error text whatever the case", () => {
  assert.equal(isProcessLost({ error: "Process lost" }), true);
  assert.equal(isProcessLost({ error: "process LOST after 4 minutes" }), true);
  assert.equal(isProcessLost({ error: "Adapter exited with code 7" }), false);
  assert.equal(isProcessLost({ error: null }), false);
});

test("an error signature drops the identifiers a renamed class would hide behind", () => {
  const first = normalizeErrorSignature(
    "Process lost for run 41f0c2aa-1111-2222-3333-444455556666 at 2026-09-01T21:45:00Z pid 8123",
  );
  const second = normalizeErrorSignature(
    "Process lost for run 99990000-aaaa-bbbb-cccc-ddddeeeeffff at 2026-09-02T04:12:00Z pid 91",
  );
  assert.equal(first, second);
  assert.equal(normalizeErrorSignature(""), null);
  assert.equal(normalizeErrorSignature(null), null);
});

test("a cohort reports all four fields off recorded columns only", () => {
  const cohort = summarizeCohort(rows);
  assert.equal(cohort.startedRuns, 4);
  assert.equal(cohort.processLostRuns, 1);
  assert.equal(cohort.processLostShare, 25);
  assert.equal(cohort.finishedRuns, 3);
  assert.equal(cohort.succeededRuns, 2);
  assert.equal(cohort.succeededShare, 66.7);
  assert.equal(cohort.finishedRunMinutes, 35);
  assert.equal(cohort.lostRunMinutes, 15);
  assert.equal(cohort.discardedShare, 30);
  assert.deepEqual(cohort.errorSignatures.map((entry) => entry.count), [1, 1]);
});

test("a lost run with no later timestamp contributes no guessed minutes", () => {
  const cohort = summarizeCohort([
    { startedAt: "2026-09-01T21:00:00Z", status: "failed", error: "Process lost" },
  ]);
  assert.equal(cohort.lostRunMinutes, 0);
  assert.equal(cohort.finishedRuns, 0);
  assert.equal(cohort.discardedShare, null);
});

test("no cutoff reports the whole history as one window", () => {
  const health = computeHealth(rows);
  assert.equal(health.query.since, null);
  assert.equal(health.window.startedRuns, 4);
  assert.equal(health.undatedRuns, 1);
  assert.equal(health.before, undefined);
});

test("a cutoff splits the cohorts and the cutoff instant itself lands after", () => {
  const health = computeHealth(rows, { since: "2026-09-01T22:39:16Z" });
  assert.equal(health.query.since, "2026-09-01T22:39:16.000Z");
  assert.equal(health.before.startedRuns, 2);
  assert.equal(health.before.processLostRuns, 1);
  assert.equal(health.after.startedRuns, 2);
  assert.equal(health.after.processLostRuns, 0);
  assert.equal(health.after.finishedRuns, 2);
});

test("the split is the same on a host whose local time is not utc", () => {
  const utc = JSON.stringify(computeHealth(rows, { since: "2026-09-01T22:39:16Z" }));
  const original = process.env.TZ;
  for (const zone of ["America/Los_Angeles", "Asia/Tokyo", "Europe/Berlin"]) {
    process.env.TZ = zone;
    assert.equal(JSON.stringify(computeHealth(rows, { since: "2026-09-01T22:39:16Z" })), utc, zone);
  }
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

test("two runs against unchanged history return byte identical records", () => {
  const options = { since: "2026-09-01T22:39:16Z" };
  assert.equal(
    JSON.stringify(computeHealth(rows, options)),
    JSON.stringify(computeHealth(rows, options)),
  );
});

test("a cutoff with no offset is read as utc rather than as local time", () => {
  const withZ = computeHealth(rows, { since: "2026-09-01T22:39:16Z" });
  const without = computeHealth(rows, { since: "2026-09-01T22:39:16" });
  assert.equal(JSON.stringify(without), JSON.stringify(withZ));
});

test("an agent filter narrows the rows before the split", () => {
  const health = computeHealth(
    [
      { startedAt: "2026-09-01T21:00:00Z", agentId: "a", status: "succeeded" },
      { startedAt: "2026-09-01T21:00:00Z", agentId: "b", status: "succeeded" },
    ],
    { agentId: "a" },
  );
  assert.equal(health.query.rows, 1);
  assert.equal(health.window.startedRuns, 1);
});

test("the runs source reads the existing endpoint and needs no server change", async () => {
  const seen = [];
  const source = createRunsSource({
    baseUrl: "https://example.test/",
    apiKey: "key",
    companyId: "co",
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify({ runs: rows }) };
    },
  });
  const read = await source.readRuns({ limit: 60 });
  assert.equal(read.length, rows.length);
  assert.equal(seen[0].url, "https://example.test/api/companies/co/heartbeat-runs?limit=60");
  assert.equal(seen[0].init.headers.Authorization, "Bearer key");
});

test("a failed endpoint read throws rather than reporting an empty history", async () => {
  const source = createRunsSource({
    baseUrl: "https://example.test",
    apiKey: "key",
    companyId: "co",
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "boom" }),
  });
  await assert.rejects(() => source.readRuns(), /failed with 500/);
  assert.throws(() => createRunsSource({ apiKey: "k", companyId: "c" }), /base url/);
});

const livenessRows = [
  {
    id: "b1",
    agentId: "agent-one",
    startedAt: "2026-09-01T23:00:00Z",
    finishedAt: "2026-09-01T23:05:52.418Z",
    lastOutputAt: "2026-09-01T23:05:33.218Z",
    status: "failed",
    errorCode: "orphaned_running_run",
    error: "run terminalized by recovery backstop: process and sandbox gone",
  },
  {
    id: "b2",
    agentId: "agent-two",
    startedAt: "2026-09-01T23:00:00Z",
    finishedAt: "2026-09-01T23:05:52.902Z",
    lastOutputAt: "2026-09-01T23:03:11.000Z",
    status: "failed",
    errorCode: "orphaned_running_run",
    error: "run terminalized by recovery backstop: process and sandbox gone",
  },
  {
    id: "b3",
    agentId: "agent-two",
    startedAt: "2026-09-01T23:00:00Z",
    finishedAt: "2026-09-01T23:13:01.100Z",
    lastOutputAt: null,
    status: "failed",
    errorCode: "orphaned_running_run",
    error: "run terminalized by recovery backstop: process and sandbox gone",
  },
  {
    id: "p1",
    agentId: "agent-three",
    startedAt: "2026-09-01T22:50:00Z",
    finishedAt: "2026-09-01T23:15:00.000Z",
    lastOutputAt: "2026-09-01T23:04:39.545Z",
    status: "failed",
    errorCode: "process_lost",
    error: "Process lost -- child pid 51800 is no longer running; retrying once",
  },
  {
    id: "p2",
    agentId: "agent-four",
    startedAt: "2026-09-01T22:50:00Z",
    finishedAt: "2026-09-01T23:30:00.000Z",
    lastOutputAt: "2026-09-01T22:41:00.000Z",
    status: "failed",
    errorCode: "process_lost",
    error: "Process lost -- child pid 47612 is no longer running",
  },
  {
    id: "c1",
    agentId: "agent-one",
    startedAt: "2026-09-01T23:00:00Z",
    finishedAt: "2026-09-01T23:04:00Z",
    lastOutputAt: "2026-09-01T23:03:59Z",
    status: "succeeded",
    error: null,
  },
];

test("a run ended by itself carries no liveness question and a run ended by something else does", () => {
  assert.equal(classifyTermination(livenessRows[0]), "backstop");
  assert.equal(classifyTermination(livenessRows[3]), "processLost");
  assert.equal(classifyTermination(livenessRows[5]), "clean");
  assert.equal(classifyTermination({ finishedAt: "2026-09-01T23:00:00Z", error: "Adapter exited with code 7" }), "error");
  assert.equal(classifyTermination({ startedAt: "2026-09-01T23:00:00Z", finishedAt: null }), null);
});

test("the quiet gap at termination is reported per run with no arithmetic left to the caller", () => {
  const liveness = summarizeLiveness(livenessRows);
  assert.equal(liveness.terminatedRuns, 5);
  const byId = Object.fromEntries(liveness.runs.map((entry) => [entry.id, entry]));
  assert.equal(byId.b1.quietGapMinutes, 0.32);
  assert.equal(byId.b1.insideOutputRecencyGuard, true);
  assert.equal(byId.b3.quietGapMinutes, null);
  assert.equal(byId.b3.hadOutput, false);
  assert.equal(byId.p1.quietGapMinutes, 10.34);
  assert.equal(byId.p1.insideOutputRecencyGuard, false);
  assert.equal(liveness.runs.some((entry) => entry.id === "c1"), false);
});

test("the guard count, the share and the runs with no output are reported per class", () => {
  const backstop = summarizeLiveness(livenessRows).classes.backstop;
  assert.equal(backstop.runs, 3);
  assert.equal(backstop.insideOutputRecencyGuard.count, 2);
  assert.equal(backstop.insideOutputRecencyGuard.share, 66.7);
  assert.equal(backstop.noOutputRuns, 1);
  assert.equal(backstop.quietGapMinutes.minimum, 0.32);
  assert.equal(backstop.quietGapMinutes.maximum, 2.7);
});

test("terminations land on instants with a run count and a distinct agent count", () => {
  const instants = summarizeLiveness(livenessRows).classes.backstop.terminationInstants;
  assert.deepEqual(instants, [
    { instant: "2026-09-01T23:05:52.000Z", runs: 2, agents: 2 },
    { instant: "2026-09-01T23:13:01.000Z", runs: 1, agents: 1 },
  ]);
});

test("a lost run is correlated to the backstop instant it died beside", () => {
  const correlation = summarizeLiveness(livenessRows).classes.processLost.correlatedToBackstopInstants;
  assert.equal(correlation.toleranceMinutes, 2);
  assert.equal(correlation.of, 2);
  assert.equal(correlation.count, 1);
  assert.equal(correlation.share, 50);
});

test("the board side clause counts blocked issues that nothing blocks", () => {
  const issues = [
    { id: "1", identifier: "OFF-60", status: "blocked", blockedTransitionAt: "2026-09-01T23:13:33Z", blockedBy: [] },
    { id: "2", identifier: "OFF-50", status: "blocked", blockedTransitionAt: "2026-09-01T22:00:00Z", blockedBy: [] },
    { id: "3", identifier: "OFF-51", status: "blocked", blockedTransitionAt: "2026-09-01T23:17:22Z", blockedBy: [{ id: "9" }] },
    { id: "4", identifier: "OFF-62", status: "in_progress", blockedTransitionAt: null, blockedBy: [] },
  ];
  const summary = summarizeBlockedIssues(issues, { since: "2026-09-01T22:39:16Z" });
  assert.equal(summary.blockedIssues, 3);
  assert.equal(summary.blockedIssuesInWindow, 2);
  assert.equal(summary.withoutBlockers, 1);
  assert.deepEqual(summary.issues.map((issue) => issue.identifier), ["OFF-60"]);
});

test("a clause with no data behind it scores null rather than passing by default", () => {
  const health = computeHealth(livenessRows, { since: "2026-09-01T22:39:16Z" });
  assert.equal(health.blocked, null);
  assert.equal(health.clauses["issues blocked with no blocker"].pass, null);
  assert.equal(health.clauses["terminated runs inside the output recency guard"].number, 2);
  assert.equal(health.clauses["terminated runs inside the output recency guard"].pass, false);
});

test("the liveness fields keep the four aggregate fields intact and travel with each cohort", () => {
  const health = computeHealth(livenessRows, { since: "2026-09-01T23:00:00Z", issues: [] });
  assert.equal(health.before.startedRuns, 2);
  assert.equal(health.after.startedRuns, 4);
  assert.equal(health.after.liveness.classes.backstop.runs, 3);
  assert.equal(health.before.liveness.classes.processLost.runs, 2);
  assert.equal(health.blocked.withoutBlockers, 0);
  assert.equal(health.clauses["issues blocked with no blocker"].pass, true);
});

test("the liveness fields are unchanged on a host whose local time is not utc", () => {
  const options = { since: "2026-09-01T22:39:16Z" };
  const original = process.env.TZ;
  process.env.TZ = "UTC";
  const utc = JSON.stringify(computeHealth(livenessRows, options));
  for (const zone of ["Asia/Tokyo", "America/Los_Angeles"]) {
    process.env.TZ = zone;
    assert.equal(JSON.stringify(computeHealth(livenessRows, options)), utc, zone);
  }
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

test("a kill just past the guard is counted apart from one that is genuinely stale", () => {
  const liveness = summarizeLiveness(livenessRows);
  const byId = Object.fromEntries(liveness.runs.map((entry) => [entry.id, entry]));
  assert.equal(byId.p1.atOutputRecencyGuardBoundary, true);
  assert.equal(byId.p2.quietGapMinutes, 49);
  assert.equal(byId.p2.atOutputRecencyGuardBoundary, false);
  assert.equal(byId.b1.atOutputRecencyGuardBoundary, false);
  assert.equal(byId.b3.atOutputRecencyGuardBoundary, false);
  const processLost = liveness.classes.processLost;
  assert.equal(processLost.atOutputRecencyGuardBoundary.bandMinutes, 1);
  assert.equal(processLost.atOutputRecencyGuardBoundary.count, 1);
  assert.equal(processLost.atOutputRecencyGuardBoundary.share, 50);
  assert.equal(liveness.classes.backstop.atOutputRecencyGuardBoundary.count, 0);
});

test("a guard that only delays the same verdict fails a clause of its own", () => {
  const health = computeHealth(livenessRows, { since: "2026-09-01T22:39:16Z" });
  const clause = health.clauses["terminated runs pinned to the guard boundary"];
  assert.equal(clause.number, 1);
  assert.equal(clause.of, 5);
  assert.equal(clause.target, 0);
  assert.equal(clause.pass, false);
  const quiet = summarizeLiveness([livenessRows[4]]);
  assert.equal(quiet.atOutputRecencyGuardBoundary.count, 0);
  assert.equal(
    scoreClauses({ liveness: quiet }, null)["terminated runs pinned to the guard boundary"].pass,
    true,
  );
});
