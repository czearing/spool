import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMemoryQueue } from "../../../packages/bohemia-agent-tooling/src/index.js";
import { deliverQueuedWork } from "../lib/delivery.mjs";
import { enqueueReview } from "../lib/work-queue.mjs";

const pr = { id: "1", title: "Review", repository: "repo", url: "https://example/pr/1", sourceCommit: "a".repeat(40) };

async function environment(t, pullRequests = [pr]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "reviewer-prepared-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { repoRoot: root, workFolder: path.join(root, "queue"), agentId: "reviewer" };
  const queue = createMemoryQueue();
  const preparations = [];
  for (const entry of pullRequests) await enqueueReview(config.workFolder, entry);
  const options = {
    queue, pullRequests, admittedPullRequests: pullRequests,
    isReviewerBusy: async () => false,
    isPullRequestCurrent: async () => true,
    prepareWorkspace: ({ repoRoot, prId, sourceCommit }) => {
      preparations.push(prId);
      return { repoRoot, sourceCommit, branch: `review/pr-${prId}-${sourceCommit.slice(0, 7)}` };
    },
  };
  return { config, queue, preparations, options };
}

test("preparation failure never creates an issue and retains the intent for runner retry", async (t) => {
  const { config, queue, options } = await environment(t);
  options.prepareWorkspace = () => { throw new Error("transient LFS authentication failure"); };
  await assert.rejects(deliverQueuedWork(config, options), /transient LFS authentication failure/);
  assert.equal(queue.created.length, 0);
  assert.equal((await readdir(config.workFolder)).filter((name) => name.endsWith(".md")).length, 1);
});

test("a persisted failure retry reuses its original review only after fresh preparation", async t => {
  const { config, queue, options, preparations } = await environment(t, []);
  const failedAt = new Date(Date.now() - 120_000).toISOString();
  const failed = await queue.createIssue({
    title: "Review Azure DevOps pull request #1: Review", description: `Source commit: ${pr.sourceCommit}`,
    status: "failed", assigneeAgentId: config.agentId, createdAt: failedAt, updatedAt: failedAt,
  });
  const originalList = queue.listIssues.bind(queue);
  queue.listIssues = async () => (await originalList()).map(issue => ({ ...issue, updatedAt: failedAt }));
  let continued = 0;
  queue.retryIssue = async (id, payload, updatedAt) => {
    assert.equal(id, failed.id);
    assert.equal(updatedAt, failedAt);
    assert.match(payload.description, /verified clean/);
    continued++;
    return { ...failed, status: "todo" };
  };
  options.pullRequests = options.admittedPullRequests = [pr];
  await enqueueReview(config.workFolder, pr, { retryOf: failed.id, retryUpdatedAt: failedAt });
  assert.equal(await deliverQueuedWork(config, options), true);
  assert.deepEqual(preparations, ["1"]);
  assert.equal(continued, 1);
  assert.equal(queue.created.length, 1, "No replacement issue was created");
});

test("null preparation and missing eligibility guard fail closed", async (t) => {
  const { config, queue, options } = await environment(t);
  options.prepareWorkspace = () => null;
  await assert.rejects(deliverQueuedWork(config, options), /did not confirm/);
  delete options.pullRequests;
  await assert.rejects(deliverQueuedWork(config, options), /eligibility and reviewer liveness/);
  assert.equal(queue.created.length, 0);
});

test("shared checkout is not prepared while another PR review is pending", async (t) => {
  const { config, queue, preparations, options } = await environment(t);
  await queue.createIssue({ title: "Unrelated review", status: "in_progress", assigneeAgentId: "reviewer" });
  assert.equal(await deliverQueuedWork(config, options), false);
  assert.deepEqual(preparations, []);
  assert.equal(queue.created.length, 1);
});

test("a still-live run on a closed issue protects the checkout", async (t) => {
  const { config, queue, preparations, options } = await environment(t);
  options.isReviewerBusy = async () => true;
  assert.equal(await deliverQueuedWork(config, options), false);
  assert.deepEqual(preparations, []);
  assert.equal(queue.created.length, 0);
});

test("liveness lookup failure does not prepare or dispatch", async (t) => {
  const { config, queue, preparations, options } = await environment(t);
  options.isReviewerBusy = async () => { throw new Error("API timeout"); };
  await assert.rejects(deliverQueuedWork(config, options), /API timeout/);
  assert.deepEqual(preparations, []);
  assert.equal(queue.created.length, 0);
});

