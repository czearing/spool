import assert from "node:assert/strict";
import test from "node:test";
import { survey, pass } from "../lib/pipeline.mjs";
import { surveyStatus } from "../lib/survey-status.mjs";
import { NOW, baseConfig, conflicted, fakeAdo, humanThread, scratch } from "./fixtures.mjs";

const open = { ...conflicted, mergeStatus: "succeeded", votes: [10] };
const missing = { id: 55693221, name: "Buddy Build", evaluationId: "missing-policy",
  result: "failed", failureKind: "unavailable", failureReason: "Build evidence is unavailable (404)." };

test("unavailable evidence holds the rejected policy without requeue or agent dispatch, including after restart", async () => {
  const config = baseConfig(scratch()), requeued = [];
  let state = {};
  for (let attempt = 0; attempt < 2; attempt++) {
    state = JSON.parse(JSON.stringify(state));
    const result = await pass({ config, state, now: NOW,
      ado: fakeAdo({ prs: [open], builds: { [open.id]: [missing] }, requeued }),
      harness: {}, log: async () => {},
      options: { agentState: async () => ({ busy: false, status: "idle" }),
        runJob: async () => assert.fail("Missing evidence cannot dispatch a repair") } });
    assert.equal(result.job, null);
    assert.equal(result.surveyed[0].send, null);
    const row = surveyStatus(result.surveyed, config)[0];
    assert.equal(row.ready, false);
    assert.equal(row.build.state, "failed");
    assert.match(row.reason, /CI evidence unavailable/);
    assert.match(row.dispatchHold, /No code-repair dispatch/);
  }
  assert.deepEqual(requeued, []);
});

test("missing evidence neither aborts other PRs nor makes their real failures look fleet-wide", async () => {
  const config = baseConfig(scratch()), requeued = [];
  const other = { ...open, id: "5626012" };
  const realFailure = { id: 42, name: missing.name, evaluationId: "real-policy", result: "failed" };
  const rows = await survey({ config, state: {}, now: NOW, ado: fakeAdo({
    prs: [open, other], builds: { [open.id]: [missing], [other.id]: [realFailure] }, requeued,
  }) });
  assert.equal(rows[0].send, null);
  assert.equal(rows[1].send.trigger, "build");
  assert.deepEqual(requeued, []);
});

test("a PR with unavailable build evidence still receives legitimate human feedback", async () => {
  const config = baseConfig(scratch()), requeued = [];
  const rows = await survey({ config, state: {}, now: NOW, ado: fakeAdo({
    prs: [open], builds: { [open.id]: [missing] },
    threads: { [open.id]: [humanThread("2026-03-01T11:00:00Z")] }, requeued,
  }) });
  assert.equal(rows[0].send.trigger, "review");
  assert.equal(rows[0].holdingReason, null);
  assert.deepEqual(requeued, []);
});
