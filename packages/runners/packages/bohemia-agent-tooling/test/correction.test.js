import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASSIGNEE_RUN_LOCK_CODE,
  CORRECTABLE_FIELDS,
  CORRECTION_RESULTS,
  applyBriefCorrection,
  buildBriefCorrection,
  createBriefCorrector,
  describeUncorrectedBrief,
  isRunLockRefusal,
} from "../src/correction.js";
import { runCycle } from "../src/wake.js";
import { createTelemetryWriter, rollup, TELEMETRY_KINDS } from "../src/telemetry.js";
import { defineCollector } from "../src/collect.js";
import { defineThresholdSelector } from "../src/select.js";
import { createMemoryQueue } from "../src/queue/memory-queue.js";
import {
  guardIssueWrites,
  readRunContext,
  RUN_CONTEXT_REFUSAL_CODE,
} from "../src/run-context.js";

function observation(metric, current, target) {
  return {
    metric,
    current,
    target,
    acceptance: target,
    unit: "bytes",
    reproduction: `node measure.js ${metric}`,
  };
}

function openTask(overrides = {}) {
  return {
    issueId: "issue-1",
    metric: "router.eager-bytes",
    current: 366994,
    target: 300000,
    acceptance: 300000,
    unit: "bytes",
    reproduction: "node measure.js router.eager-bytes",
    ...overrides,
  };
}

test("a correction carries every number the fresh observation reports", () => {
  const correction = buildBriefCorrection({
    task: openTask(),
    observation: observation("router.eager-bytes", 5569306, 1000000),
  });

  assert.equal(correction.changed, true);
  assert.deepEqual(correction.changedFields, ["current", "target", "acceptance"]);
  assert.equal(correction.candidate.current, 5569306);
  assert.equal(correction.candidate.target, 1000000);
  assert.equal(correction.candidate.acceptance, 1000000);
  assert.match(correction.fields.description, /current: 5569306 bytes/);
  assert.match(correction.fields.description, /acceptance: router.eager-bytes at or below 1000000 bytes/);
});

test("a brief that already carries the observed numbers is not rewritten", async () => {
  const correction = buildBriefCorrection({
    task: openTask(),
    observation: observation("router.eager-bytes", 366994, 300000),
  });
  assert.equal(correction.changed, false);
  assert.equal(correction.fields, null);

  const queue = createMemoryQueue();
  const outcome = await applyBriefCorrection({ queue, correction });
  assert.equal(outcome.result, CORRECTION_RESULTS.UNCHANGED);
});

test("a correction refuses an observation of another metric and a task with no issue", () => {
  assert.throws(
    () => buildBriefCorrection({ task: openTask(), observation: observation("other.metric", 1, 2) }),
    /same metric/,
  );
  assert.throws(
    () => buildBriefCorrection({ task: openTask({ issueId: "" }), observation: observation("router.eager-bytes", 1, 2) }),
    /issue id/,
  );
});

test("only the carried brief fields are ever sent", async () => {
  const sent = [];
  const queue = {
    async updateIssue(issueId, update) {
      sent.push({ issueId, update });
      return { id: issueId };
    },
  };
  const correction = buildBriefCorrection({
    task: openTask(),
    observation: observation("router.eager-bytes", 5569306, 1000000),
  });
  await applyBriefCorrection({ queue, correction });

  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0].update).sort(), [...CORRECTABLE_FIELDS].sort());
  assert.equal("status" in sent[0].update, false);

  correction.fields.status = "done";
  await assert.rejects(() => applyBriefCorrection({ queue, correction }), /belongs to the assignee run/);
});

