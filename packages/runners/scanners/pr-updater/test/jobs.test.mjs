/**
 * One job from queue to close.
 *
 * The unit tests prove each decision in isolation; these prove the wiring, which is where every
 * observed outage actually lived. A pull request that classifies correctly and still never reaches
 * the agent is the failure mode this file exists to catch.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { pass, runJob } from "../lib/pipeline.mjs";
import { readJobs } from "../lib/telemetry.mjs";
import { NOW, baseConfig, conflicted, fakeAdo, idleHarness, scratch } from "./fixtures.mjs";

const verdict = { trigger: "conflict", reason: "merge conflict", fingerprint: "conflict:abc" };

/** A prepared workspace, without the 20 to 60 seconds a real one costs. */
const prepared = async () => ({
  branch: conflicted.branch,
  ms: 4200,
  steps: [{ name: "branch", ms: 4200 }],
  merge: { files: ["a.ts"] },
});

test("a job records queued, prepared and dispatched, and reaches the harness", async () => {
  const file = scratch();
  const sent = [];
  const result = await runJob({
    config: baseConfig(file),
    pr: conflicted,
    verdict,
    now: NOW,
    harness: { submitAgentTask: async (cfg, agent, body, id) => sent.push({ agent, body, id }) },
    log: async () => {},
    prepare: prepared,
  });

  assert.equal(result.dispatched, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].agent, "pr-updater");
  assert.equal(sent[0].id, "office-bohemia-repo-1:pr-updater:5622136:conflict-abc:0");
  assert.ok(sent[0].body.includes("5622136"));
  assert.ok(sent[0].body.includes("Conflicts: a.ts"));

  const jobs = readJobs(file);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, "dispatched");
  assert.equal(jobs[0].prId, "5622136");
  assert.equal(jobs[0].trigger, "conflict");
  assert.equal(jobs[0].setupMs, 4200, "the row keeps its preparation timing");
});

test("a preparation failure is recorded and nothing is dispatched", async () => {
  const file = scratch();
  const sent = [];
  const result = await runJob({
    config: baseConfig(file),
    pr: conflicted,
    verdict,
    now: NOW,
    harness: { submitAgentTask: async () => sent.push(1) },
    log: async () => {},
    prepare: async () => { throw new Error("clone is dirty"); },
  });

  assert.equal(result.dispatched, false);
  assert.deepEqual(sent, []);
  const [job] = readJobs(file);
  assert.equal(job.state, "failed");
  assert.equal(job.phase, "prepare");
  assert.equal(job.prId, "5622136", "a failed job still says which pull request it was for");
});

test("a harness that refuses the task is recorded rather than silently dropped", async () => {
  const file = scratch();
  const result = await runJob({
    config: baseConfig(file),
    pr: conflicted,
    verdict,
    now: NOW,
    harness: { submitAgentTask: async () => { throw new Error("harness is down"); } },
    log: async () => {},
    prepare: prepared,
  });
  assert.equal(result.dispatched, false);
  assert.equal(readJobs(file)[0].phase, "dispatch");
});

test("one pass queues exactly one pull request and will not re-send it", async () => {
  const file = scratch();
  const state = {};
  const sent = [];
  // The agent reports finished, so each pass is free to pick up the next pull request. Without a
  // completion the in-flight gate holds the queue, which is asserted in `in-flight.test.mjs`.
  const finished = { completedAt: NOW, outcome: "completed", text: "done" };
  const options = {
    config: baseConfig(file),
    state,
    now: NOW,
    ado: fakeAdo({ prs: [conflicted, { ...conflicted, id: "5626012" }] }),
    harness: {
      submitAgentTask: async (cfg, agent, body, id) => sent.push(id),
      getConversations: async () => finished,
    },
    log: async () => {},
    prepare: prepared,
    options: idleHarness,
  };

  const first = await pass(options);
  assert.equal(first.surveyed.length, 2);  assert.equal(sent.length, 1, "one clone means one job at a time");
  assert.equal(state.pullRequests["5622136"].fingerprint, "conflict:abc");

  // The second pass picks up the other pull request rather than repeating the first.
  await pass(options);
  assert.equal(sent.length, 2);
  assert.equal(state.pullRequests["5626012"].fingerprint, "conflict:abc");

  // A third finds nothing new to say.
  const third = await pass(options);
  assert.equal(sent.length, 2);
  assert.equal(third.job, null);
});

test("a completed conversation closes the job so it stops reading as stalled", async () => {
  const file = scratch();
  const options = {
    config: baseConfig(file),
    state: {},
    now: NOW,
    ado: fakeAdo({ prs: [conflicted] }),
    harness: {
      submitAgentTask: async () => {},
      getConversations: async () => ({ completedAt: "2026-03-01T12:30:00.000Z", outcome: "completed", text: "pushed a fix" }),
    },
    log: async () => {},
    prepare: prepared,
    options: idleHarness,
  };

  await pass(options);
  assert.equal(readJobs(file)[0].state, "dispatched");

  await pass(options);
  const job = readJobs(file)[0];
  assert.equal(job.state, "done");
  assert.equal(job.outcome, "completed");
  assert.equal(job.conversation, "pushed a fix");
  // Agent time runs from dispatch, not from the row's last activity, which every state change moves.
  assert.equal(job.agentMs, Date.parse(job.doneAt) - Date.parse(job.dispatchedAt));
  assert.equal(job.updateMs, Date.parse(job.doneAt) - Date.parse(NOW), "total time is measured from queueing");
  assert.notEqual(job.queuedAt, job.dispatchedAt, "each phase keeps its own stamp");
});