test("only one review is prepared and dispatched per shared-workspace scan", async (t) => {
  const second = { ...pr, id: "2", sourceCommit: "b".repeat(40) };
  const { config, queue, preparations, options } = await environment(t, [pr, second]);
  assert.equal(await deliverQueuedWork(config, options), true);
  assert.equal(queue.created.length, 1);
  assert.deepEqual(preparations, ["1"]);
  assert.match(queue.created[0].description, /verified clean/);
  assert.match(queue.created[0].description, /PATCH the current PAPERCLIP_TASK_ID to done/);
  assert.equal(await deliverQueuedWork(config, options), false);
  assert.deepEqual(preparations, ["1"]);
  await queue.updateIssue(queue.created[0].id, { status: "done" });
  assert.equal(await deliverQueuedWork(config, options), true);
  assert.deepEqual(preparations, ["1", "2"]);
});

test("Spool delivery regenerates a legacy queued intent with native completion instructions", async t => {
  const { config, queue, options } = await environment(t);
  config.transport = "spool";
  assert.equal(await deliverQueuedWork(config, options), true);
  assert.equal(queue.created.length, 1);
  assert.match(queue.created[0].description, /spool_update_task_status/);
  assert.match(queue.created[0].description, /no separate evidence service is required/);
  assert.doesNotMatch(queue.created[0].description, /PAPERCLIP_TASK_ID|X-Paperclip-Run-Id/);
});

test("obsolete queued revisions are withdrawn without preparation or agent spawn", async (t) => {
  const { config, queue, preparations, options } = await environment(t);
  options.pullRequests = [];
  assert.equal(await deliverQueuedWork(config, options), false);
  assert.equal(queue.created.length, 0);
  assert.deepEqual(preparations, []);
  assert.equal((await readdir(path.join(config.workFolder, "withdrawn"))).length, 1);
});

test("replayed queue file cannot duplicate a completed or blocked issue", async (t) => {
  for (const status of ["done", "blocked", "todo", "in_progress"]) {
    const { config, queue, preparations, options } = await environment(t);
    await queue.createIssue({
      title: "Review Azure DevOps pull request #1: Review",
      description: `Source commit: ${pr.sourceCommit}`, status, assigneeAgentId: config.agentId,
    });
    assert.equal(await deliverQueuedWork(config, options), false);
    assert.equal(queue.created.length, 1);
    assert.deepEqual(preparations, []);
  }
});

test("revision stability holds already queued files as well as new candidates", async (t) => {
  const { config, queue, preparations, options } = await environment(t);
  options.admittedPullRequests = [];
  assert.equal(await deliverQueuedWork(config, options), false);
  assert.deepEqual(preparations, []);
  assert.equal(queue.created.length, 0);
});

test("agent becoming active during preparation prevents dispatch", async (t) => {
  const { config, queue, preparations, options } = await environment(t);
  let checks = 0;
  options.isReviewerBusy = async () => ++checks === 2;
  assert.equal(await deliverQueuedWork(config, options), false);
  assert.deepEqual(preparations, ["1"]);
  assert.equal(queue.created.length, 0);
});

test("an ambiguous issue-create response is reconciled on the next scan without duplication", async (t) => {
  const { config, queue, options } = await environment(t);
  const create = queue.createIssue.bind(queue);
  queue.createIssue = async (issue) => { await create(issue); throw new Error("response lost"); };
  await assert.rejects(deliverQueuedWork(config, options), /response lost/);
  queue.createIssue = create;
  assert.equal(await deliverQueuedWork(config, options), false);
  assert.equal(queue.created.length, 1);
});

test("a push, vote, or eligibility change during preparation does not spawn a stale review", async (t) => {
  const { config, queue, preparations, options } = await environment(t);
  options.isPullRequestCurrent = async () => false;
  assert.equal(await deliverQueuedWork(config, options), false);
  assert.deepEqual(preparations, ["1"]);
  assert.equal(queue.created.length, 0);
});

test("final eligibility read failure does not dispatch from a stale scan", async (t) => {
  const { config, queue, options } = await environment(t);
  options.isPullRequestCurrent = async () => { throw new Error("ADO throttled"); };
  await assert.rejects(deliverQueuedWork(config, options), /ADO throttled/);
  assert.equal(queue.created.length, 0);
});
