/**
 * The in-flight gate.
 *
 * There is one clone and one agent. Dispatching a second job while the first is mid-turn makes
 * `prepareRepo` reset and re-checkout the working tree underneath a running agent, destroying its
 * uncommitted work and pointing it at a different pull request than the one it was asked about.
 * This happened live, so the gate is asserted from the durable record rather than trusted.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { inFlight, pass } from "../lib/pipeline.mjs";
import * as telemetry from "../lib/telemetry.mjs";
import { NOW, baseConfig, conflicted, fakeAdo, harnessStatus, humanThread, idleHarness, scratch } from "./fixtures.mjs";

const reviewed = {
  id: "5634985",
  title: "Command bar",
  branch: "user/caleb/command-bar",
  mergeStatus: "succeeded",
  sourceCommit: "def",
  isDraft: false,
  url: "https://example/pr/5634985",
};

function harnessFake(sent, conversation = null) {
  return {
    submitAgentTask: async (config, agent, body, id) => sent.push(id),
    getConversations: async () => conversation,
  };
}

/** Commented an hour ago, so the ten minute quiet window has long since elapsed. */
const settled = humanThread(new Date(Date.parse(NOW) - 60 * 60_000).toISOString());

function scenario() {
  const file = scratch();
  const config = baseConfig(file);
  const ado = fakeAdo({ prs: [conflicted, reviewed], threads: { [reviewed.id]: [settled] } });
  return { file, config, ado, prepare: async () => ({ ms: 5, steps: [], branch: "b" }) };
}

test("a job in flight is reported from the telemetry record", () => {
  const file = scratch();
  telemetry.jobQueued(file, { jobId: "j1", prId: "1", trigger: "review", reason: "r", at: NOW });
  telemetry.jobDispatched(file, { jobId: "j1", at: NOW, agent: "pr-updater", submissionId: "j1" });
  assert.equal(inFlight({ telemetryFile: file })?.prId, "1");
});

test("a finished job leaves nothing in flight", () => {
  const file = scratch();
  telemetry.jobQueued(file, { jobId: "j1", prId: "1", trigger: "review", reason: "r", at: NOW });
  telemetry.jobDispatched(file, { jobId: "j1", at: NOW, agent: "pr-updater", submissionId: "j1" });
  telemetry.jobDone(file, { jobId: "j1", at: NOW, agentMs: 1, updateMs: 1, outcome: "completed" });
  assert.equal(inFlight({ telemetryFile: file }), null);
});

test("the second pass dispatches nothing while the first job is still running", async () => {
  const { config, ado, prepare } = scenario();
  const sent = [];
  const state = { pullRequests: {}, builds: {} };
  const options = idleHarness;

  const first = await pass({ config, state, now: NOW, ado, harness: harnessFake(sent), log: async () => {}, prepare, options });
  assert.equal(first.job.dispatched, true);
  assert.equal(sent.length, 1);

  const second = await pass({ config, state, now: NOW, ado, harness: harnessFake(sent), log: async () => {}, prepare, options });
  assert.equal(second.job, null, "no second job while one is in flight");
  assert.equal(second.busy.prId, conflicted.id);
  assert.equal(sent.length, 1, "the agent received exactly one task");
});

test("independent creator admission dispatches another PR while the first session is still running", async () => {
  const { config, ado, prepare } = scenario();
  const sent = [], state = { pullRequests: {}, builds: {} };
  const options = { ...idleHarness, independentTasks: true };
  const input = { config, state, now: NOW, ado, harness: harnessFake(sent), log: async () => {}, prepare, options };
  assert.equal((await pass(input)).job.dispatched, true);
  assert.equal((await pass(input)).job.dispatched, true);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0], sent[1]);
  assert.equal(telemetry.readJobs(config.telemetryFile, 50).filter(job => job.state === telemetry.DISPATCHED).length, 2);
});

test("nothing is dispatched while the harness reports the agent working", async () => {
  const { config, ado, prepare } = scenario();
  const sent = [];
  const state = { pullRequests: {}, builds: {} };

  const held = await pass({
    config, state, now: NOW, ado, harness: harnessFake(sent), log: async () => {}, prepare,
    options: { fetchImpl: harnessStatus("working") },
  });

  assert.equal(held.job, null, "an agent mid-turn is never handed more work");
  assert.equal(sent.length, 0);
  assert.equal(held.busy.status, "working");
});

