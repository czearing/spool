import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { engine } from "../sources.mjs";
import { readJson, writeJson } from "../spool-store.mjs";
import { finishTask } from "./continuation-fixtures.mjs";
import { handoff } from "./updater-fixture.mjs";
import { createUpdater } from "../updater.mjs";
import { creatorWorkflowEvidence } from "../updater-dispatch.mjs";

for (const trigger of ["conflict", "build", "review"]) {
  test(`${trigger} survey holds unverified ownership before repository preparation`, async t => {
    const f = await handoff(t, "perf", { trigger, dispatch: false });
    writeJson(path.join(f.store.records, "ownership.json"), { version: 1, pullRequests: [] });
    const result = await f.scan();
    assert.equal(result.dispatched, 0);
    assert.equal(result.actionable, 0);
    assert.equal(f.preparations(), 0);
    assert.match(result.pullRequests[0].dispatchHold, /no unique verified originating work item/);
    assert.equal(f.store.task(f.taskId).status, "completed");
  });
}

test("survey reports the verified original agent and exact generation's blocked result", async t => {
  const f = await handoff(t, "perf", { dispatch: false });
  const result = await f.scan();
  assert.deepEqual(result.pullRequests[0].creator, { agent: "perf", taskId: f.taskId, status: "incoming" });
  const metadata = f.store.metadata(f.taskId);
  finishTask(f, f.taskId, "failed", { error: "Repair prerequisite unavailable" });
  const { jobDone } = await engine("pr-updater/lib/telemetry.mjs");
  jobDone(f.config.telemetryFile, { jobId: metadata.key, at: new Date().toISOString(), outcome: "blocked" });
  const verificationFile = path.join(f.store.records, `verification-${f.taskId}.json`);
  writeJson(verificationFile, { ok: false, taskId: f.taskId, prId: f.pr.id, submissionId: metadata.key,
    head: f.pr.sourceCommit, reason: "Repair prerequisite unavailable" });
  const next = await f.scan();
  assert.equal(next.pullRequests[0].creator.agent, "perf");
  assert.equal(next.pullRequests[0].creator.blockedReason, "Repair prerequisite unavailable");
  assert.equal(next.pullRequests[0].dispatchHold, "Repair prerequisite unavailable");
  writeJson(verificationFile, { ...readJson(verificationFile), head: "c".repeat(40) });
  assert.equal((await f.scan()).pullRequests[0].creator.blockedReason, undefined);
});

test("one scan resumes independent original creators but never overlaps a busy creator lane", async t => {
  const f = await handoff(t, "perf", { dispatch: false });
  const workspace = path.join(f.root, "writer-workspace");
  mkdirSync(workspace);
  const second = { ...f.pr, id: "124", url: f.pr.url.replace("123", "124"), branch: "user/second" };
  const third = { ...f.pr, id: "125", url: f.pr.url.replace("123", "125"), branch: "user/third" };
  f.put({ id: "second-owner", agent: "perf", session_id: "second-session" }, "completed");
  f.put({ id: "third-owner", agent: "tech-writer", session_id: "third-session", workspace }, "completed");
  const registryFile = path.join(f.store.records, "ownership.json"), registry = readJson(registryFile);
  for (const [pr, taskId, agent, cwd, sessionId] of [
    [second, "second-owner", "perf", f.workspace, "second-session"],
    [third, "third-owner", "tech-writer", workspace, "third-session"],
  ]) registry.pullRequests.push({ verified: true, prId: pr.id, prUrl: pr.url,
    branch: pr.branch, taskId, agent, workspace: cwd, sessionId });
  writeJson(registryFile, registry);
  const prepared = [];
  const scan = await createUpdater({ store: f.store, config: f.config, agent: "pr-updater",
    workspace: f.workspace, runtime: f.config.runtimeDirectory, preparationEvidence: () => "routing-fixture",
    ado: { async listOwnPullRequests() { return [f.pr, second, third]; },
      async getPullRequest(_config, id) { return [f.pr, second, third].find(pr => pr.id === id); },
      async listThreads() { return []; }, async listBuilds() { return []; } },
    callBohemia: async (_name, args) => {
      prepared.push(args.repoRoot);
      return { ready: true, repoRoot: args.repoRoot, branch: args.branch, commit: "b".repeat(40) };
    },
  });

  const result = await scan();
  assert.equal(result.dispatched, 2);
  assert.deepEqual(prepared, [f.workspace, workspace]);
  assert.equal(f.store.task(f.taskId).session_id, f.session);
  assert.equal(f.store.task("second-owner").status, "completed");
  assert.equal(f.store.task("third-owner").session_id, "third-session");
  assert.equal(f.store.task("third-owner").agent, "tech-writer");
  assert.equal(f.store.metadata("third-owner").contract.prId, third.id);
  assert.ok(result.pullRequests[1].dispatchHold);
});

test("a blocked original creator retries changed repair instructions once without bypassing same-generation cooldown", async t => {
  let generation = "old";
  const f = await handoff(t, "perf", { dispatch: false, updater: options =>
    createUpdater({ ...options, workflowEvidence: () => generation }) });
  assert.equal((await f.scan()).dispatched, 1);
  const metadata = f.store.metadata(f.taskId);
  finishTask(f, f.taskId, "failed", { error: "Old repair path blocked" });
  const { jobDone } = await engine("pr-updater/lib/telemetry.mjs");
  jobDone(f.config.telemetryFile, { jobId: metadata.key, at: new Date().toISOString(), outcome: "blocked" });
  writeJson(path.join(f.store.records, `verification-${f.taskId}.json`), {
    ok: false, taskId: f.taskId, prId: f.pr.id, submissionId: metadata.key, head: f.pr.sourceCommit, reason: "Old repair path blocked",
  });

  assert.equal((await f.scan()).dispatched, 0);
  generation = "repaired";
  assert.equal((await f.scan()).dispatched, 1);
  assert.equal(f.store.task(f.taskId).session_id, f.session);
  assert.equal(f.store.metadata(f.taskId).repairWorkflowEvidence, generation);
  assert.equal((await f.scan()).dispatched, 0);
});

for (const dependency of ["transport.mjs", "message-receipt.mjs", "file-watch.mjs", "control-identity.mjs", "task-records.mjs", "creator-result.mjs"])
test(`repairing shared ${dependency} releases a blocked PR to its original creator exactly once`, async t => {
  let revision = "original";
  const f = await handoff(t, "perf", { dispatch: false, updater: options =>
    createUpdater({ ...options, workflowEvidence: (store, owner) =>
      creatorWorkflowEvidence(store, owner, (file, encoding) =>
        readFileSync(file, encoding) + (path.basename(file) === dependency ? revision : "")) }) });
  assert.equal((await f.scan()).dispatched, 1);
  const metadata = f.store.metadata(f.taskId);
  finishTask(f, f.taskId, "failed", { error: "GitHub API rate limit blocked startup" });
  const { jobDone } = await engine("pr-updater/lib/telemetry.mjs");
  jobDone(f.config.telemetryFile, { jobId: metadata.key, at: new Date().toISOString(), outcome: "blocked" });
  writeJson(path.join(f.store.records, `verification-${f.taskId}.json`), {
    ok: false, taskId: f.taskId, prId: f.pr.id, submissionId: metadata.key,
    head: f.pr.sourceCommit, reason: "GitHub API rate limit blocked startup",
  });
  assert.equal((await f.scan()).dispatched, 0);
  revision = "repaired";
  assert.equal((await f.scan()).dispatched, 1);
  assert.equal(f.store.task(f.taskId).session_id, f.session);
  assert.equal((await f.scan()).dispatched, 0);
});
