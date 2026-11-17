import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./fixtures.mjs";
import { writeJson } from "../spool-store.mjs";
import { ciExperimentContract, readCiJob } from "../ci-job.mjs";
import { reconcileCiExperiment } from "../ci-experiment.mjs";
import { prReviewFingerprint } from "../../packages/bohemia-pr-mcp/src/pr-origin.mjs";

function closedExperiment(t, status = "abandoned") {
  const f = fixture(t), taskId = "closed-ci", head = "a".repeat(40), branch = "user/ci-closed";
  writeFileSync(path.join(f.root, "agents", "ci.md"), "Fixture agent. Never executed.");
  f.put({ id: taskId, agent: "ci", session_id: randomUUID(), error: "Later upstream failure" }, "failed");
  writeJson(path.join(f.store.records, `task-${taskId}.json`), {
    preparation: { ...f.preparation, branch },
    handoff: { discovery: true, ciExperiment: ciExperimentContract(f.store) },
  });
  const pr = { id: "42", branch, sourceCommit: head, targetBranch: "master",
    status, isDraft: false, description: "<!-- bohemia-origin:fixture-origin -->\nExperiment" };
  const owner = { version: 1, verified: true, agent: "ci", taskId,
    sessionId: f.store.task(taskId).session_id, workspace: f.workspace, branch, prId: pr.id,
    originId: "fixture-origin", targetBranch: "master",
    publications: [{ checked: true, head, draft: false, reviewHash: prReviewFingerprint(pr) }] };
  writeJson(path.join(f.store.records, "native-creators", `${taskId}.json`), owner);
  const job = { version: 1, taskId, workspace: f.workspace, branch,
    outcome: { verdict: "accepted", head, recordedAt: "2026-10-15T00:00:00Z" } };
  writeJson(path.join(f.store.records, "ci-jobs", `${taskId}.json`), job);
  const options = { store: f.store, taskId, config: { ado: {} },
    getPullRequest: async () => structuredClone(pr), cleanWorkspace: () => true,
    abandon: async () => assert.fail("Closure reconciliation must not modify the PR"),
    publish: async () => assert.fail("Closure reconciliation must not publish the PR") };
  return { ...f, taskId, head, pr, owner, job, options };
}

for (const status of ["completed", "abandoned"]) {
  test(`closed accepted CI releases capacity without relabeling its failed task: ${status}`, async t => {
    const f = closedExperiment(t, status), original = f.store.task(f.taskId);
    assert.deepEqual(await reconcileCiExperiment(f.options), { released: true });
    assert.deepEqual(f.store.task(f.taskId), original);
    const job = readCiJob(f.store, f.taskId);
    assert.deepEqual(job.outcome, f.job.outcome);
    assert.equal(job.closure.status, status);
    assert.equal(job.closure.head, f.head);
    assert.deepEqual(await reconcileCiExperiment(f.options), { released: true });
  });
}

test("accepted CI still holds an active PR or an unknown original publication", async t => {
  const f = closedExperiment(t, "active");
  assert.match((await reconcileCiExperiment(f.options)).holding, /conflicts/);
  assert.equal(readCiJob(f.store, f.taskId).closure, undefined);
  f.owner.verified = false;
  writeJson(path.join(f.store.records, "native-creators", `${f.taskId}.json`), f.owner);
  await assert.rejects(reconcileCiExperiment(f.options), /original owner/);
});

test("closed CI must retain the exact accepted outcome head", async t => {
  const f = closedExperiment(t);
  f.job.outcome.head = "b".repeat(40);
  writeJson(path.join(f.store.records, "ci-jobs", `${f.taskId}.json`), f.job);
  assert.match((await reconcileCiExperiment(f.options)).holding, /conflicts/);
  assert.equal(readCiJob(f.store, f.taskId).closure, undefined);
});

for (const change of [{ sourceCommit: "b".repeat(40) }, { description: "Human changes" }]) {
  test(`closed CI cannot release a changed checked publication: ${JSON.stringify(change)}`, async t => {
    const f = closedExperiment(t);
    Object.assign(f.pr, change);
    await assert.rejects(reconcileCiExperiment(f.options), /changed from its checked/);
    assert.equal(readCiJob(f.store, f.taskId).closure, undefined);
  });
}

test("closed CI preserves dirty checkouts, operator holds and concurrent task changes", async t => {
  const f = closedExperiment(t);
  assert.match((await reconcileCiExperiment({ ...f.options, cleanWorkspace: () => false })).holding, /clean/);
  writeJson(path.join(f.root, "controls", "paused", "ci"), {});
  assert.match((await reconcileCiExperiment(f.options)).holding, /paused/);
  const g = closedExperiment(t);
  const options = { ...g.options, getPullRequest: async () => {
    g.put({ ...g.store.task(g.taskId), interaction: { paused: true },
      updated_at: "2026-11-17T00:00:00Z" }, "failed");
    return structuredClone(g.pr);
  } };
  assert.match((await reconcileCiExperiment(options)).holding, /changed during/);
  assert.equal(readCiJob(g.store, g.taskId).closure, undefined);
});