test("an unreachable harness holds rather than guessing the agent is free", async () => {
  const { config, ado, prepare } = scenario();
  const sent = [];
  const state = { pullRequests: {}, builds: {} };

  const held = await pass({
    config, state, now: NOW, ado, harness: harnessFake(sent), log: async () => {}, prepare,
    options: { fetchImpl: async () => { throw new Error("connection refused"); } },
  });

  assert.equal(held.job, null);
  assert.equal(sent.length, 0);
  assert.equal(held.busy.status, "unknown");
});

test("a paused agent is never sent work it cannot pick up", async () => {
  const { config, ado, prepare } = scenario();
  const sent = [];
  const state = { pullRequests: {}, builds: {} };

  const held = await pass({
    config, state, now: NOW, ado, harness: harnessFake(sent), log: async () => {}, prepare,
    options: { fetchImpl: harnessStatus("paused") },
  });

  assert.equal(held.job, null);
  assert.equal(sent.length, 0);
});

test("the same evidence is never dispatched twice, even after the state file is lost", async () => {
  const { config, ado, prepare } = scenario();
  const sent = [];
  const options = idleHarness;

  await pass({ config, state: { pullRequests: {} }, now: NOW, ado, harness: harnessFake(sent), log: async () => {}, prepare, options });
  assert.equal(sent.length, 1);

  // The exact failure seen live: two runner processes overwrote each other's state file, so the
  // rate limiter forgot every dispatch and the same comment was sent nine times in 40 minutes.
  // A fresh state object reproduces that loss precisely.
  const done = { completedAt: NOW, outcome: "completed", text: "done" };
  for (let attempt = 0; attempt < 5; attempt++) {
    await pass({
      config, state: { pullRequests: {} }, now: NOW, ado,
      harness: harnessFake(sent, done), log: async () => {}, prepare, options,
    });
  }

  assert.deepEqual([...new Set(sent)], sent, "no submission id was ever sent twice");
});

test("the survey still runs while blocked, so the dashboard stays honest", async () => {
  const { config, ado, prepare } = scenario();
  const sent = [];
  const state = { pullRequests: {}, builds: {} };
  const lines = [];
  const log = async (event, payload) => lines.push({ event, ...payload });
  const options = idleHarness;

  await pass({ config, state, now: NOW, ado, harness: harnessFake(sent), log, prepare, options });
  const blocked = await pass({ config, state, now: NOW, ado, harness: harnessFake(sent), log, prepare, options });

  assert.equal(blocked.surveyed.length, 2, "every pull request is still evaluated");
  const waiting = lines.filter((line) => line.event === "survey" && line.holding);
  assert.equal(waiting.length, 1);
  assert.ok(waiting[0].holding.includes(conflicted.id), "the reason names the job being waited on");
});

test("work resumes once the agent reports the job finished", async () => {
  const { config, ado, prepare } = scenario();
  const sent = [];
  const state = { pullRequests: {}, builds: {} };
  const options = idleHarness;

  await pass({ config, state, now: NOW, ado, harness: harnessFake(sent), log: async () => {}, prepare, options });
  const done = { completedAt: NOW, outcome: "completed", text: "resolved the conflict" };
  const resumed = await pass({
    config,
    state,
    now: NOW,
    ado,
    harness: harnessFake(sent, done),
    log: async () => {},
    prepare,
    options,
  });

  assert.equal(resumed.job?.dispatched, true, "the next pull request is picked up after reconcile");
  assert.equal(sent.length, 2);
});

test("verification transport failure fails the scan without settling or redispatching the job", async () => {
  const { config, ado, prepare } = scenario();
  const sent = [], state = { pullRequests: {}, builds: {} };
  const args = { config, state, now: NOW, ado, harness: harnessFake(sent),
    log: async () => {}, prepare, options: idleHarness };
  await pass(args);
  const before = telemetry.readJobs(config.telemetryFile);
  await assert.rejects(pass({ ...args, harness: {
    ...args.harness,
    getConversations: async () => { throw new Error("verification service unavailable"); },
  } }), /verification service unavailable/);
  assert.deepEqual(telemetry.readJobs(config.telemetryFile), before);
  assert.equal(sent.length, 1);
  const recovered = await pass({ ...args, harness: harnessFake(sent, {
    completedAt: NOW, outcome: "completed", text: "verified after recovery",
  }) });
  assert.equal(recovered.job?.dispatched, true);
  assert.equal(sent.length, 2);
});