test("the assignee run lock is a deferral and any other refusal is not", async () => {
  assert.equal(isRunLockRefusal(new Error(`queue PATCH failed with 409: ${ASSIGNEE_RUN_LOCK_CODE}`)), true);
  assert.equal(isRunLockRefusal({ details: { code: ASSIGNEE_RUN_LOCK_CODE } }), true);
  assert.equal(isRunLockRefusal(new Error("queue PATCH failed with 404: not found")), false);

  const correction = buildBriefCorrection({
    task: openTask(),
    observation: observation("router.eager-bytes", 5569306, 1000000),
  });

  const locked = {
    async updateIssue() {
      throw new Error(`queue PATCH /api/issues/issue-1 failed with 409: ${ASSIGNEE_RUN_LOCK_CODE}`);
    },
  };
  const deferred = await applyBriefCorrection({ queue: locked, correction, attempt: 2 });
  assert.equal(deferred.result, CORRECTION_RESULTS.DEFERRED);
  assert.equal(deferred.reason, ASSIGNEE_RUN_LOCK_CODE);
  assert.equal(deferred.attempt, 2);

  const broken = {
    async updateIssue() {
      throw new Error("queue PATCH failed with 404: Issue not found");
    },
  };
  const refused = await applyBriefCorrection({ queue: broken, correction });
  assert.equal(refused.result, CORRECTION_RESULTS.REFUSED);
});

test("the configured corrector rewrites the task the tool wrote", async () => {
  const queue = createMemoryQueue({
    issues: [{ id: "issue-1", identifier: "MEM-1", status: "in_progress", title: "old", description: "old" }],
  });
  const correct = createBriefCorrector({ queue });
  const outcome = await correct({
    task: openTask(),
    observation: observation("router.eager-bytes", 5569306, 1000000),
  });

  assert.equal(outcome.result, CORRECTION_RESULTS.APPLIED);
  const issue = await queue.getIssue("issue-1");
  assert.match(issue.title, /5569306 to 1000000 bytes/);
  assert.match(issue.description, /current: 5569306 bytes/);
  assert.equal(issue.status, "in_progress");
});

test("the defect wording names the deferral count and the numbers", () => {  const drift = { metric: "router.eager-bytes", recorded: 366994, observed: 5569306, unit: "bytes" };
  const deferred = describeUncorrectedBrief(drift, {
    result: CORRECTION_RESULTS.DEFERRED,
    attempt: 3,
    reason: ASSIGNEE_RUN_LOCK_CODE,
  });
  assert.match(deferred, /still refused after 3 attempts/);
  assert.match(deferred, /366994 bytes against 5569306 bytes/);

  const refused = describeUncorrectedBrief(drift, { result: CORRECTION_RESULTS.REFUSED, reason: "404" });
  assert.match(refused, /refused/);

  const held = describeUncorrectedBrief(drift, {
    result: CORRECTION_RESULTS.HELD,
    reason: RUN_CONTEXT_REFUSAL_CODE,
  });
  assert.match(held, /waiting for a run it can be attributed to/);
});

test("a write the run cannot be attributed for is held rather than refused", async () => {
  const correction = buildBriefCorrection({
    task: openTask(),
    observation: observation("router.eager-bytes", 5569306, 1000000),
  });

  const guarded = guardIssueWrites(
    {
      async updateIssue() {
        throw new Error("the guard let a held write through");
      },
    },
    readRunContext({ PAPERCLIP_RUN_ID: "run-1" }),
  );

  const held = await applyBriefCorrection({ queue: guarded, correction, attempt: 1 });
  assert.equal(held.result, CORRECTION_RESULTS.HELD);
  assert.equal(held.reason, RUN_CONTEXT_REFUSAL_CODE);

  const live = {
    async updateIssue() {
      const error = new Error("queue PATCH /api/issues/issue-1 failed with 403: cross issue");
      error.details = { code: RUN_CONTEXT_REFUSAL_CODE };
      error.code = RUN_CONTEXT_REFUSAL_CODE;
      throw error;
    },
  };
  const liveHeld = await applyBriefCorrection({ queue: live, correction, attempt: 1 });
  assert.equal(liveHeld.result, CORRECTION_RESULTS.HELD, "the same code is a hold wherever it is raised");
});

function cycleHarness({ issues, observations, defect = null, correctionDeferralLimit = 3 }) {
  const dir = mkdtempSync(join(tmpdir(), "tooling-correction-"));
  const telemetry = createTelemetryWriter({ path: join(dir, "cycles.jsonl"), tool: "test-tool" });
  const queue = createMemoryQueue({ issues });
  const config = {
    tool: "test-tool",
    telemetry,
    queue,
    assigneeAgentId: "agent-worker",
    correctionDeferralLimit,
    defect,
    collectors: [defineCollector({ name: "c", collect: async () => observations })],
    selector: defineThresholdSelector({ minGapRatio: 0.1 }),
  };
  return { dir, telemetry, queue, config };
}

