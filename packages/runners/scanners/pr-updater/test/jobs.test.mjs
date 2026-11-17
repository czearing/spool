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
import { readJobs, jobFailed } from "../lib/telemetry.mjs";
import { NOW, baseConfig, conflicted, fakeAdo, idleHarness, scratch } from "./fixtures.mjs";

const verdict = { trigger: "conflict", reason: "merge conflict", fingerprint: "conflict:abc" };

/** A prepared workspace, without the 20 to 60 seconds a real one costs. */
const prepared = async () => ({
  branch: conflicted.branch,
  ms: 4200,
  steps: [{ name: "branch", ms: 4200 }],
  merge: { files: ["a.ts"] },
});

test("a live Codespace lease is a retryable hold, not an hour-long preparation failure", async () => {
  const file = scratch(), config = baseConfig(file);
  const options = { config, pr: conflicted, verdict, now: NOW,
    harness: { submitAgentTask: async () => {} }, log: async () => {} };
  const blocked = await runJob({ ...options, prepare: async () => {
    throw Object.assign(new Error("Workspace belongs to a live operation"), { code: "CODESPACE_WORKSPACE_BUSY" });
  } });
  assert.equal(blocked.skipped, true);
  assert.equal(readJobs(file)[0].state, "blocked");
  jobFailed(file, { jobId: blocked.jobId, at: NOW, phase: "prepare",
    error: new Error('Step "Repository" failed (CODESPACE_WORKSPACE_BUSY): another operation owns this Codespace') });
  const retried = await runJob({ ...options, prepare: prepared });
  assert.equal(retried.dispatched, true);
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
  assert.equal(result.reason, "clone is dirty");
  assert.deepEqual(sent, []);
  const [job] = readJobs(file);
  assert.equal(job.state, "failed");
  assert.equal(job.phase, "prepare");
  assert.equal(job.prId, "5622136", "a failed job still says which pull request it was for");
  const cooled = await runJob({
    config: baseConfig(file), pr: conflicted, verdict, now: NOW,
    harness: { submitAgentTask: async () => sent.push(1) },
    log: async () => {}, prepare: prepared,
  });
  assert.equal(cooled.dispatched, false);
  assert.match(cooled.reason, /clone is dirty/);
  assert.deepEqual(sent, []);
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
  assert.equal(result.reason, "harness is down");
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

test("independent creator admission does not limit a scan to one successful handoff", async () => {
  const state = {}, sent = [];
  const result = await pass({
    config: baseConfig(scratch()), state, now: NOW,
    ado: fakeAdo({ prs: [conflicted, { ...conflicted, id: "5626012" }, { ...conflicted, id: "5626013" }] }),
    harness: {}, log: async () => {},
    options: { independentTasks: true, runJob: async ({ pr }) => {
      if (pr.id === "5626012") return { dispatched: false, skipped: true, reason: "Original agent is busy" };
      sent.push(pr.id);
      return { dispatched: true, jobId: `creator:${pr.id}` };
    } },
  });
  assert.deepEqual(sent, ["5622136", "5626013"]);
  assert.equal(result.jobs.length, 2);
  assert.equal(result.surveyed[1].holdingReason, "Original agent is busy");
  assert.equal(state.pullRequests["5626012"], undefined);
  assert.equal(state.pullRequests["5626013"].jobId, "creator:5626013");
});

test("an independent handoff failure holds only that PR and continues the scan", async () => {
  const state = {}, visited = [], events = [];
  const failure = new Error("Checkout is dirty; original work preserved");
  const result = await pass({
    config: baseConfig(scratch()), state, now: NOW,
    ado: fakeAdo({ prs: [conflicted, { ...conflicted, id: "5626012" }] }),
    harness: {}, log: async (event, detail) => events.push({ event, ...detail }),
    options: { independentTasks: true, runJob: async ({ pr }) => {
      visited.push(pr.id);
      if (pr.id === conflicted.id) throw failure;
      return { dispatched: true, jobId: `creator:${pr.id}` };
    } },
  });
  assert.deepEqual(visited, [conflicted.id, "5626012"]);
  assert.equal(result.surveyed[0].holdingReason, failure.message);
  assert.ok(events.some(event => event.event === "creator_review_held" &&
    event.pr === conflicted.id && event.reason === failure.message));
  assert.equal(state.pullRequests[conflicted.id], undefined);
  assert.equal(state.pullRequests["5626012"].jobId, "creator:5626012");
  assert.equal(result.jobs.length, 1);
});

test("an unexpected handoff failure still aborts a non-independent scan", async () => {
  const failure = new Error("Unexpected handoff failure"), visited = [];
  await assert.rejects(pass({
    config: baseConfig(scratch()), state: {}, now: NOW,
    ado: fakeAdo({ prs: [conflicted, { ...conflicted, id: "5626012" }] }),
    harness: {}, log: async () => {},
    options: { ...idleHarness, runJob: async ({ pr }) => {
      visited.push(pr.id);
      throw failure;
    } },
  }), error => error === failure);
  assert.deepEqual(visited, [conflicted.id]);
});
