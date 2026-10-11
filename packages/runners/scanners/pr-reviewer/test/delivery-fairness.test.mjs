import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMemoryQueue } from "../../../packages/bohemia-agent-tooling/src/index.js";
import { deliverQueuedWork } from "../lib/delivery.mjs";
import { enqueueReview, queuedReviews, taskFileName } from "../lib/work-queue.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "reviewer-fairness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { repoRoot: root, workFolder: path.join(root, "queue"), agentId: "reviewer" };
  const prs = ["90", "20", "1"].map(id => ({
    id, title: id, repository: "repo", url: `https://example.invalid/pr/${id}`, sourceCommit: "a".repeat(40),
  }));
  for (const [index, pr] of prs.entries()) {
    await enqueueReview(config.workFolder, pr);
    const date = new Date(Date.now() - (10 - index) * 60000);
    await utimes(path.join(config.workFolder, taskFileName(pr)), date, date);
  }
  const queue = createMemoryQueue(), prepared = [];
  const options = { queue, pullRequests: prs, admittedPullRequests: prs,
    isReviewerBusy: async () => false, isPullRequestCurrent: async () => true,
    prepareWorkspace: async ({ repoRoot, prId, sourceCommit }) => {
      prepared.push(prId);
      return { repoRoot, sourceCommit, branch: `review/pr-${prId}` };
    } };
  return { config, prs, options, prepared };
}

test("reviews are handed off by waiting time, not lexical PR number", async t => {
  const { config, options, prepared } = await fixture(t);
  assert.equal(await deliverQueuedWork(config, options), true);
  assert.deepEqual(prepared, ["90"]);
});

test("a failed preparation rotates behind waiting reviews without losing its intent", async t => {
  const { config, prs, options, prepared } = await fixture(t);
  const file = path.join(config.workFolder, taskFileName(prs[0])), original = await readFile(file, "utf8");
  const prepare = options.prepareWorkspace;
  options.prepareWorkspace = async args => {
    if (args.prId === "90") throw new Error("Required dependency is unavailable");
    return prepare(args);
  };
  await assert.rejects(deliverQueuedWork(config, options), /Required dependency is unavailable/);
  assert.equal(await readFile(file, "utf8"), original);
  assert.deepEqual(await queuedReviews(config.workFolder), [prs[1], prs[2], prs[0]].map(pr => taskFileName(pr)));
  assert.equal(await deliverQueuedWork(config, options), true);
  assert.deepEqual(prepared, ["20"]);
  assert.equal(options.queue.created.length, 1);
});

test("a newly queued retry cannot jump ahead of an already waiting review", async t => {
  const { config, prs } = await fixture(t);
  const retry = { retryOf: "original-task", retryUpdatedAt: new Date().toISOString() };
  await enqueueReview(config.workFolder, prs[2], retry);
  assert.equal((await queuedReviews(config.workFolder)).at(-1), taskFileName(prs[2], retry));
});