test("a drifted brief is corrected in place inside the cycle and the open task carries the new numbers", async () => {
  const { dir, telemetry, queue, config } = cycleHarness({
    issues: [{ id: "issue-1", identifier: "MEM-1", status: "in_progress" }],
    observations: [observation("router.eager-bytes", 5569306, 1000000)],
  });
  try {
    telemetry.append(TELEMETRY_KINDS.TASK_TRANSITION, {
      issueId: "issue-1",
      metric: "router.eager-bytes",
      transition: "opened",
      current: 366994,
      target: 300000,
      acceptance: 300000,
      unit: "bytes",
      reproduction: "node measure.js router.eager-bytes",
    });

    const summary = await runCycle(config);

    assert.equal(summary.drifts.length, 1);
    assert.equal(summary.corrections.length, 1);
    assert.equal(summary.corrections[0].result, CORRECTION_RESULTS.APPLIED);

    const issue = await queue.getIssue("issue-1");
    assert.match(issue.description, /current: 5569306 bytes/);
    assert.match(issue.description, /target: 1000000 bytes/);

    const open = rollup(telemetry.read()).openTasks;
    assert.equal(open.length, 1);
    assert.equal(open[0].current, 5569306);
    assert.equal(open[0].acceptance, 1000000);

    const corrected = telemetry.read().filter((record) => record.transition === "corrected");
    assert.equal(corrected.length, 1);
    assert.equal(corrected[0].attempt, 1);
    assert.equal(summary.cycleRecord.corrected, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run lock defers the correction, writes no defect, and retries with a rising attempt count", async () => {
  const { dir, telemetry, config, queue } = cycleHarness({
    issues: [{ id: "issue-1", identifier: "MEM-1", status: "in_progress" }],
    observations: [observation("router.eager-bytes", 5569306, 1000000)],
    defect: { ownerAgentId: "agent-owner" },
  });
  queue.updateIssue = async () => {
    throw new Error(`queue PATCH /api/issues/issue-1 failed with 409: ${ASSIGNEE_RUN_LOCK_CODE}`);
  };
  try {
    telemetry.append(TELEMETRY_KINDS.TASK_TRANSITION, {
      issueId: "issue-1",
      metric: "router.eager-bytes",
      transition: "opened",
      current: 366994,
      target: 300000,
      acceptance: 300000,
      unit: "bytes",
      reproduction: "node measure.js router.eager-bytes",
    });

    const first = await runCycle(config);
    assert.equal(first.corrections[0].result, CORRECTION_RESULTS.DEFERRED);
    assert.equal(first.corrections[0].attempt, 1);
    assert.equal(first.defectIssueId, null, "a deferral inside the limit is not a defect");

    const second = await runCycle(config);
    assert.equal(second.corrections[0].attempt, 2);
    assert.equal(second.defectIssueId, null);

    const third = await runCycle(config);
    assert.equal(third.corrections[0].attempt, 3);
    assert.notEqual(third.defectIssueId, null, "the deferral limit hands the stale brief to the tool owner");

    const defectIssue = await queue.getIssue(third.defectIssueId);
    assert.equal(defectIssue.assigneeAgentId, "agent-owner");
    assert.match(defectIssue.description, /still refused after 3 attempts/);

    const deferrals = telemetry.read().filter((record) => record.transition === "correction_deferred");
    assert.equal(deferrals.length, 3);
    assert.equal(rollup(telemetry.read()).openTasks[0].current, 366994, "a deferred correction leaves the record alone");
    assert.equal(rollup(telemetry.read()).deferredCorrections, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrected brief is settled, so the tool owner is told nothing", async () => {
  const { dir, telemetry, config, queue } = cycleHarness({
    issues: [{ id: "issue-1", identifier: "MEM-1", status: "blocked" }],
    observations: [observation("router.eager-bytes", 5569306, 1000000)],
    defect: { ownerAgentId: "agent-owner" },
  });
  try {
    telemetry.append(TELEMETRY_KINDS.TASK_TRANSITION, {
      issueId: "issue-1",
      metric: "router.eager-bytes",
      transition: "opened",
      current: 366994,
      target: 300000,
      acceptance: 300000,
      unit: "bytes",
      reproduction: "node measure.js router.eager-bytes",
    });

    const summary = await runCycle(config);
    assert.equal(summary.corrections[0].result, CORRECTION_RESULTS.APPLIED);
    assert.equal(summary.defectIssueId, null);
    assert.equal(queue.created.length, 0, "no issue is created for a brief the tool put right");

    const next = await runCycle(config);
    assert.equal(next.drifts.length, 0, "the corrected brief no longer drifts against the same numbers");
    assert.equal(next.corrections.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a queue that cannot update an issue still runs the cycle and reports the drift", async () => {
  const { dir, telemetry, config, queue } = cycleHarness({
    issues: [{ id: "issue-1", identifier: "MEM-1", status: "in_progress" }],
    observations: [observation("router.eager-bytes", 5569306, 1000000)],
    defect: { ownerAgentId: "agent-owner" },
  });
  delete queue.updateIssue;
  try {
    telemetry.append(TELEMETRY_KINDS.TASK_TRANSITION, {
      issueId: "issue-1",
      metric: "router.eager-bytes",
      transition: "opened",
      current: 366994,
      target: 300000,
      acceptance: 300000,
      unit: "bytes",
      reproduction: "node measure.js router.eager-bytes",
    });

    const summary = await runCycle(config);
    assert.equal(summary.corrections.length, 0);
    assert.equal(summary.drifts.length, 1);
    assert.notEqual(summary.defectIssueId, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a timer woken cycle holds the correction, tells the owner nothing, and leaves the record alone", async () => {
  const { dir, telemetry, config, queue } = cycleHarness({
    issues: [{ id: "issue-1", identifier: "MEM-1", status: "in_progress" }],
    observations: [observation("router.eager-bytes", 5569306, 1000000)],
    defect: { ownerAgentId: "agent-owner" },
  });
  const timerWoken = guardIssueWrites(queue, readRunContext({ PAPERCLIP_RUN_ID: "run-1" }));
  try {
    telemetry.append(TELEMETRY_KINDS.TASK_TRANSITION, {
      issueId: "issue-1",
      metric: "router.eager-bytes",
      transition: "opened",
      current: 366994,
      target: 300000,
      acceptance: 300000,
      unit: "bytes",
      reproduction: "node measure.js router.eager-bytes",
    });

    const first = await runCycle({ ...config, queue: timerWoken });
    assert.equal(first.corrections[0].result, CORRECTION_RESULTS.HELD);
    assert.equal(first.defectIssueId, null, "a held write is not a defect for the tool owner");
    assert.equal(first.runContext.attributable, false);
    assert.equal(first.cycleRecord.correctionsHeld, 1);
    assert.equal(first.cycleRecord.runContext.reason, "no_source_issue");

    const second = await runCycle({ ...config, queue: timerWoken });
    assert.equal(second.corrections[0].result, CORRECTION_RESULTS.HELD);
    assert.equal(second.defectIssueId, null, "holding never escalates, however many wakes pass");

    const record = rollup(telemetry.read());
    assert.equal(record.heldCorrections, 2);
    assert.equal(record.deferredCorrections, 0, "a hold is not a deferral");
    assert.equal(record.openTasks.length, 1, "a held correction leaves the task open");
    assert.equal(record.openTasks[0].current, 366994, "a held correction changes no number");
    const issue = await queue.getIssue("issue-1");
    assert.equal(issue.description, undefined, "a held write never reached the queue");

    const attributable = await runCycle({ ...config, queue });
    assert.equal(attributable.corrections[0].result, CORRECTION_RESULTS.APPLIED);
    assert.equal(attributable.corrections[0].attempt, 1, "the held wakes cost the write no attempts");
    assert.match((await queue.getIssue("issue-1")).description, /current: 5569306 bytes/);
    assert.equal(rollup(telemetry.read()).openTasks[0].current, 5569306);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
