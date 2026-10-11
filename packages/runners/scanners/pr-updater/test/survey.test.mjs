/**
 * What the survey decides to do with each open pull request.
 *
 * These are regressions from live runs, not hypotheticals. A lower-priority signal used to hide a
 * failing build entirely; the requeue history used to be lost between passes; and every first
 * failure used to be assumed transient, which left an obvious lint break requeued in a loop and
 * never sent to anyone.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { survey, pass } from "../lib/pipeline.mjs";
import { surveyStatus } from "../lib/survey-status.mjs";
import { NOW, baseConfig, conflicted, fakeAdo, humanThread, scratch } from "./fixtures.mjs";

const open = { ...conflicted, mergeStatus: "succeeded" };
const other = { ...conflicted, id: "5626012", mergeStatus: "succeeded" };
const failing = { id: 7, name: "CI Build", evaluationId: "eval-7", result: "failed" };

test("infrastructure-only outages stay blocked across restart without repeated requeues or agent work", async () => {
  const requeued = [], config = baseConfig(scratch());
  let state = {};
  const blocked = { ...failing, failureKind: "infrastructure" };
  for (const id of [7, 77, 77]) {
    state = JSON.parse(JSON.stringify(state));
    const result = await pass({
      config, state, now: "2026-09-21T17:00:00Z",
      ado: fakeAdo({ prs: [open], builds: { [open.id]: [{ ...blocked, id }] }, requeued }),
      harness: {}, log: async () => {},
      options: { agentState: async () => ({ busy: false, status: "idle" }),
        runJob: async () => assert.fail("Infrastructure cancellation must not dispatch an agent") },
    });
    assert.equal(result.job, null);
    assert.equal(result.surveyed[0].send, null);
    const row = surveyStatus(result.surveyed, config)[0];
    assert.equal(row.build.state, "blocked");
    assert.match(row.dispatchHold, /CI infrastructure blocked/);
    assert.match(row.reason, /CI infrastructure blocked/);
    assert.equal(row.ready, false);
  }
  assert.deepEqual(requeued, ["eval-7"]);
  const recovered = await survey({ config, state, now: NOW,
    ado: fakeAdo({ prs: [open], builds: { [open.id]: [{ ...failing, id: 88, result: "succeeded" }] } }) });
  assert.equal(recovered[0].holdingReason, null);
  const codeFailure = await survey({ config, state, now: NOW,
    ado: fakeAdo({ prs: [open], builds: { [open.id]: [{ ...failing, id: 99 }] } }) });
  assert.equal(codeFailure[0].send.trigger, "build");
});

test("infrastructure cancellation does not suppress legitimate human feedback", async () => {
  const config = baseConfig(scratch());
  const rows = await survey({ config, state: {}, now: NOW,
    ado: fakeAdo({ prs: [open], builds: { [open.id]: [{ ...failing, failureKind: "infrastructure" }] },
      threads: { [open.id]: [humanThread("2026-03-01T11:00:00Z")] } }) });
  assert.equal(rows[0].send.trigger, "review");
  assert.equal(rows[0].holdingReason, null);
});
test("a draft pull request is never surveyed", async () => {
  const rows = await survey({
    config: baseConfig(scratch()),
    state: {},
    now: NOW,
    ado: fakeAdo({ prs: [{ ...conflicted, isDraft: true }] }),
  });
  assert.deepEqual(rows, []);
});

test("a failure on one branch alone escalates at once and is never requeued", async () => {
  const requeued = [];
  const state = {};
  const ado = fakeAdo({ prs: [open], builds: { [open.id]: [failing] }, requeued });

  const rows = await survey({ config: baseConfig(scratch()), state, now: NOW, ado });
  assert.deepEqual(requeued, [], "nothing suggests the pipeline is at fault, so retrying only delays the fix");
  assert.equal(rows[0].verdict.trigger, "build");
  assert.ok(rows[0].verdict.reason.includes("CI Build"));
});

test("a gate failing across branches is retried once per revision, then escalated", async () => {
  const requeued = [];
  const state = {};
  const builds = { [open.id]: [failing], [other.id]: [{ ...failing, id: 8, evaluationId: "eval-8" }] };
  const ado = fakeAdo({ prs: [open, other], builds, requeued });

  const first = await survey({ config: baseConfig(scratch()), state, now: NOW, ado });
  assert.deepEqual(requeued, ["eval-7", "eval-8"], "a fleet-wide failure is the pipeline, not the branch");
  assert.equal(first[0].verdict, null, "nobody is woken while the retry is pending");
  assert.deepEqual(state.builds[open.id], { commit: "abc", retried: { "eval-7": 7 } });

  // The retry produced a new build that failed again, which is attributable to the branch. The
  // ledger is keyed on the policy for exactly this reason: the build id changes every requeue.
  const reproduced = {
    [open.id]: [{ ...failing, id: 77 }],
    [other.id]: [{ ...failing, id: 88, evaluationId: "eval-8" }],
  };
  const second = await survey({
    config: baseConfig(scratch()),
    state,
    now: NOW,
    ado: fakeAdo({ prs: [open, other], builds: reproduced, requeued }),
  });
  assert.equal(requeued.length, 2, "a policy is only retried once per revision");
  assert.equal(second[0].verdict.trigger, "build");
});

test("a new revision clears the requeue history", async () => {
  const requeued = [];
  const state = { builds: { [open.id]: { commit: "old", retried: { "eval-7": 7 } } } };
  const builds = { [open.id]: [failing], [other.id]: [{ ...failing, id: 8, evaluationId: "eval-8" }] };
  await survey({
    config: baseConfig(scratch()),
    state,
    now: NOW,
    ado: fakeAdo({ prs: [open, other], builds, requeued }),
  });
  assert.ok(requeued.includes("eval-7"), "the failure is new code, so it has never been retried");
  assert.equal(state.builds[open.id].commit, "abc");
});

test("a failing build is not hidden by a comment that arrived first", async () => {
  const rows = await survey({
    config: baseConfig(scratch()),
    state: {},
    now: NOW,
    ado: fakeAdo({
      prs: [open],
      threads: { [open.id]: [humanThread("2026-03-01T11:00:00.000Z")] },
      builds: { [open.id]: [failing] },
    }),
  });
  assert.equal(rows[0].verdict.trigger, "build", "a blocked gate outranks a comment");
});

test("a conflicted pull request costs no build lookup", async () => {
  let looked = 0;
  const ado = fakeAdo({ prs: [conflicted] });
  ado.listBuilds = async () => {
    looked += 1;
    return [];
  };
  const rows = await survey({ config: baseConfig(scratch()), state: {}, now: NOW, ado });
  assert.equal(looked, 0, "nothing can merge until the conflict is resolved");
  assert.equal(rows[0].verdict.trigger, "conflict");
});

test("sharding only marks send for pull requests matching the runner's shard index", async () => {
  const prEven = { ...conflicted, id: "5688414" }; // 5688414 % 2 === 0
  const prOdd = { ...conflicted, id: "5678017" }; // 5678017 % 2 === 1

  const configShard0 = { ...baseConfig(scratch()), shard: { index: 0, total: 2 } };
  const configShard1 = { ...baseConfig(scratch()), shard: { index: 1, total: 2 } };

  const ado = fakeAdo({ prs: [prEven, prOdd] });

  const rowsShard0 = await survey({ config: configShard0, state: {}, now: NOW, ado });
  assert.ok(rowsShard0.find((r) => r.pr.id === "5688414").send !== null, "even PR is actionable on shard 0");
  assert.equal(rowsShard0.find((r) => r.pr.id === "5678017").send, null, "odd PR is skipped on shard 0");

  const rowsShard1 = await survey({ config: configShard1, state: {}, now: NOW, ado });
  assert.equal(rowsShard1.find((r) => r.pr.id === "5688414").send, null, "even PR is skipped on shard 1");
  assert.ok(rowsShard1.find((r) => r.pr.id === "5678017").send !== null, "odd PR is actionable on shard 1");
});
