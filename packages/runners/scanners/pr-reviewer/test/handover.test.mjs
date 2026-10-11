import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createHandoffLedger, createMemoryQueue, handoffFailures, handoffRollup } from "../../../packages/bohemia-agent-tooling/src/index.js";

import { assignmentKey, newlyAssigned } from "../lib/assignments.mjs";
import { deliverQueuedWork } from "../lib/delivery.mjs";
import { queueableReviews, reviewAdmission, reviewTaskKey } from "../lib/reviewer-status.mjs";
import { paperclipReviewerTasks } from "../lib/task-source.mjs";
import { enqueueReview } from "../lib/work-queue.mjs";

/**
 * The end to end assertion the migration exists for: a pull request the runner decided to review
 * reaches the reviewer agent, is read back as that agent's work, and is never handed over twice.
 *
 * The transport is a queue double rather than a network, so the assertion is about the runner's own
 * behaviour and cannot pass or fail for a reason outside it.
 */

const AGENT = "agent-reviewer";

function environment() {
  const workFolder = mkdtempSync(path.join(tmpdir(), "pr-reviewer-handover-"));
  return {
    config: { workFolder, agentId: AGENT, agentName: "PRReviewer", priority: "high" },
    ledger: createHandoffLedger({ path: path.join(workFolder, "handoffs.jsonl"), tool: "pr-reviewer" }),
    queue: createMemoryQueue(),
  };
}

function pullRequest(overrides = {}) {
  return {
    id: "301",
    title: "Trim the router entry",
    repository: "office-bohemia",
    organization: "https://dev.azure.com/office",
    project: "OC",
    sourceCommit: "aaa111",
    url: "https://dev.azure.com/office/OC/_git/office-bohemia/pullrequest/301",
    ...overrides,
  };
}

/** One scan: decide, queue, deliver, then read back what the agent now holds. */
async function scan(config, queue, ledger, eligible, activeKeys) {
  const tasks = await paperclipReviewerTasks(config, queue);
  const admitted = eligible.filter((pr) => reviewAdmission(pr, tasks).admitted);
  const additions = queueableReviews(newlyAssigned(activeKeys, admitted), tasks);
  for (const pr of additions) await enqueueReview(config.workFolder, pr, { phase: "initial" });
  const delivered = await deliverQueuedWork(config, { queue, ledger });
  return { additions, delivered, active: admitted.map(assignmentKey).sort() };
}

test("a pull request the runner decides to review reaches the reviewer agent", async () => {
  const { config, queue, ledger } = environment();
  const pr = pullRequest();

  const first = await scan(config, queue, ledger, [pr], []);

  assert.equal(first.additions.length, 1);
  assert.equal(first.delivered, true);
  assert.equal(queue.created.length, 1, "the reviewer was not given the review");
  assert.equal(queue.created[0].assigneeAgentId, AGENT);
  assert.equal(handoffFailures(ledger.read()).length, 0, "a handover was refused");
});

test("the next scan reads the review back as the agent's work and does not hand it over again", async () => {
  const { config, queue, ledger } = environment();
  const pr = pullRequest();

  const first = await scan(config, queue, ledger, [pr], []);
  const tasks = await paperclipReviewerTasks(config, queue);
  assert.deepEqual([...tasks.keys()], [reviewTaskKey(pr.id, pr.sourceCommit)]);
  assert.equal(tasks.get(reviewTaskKey(pr.id, pr.sourceCommit)).status, "waiting");

  const second = await scan(config, queue, ledger, [pr], first.active);

  assert.equal(second.additions.length, 0);
  assert.equal(second.delivered, false);
  assert.equal(queue.created.length, 1, "the same review was handed over twice");
});

test("a runner restart that forgets its own state still does not duplicate the review", async () => {
  const { config, queue, ledger } = environment();
  const pr = pullRequest();

  await scan(config, queue, ledger, [pr], []);
  const afterRestart = await scan(config, queue, ledger, [pr], []);

  assert.equal(afterRestart.additions.length, 0);
  assert.equal(queue.created.length, 1);
});

test("a new revision is a new review, and it is given to the agent only once the first one finished", async () => {
  const { config, queue, ledger } = environment();
  const first = pullRequest();
  const revised = pullRequest({ sourceCommit: "bbb222" });

  const one = await scan(config, queue, ledger, [first], []);
  const whileReviewing = await scan(config, queue, ledger, [revised], one.active);
  assert.equal(whileReviewing.additions.length, 0, "a second revision was queued while the first was open");

  await queue.updateIssue(queue.created[0].id, { status: "done" });
  const afterCompletion = await scan(config, queue, ledger, [revised], one.active);

  assert.equal(afterCompletion.additions.length, 1, "the new revision was queued after first review finished");
  assert.equal(queue.created.length, 2);
});

test("every task the runner decided to hand over is recorded against the agent that received it", async () => {
  const { config, queue, ledger } = environment();

  await scan(config, queue, ledger, [pullRequest(), pullRequest({ id: "302", sourceCommit: "ccc333" })], []);

  const rollup = handoffRollup(ledger.read());
  assert.equal(rollup.length, 2);
  for (const task of rollup) {
    assert.equal(task.transition, "handed");
    assert.equal(task.agent, "PRReviewer");
    assert.ok(task.issueId, "a handed task has no issue");
    assert.ok(Date.parse(task.handedAt) > 0, "a handed task has no time");
  }
  assert.deepEqual(handoffFailures(ledger.read()), []);
});
