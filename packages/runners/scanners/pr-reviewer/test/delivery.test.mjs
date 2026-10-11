import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createHandoffLedger, createMemoryQueue } from "../../../packages/bohemia-agent-tooling/src/index.js";

import { cancelReviewTask, deliverQueuedWork, taskTitle } from "../lib/delivery.mjs";

function workspace() {
  const folder = mkdtempSync(path.join(tmpdir(), "pr-reviewer-delivery-"));
  return {
    workFolder: folder,
    ledger: createHandoffLedger({ path: path.join(folder, "handoffs.jsonl"), tool: "pr-reviewer" }),
  };
}

function queueFile(workFolder, name, prId, commit) {
  writeFileSync(
    path.join(workFolder, name),
    [
      `Review Azure DevOps pull request #${prId}: Make the thing faster`,
      "PR URL: https://dev.azure.com/office/OC/_git/repo/pullrequest/" + prId,
      `Source commit: ${commit}`,
      "Phase: Initial review; start immediately even if CI is still running",
    ].join("\n"),
    "utf8",
  );
}

test("a queued review becomes an issue assigned to the reviewer agent", async () => {
  const { workFolder, ledger } = workspace();
  queueFile(workFolder, "azure-repo-pr-101-abc.md", "101", "abc");
  const queue = createMemoryQueue();

  const delivered = await deliverQueuedWork(
    { workFolder, agentId: "agent-1", agentName: "PRReviewer", priority: "high" },
    { queue, ledger },
  );

  assert.equal(delivered, true);
  assert.equal(queue.created.length, 1);
  assert.equal(queue.created[0].assigneeAgentId, "agent-1");
  assert.equal(queue.created[0].priority, "high");
  assert.equal(queue.created[0].status, "todo");
  assert.match(queue.created[0].title, /^Review Azure DevOps pull request #101/);
  assert.match(queue.created[0].description, /Source commit: abc/);
});

test("a delivered file leaves the queue folder so it is never handed over twice", async () => {
  const { workFolder, ledger } = workspace();
  queueFile(workFolder, "azure-repo-pr-102-abc.md", "102", "abc");
  const queue = createMemoryQueue();
  const config = { workFolder, agentId: "agent-1", agentName: "PRReviewer" };

  await deliverQueuedWork(config, { queue, ledger });
  const second = await deliverQueuedWork(config, { queue, ledger });

  assert.equal(second, false);
  assert.equal(queue.created.length, 1);
  assert.deepEqual(readdirSync(path.join(workFolder, "delivered")), ["azure-repo-pr-102-abc.md"]);
});

test("an empty queue folder delivers nothing and reports nothing", async () => {
  const { workFolder, ledger } = workspace();
  const queue = createMemoryQueue();
  assert.equal(await deliverQueuedWork({ workFolder, agentId: "agent-1" }, { queue, ledger }), false);
  assert.equal(queue.created.length, 0);
});

test("every handover is recorded with the agent it went to and when", async () => {
  const { workFolder, ledger } = workspace();
  queueFile(workFolder, "azure-repo-pr-103-abc.md", "103", "abc");
  const queue = createMemoryQueue();

  await deliverQueuedWork({ workFolder, agentId: "agent-1", agentName: "PRReviewer" }, { queue, ledger });

  const records = ledger.read();
  assert.equal(records.length, 1);
  assert.equal(records[0].transition, "handed");
  assert.equal(records[0].agent, "PRReviewer");
  assert.equal(records[0].taskKey, "103:abc");
  assert.equal(records[0].issueId, queue.created[0].id);
  assert.ok(Date.parse(records[0].at) > 0);
});

test("a refused handover keeps the file, records the refusal, and fails loudly", async () => {
  const { workFolder, ledger } = workspace();
  queueFile(workFolder, "azure-repo-pr-104-abc.md", "104", "abc");
  const queue = {
    async createIssue() {
      throw new Error("the queue said no");
    },
  };

  await assert.rejects(
    deliverQueuedWork({ workFolder, agentId: "agent-1", agentName: "PRReviewer" }, { queue, ledger }),
    /the reviewer was not given 1 queued review/,
  );

  assert.deepEqual(readdirSync(workFolder).filter((name) => name.endsWith(".md")), [
    "azure-repo-pr-104-abc.md",
  ]);
  const records = ledger.read();
  assert.equal(records[0].transition, "refused");
  assert.equal(records[0].detail, "the queue said no");
});

test("a withdrawn review is cancelled rather than deleted, and the withdrawal is recorded", async () => {
  const { workFolder, ledger } = workspace();
  const queue = createMemoryQueue({ issues: [{ id: "issue-9", status: "todo" }] });

  await cancelReviewTask({ workFolder, agentId: "agent-1", agentName: "PRReviewer" }, "issue-9", {
    queue,
    ledger,
    taskKey: "105:abc",
    reason: "The pull request is no longer eligible for review",
  });

  assert.equal((await queue.getIssue("issue-9")).status, "cancelled");
  const records = ledger.read();
  assert.equal(records[0].transition, "closed");
  assert.equal(records[0].taskKey, "105:abc");
});

test("a task title falls back to a usable sentence when the body has no first line", () => {
  assert.equal(taskTitle("\nbody"), "Review Azure DevOps pull request");
  assert.equal(taskTitle("Review Azure DevOps pull request #7: Title\nmore"), "Review Azure DevOps pull request #7: Title");
});
