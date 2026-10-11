import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryQueue } from "../../../packages/bohemia-agent-tooling/src/index.js";

import {
  normalizeStatus,
  paperclipReviewerTasks,
  reviewTasksFromIssues,
  taskPullRequestId,
  taskSourceCommit,
} from "../lib/task-source.mjs";

const AGENT = "agent-1";

function issue(overrides) {
  return {
    id: "issue-1",
    identifier: "OFF-1",
    assigneeAgentId: AGENT,
    status: "todo",
    title: "Review Azure DevOps pull request #201: Speed up the router",
    description: "PR URL: https://example\nSource commit: aaa\nPhase: Initial review",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("a task status is read in the vocabulary the review policy speaks", () => {
  assert.equal(normalizeStatus("done"), "completed");
  assert.equal(normalizeStatus("cancelled"), "cancelled");
  assert.equal(normalizeStatus("in_progress"), "reviewing");
  assert.equal(normalizeStatus("in_review"), "reviewing");
  assert.equal(normalizeStatus("blocked"), "blocked");
  assert.equal(normalizeStatus("todo"), "waiting");
});

test("the pull request number and revision are read out of a task", () => {
  assert.equal(taskPullRequestId("Review Azure DevOps pull request #42: Title"), "42");
  assert.equal(taskPullRequestId("Some other task"), null);
  assert.equal(taskPullRequestId("Review Azure DevOps pull request #4x2: Title"), null);
  assert.equal(taskSourceCommit("a\nSource commit: deadbeef\nb"), "deadbeef");
  assert.equal(taskSourceCommit("no revision here"), "unversioned");
});

test("only tasks this runner gave the reviewer agent become receipts", () => {
  const tasks = reviewTasksFromIssues([
    issue({}),
    issue({ id: "issue-2", assigneeAgentId: "someone-else" }),
    issue({ id: "issue-3", title: "Unrelated work" }),
  ], AGENT);

  assert.deepEqual([...tasks.keys()], ["201:aaa"]);
  assert.deepEqual(tasks.get("201:aaa"), {
    status: "waiting",
    taskId: "issue-1",
    identifier: "OFF-1",
    submittedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
});

test("the newest receipt for a revision wins", () => {
  const tasks = reviewTasksFromIssues([
    issue({ id: "old", status: "cancelled", createdAt: "2026-01-01T00:00:00.000Z" }),
    issue({ id: "new", status: "in_progress", createdAt: "2026-02-01T00:00:00.000Z" }),
  ], AGENT);

  assert.equal(tasks.get("201:aaa").taskId, "new");
  assert.equal(tasks.get("201:aaa").status, "reviewing");
});

test("a revision is never confused with another revision of the same pull request", () => {
  const tasks = reviewTasksFromIssues([
    issue({ id: "first", description: "Source commit: aaa", status: "done" }),
    issue({ id: "second", description: "Source commit: bbb", status: "todo" }),
  ], AGENT);

  assert.equal(tasks.get("201:aaa").status, "completed");
  assert.equal(tasks.get("201:bbb").status, "waiting");
});

test("a shortened description is read in full rather than guessed at", async () => {
  const queue = createMemoryQueue({
    issues: [issue({ description: "Source commit:", descriptionTruncated: true })],
  });
  queue.getIssue = async () => ({ description: "PR URL: x\nSource commit: ccc" });

  const tasks = await paperclipReviewerTasks({ agentId: AGENT }, queue);
  assert.deepEqual([...tasks.keys()], ["201:ccc"]);
});
