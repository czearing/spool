import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { renameSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { configure } from "../config.mjs";
import { engine, profile } from "../sources.mjs";
import { createUpdater } from "../updater.mjs";
import { resolveSpoolCreator } from "../creator-routing.mjs";
import { SpoolStore, writeJson, readJson, digest } from "../spool-store.mjs";
import { workload } from "../workload.mjs";
import { fixture } from "./fixtures.mjs";
import { PREPARATION_BLOCKED } from "../../packages/bohemia-pr-mcp/src/resume-state.mjs";
import { finishTask, legacyInterrupted } from "./continuation-fixtures.mjs";
import { nativeControls } from "./native-controls-fixture.mjs";

import { creatorFixture } from "./creator-fixture.mjs";

test("incompatible preparation is blocked once across restarts until its evidence changes", async t => {
  const f = creatorFixture(t);
  let revision = "initial", attempts = 0, blocked = true;
  const options = { ...f.options, preparationEvidence: () => revision, callBohemia: async (_name, args) => {
    attempts++;
    if (blocked) throw Object.assign(new Error("Interrupted merge is diverged; work preserved"), { code: PREPARATION_BLOCKED });
    return { ready: true, repoRoot: args.repoRoot, branch: args.branch, commit: f.pr.sourceCommit };
  } };
  const first = await (await createUpdater(options))();
  assert.equal(first.dispatched, 0);
  assert.equal(first.lastError, null);
  assert.match(first.holding, /diverged/);
  assert.match(first.pullRequests[0].dispatchHold, /diverged/);
  const { readJobs, summarize } = await engine("pr-updater/lib/telemetry.mjs");
  const jobs = readJobs(f.config.telemetryFile);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, "blocked");
  assert.equal(summarize(jobs).blocked, 1);
  assert.equal(summarize(jobs).failed, 0);
  for (let scan = 0; scan < 3; scan++) {
    const result = await (await createUpdater(options))();
    assert.equal(result.dispatched, 0);
    assert.match(result.holding, /diverged/);
  }
  assert.equal(attempts, 1);
  assert.equal(readJobs(f.config.telemetryFile).length, 1);
  revision = "fixed"; blocked = false;
  assert.equal((await (await createUpdater(options))()).dispatched, 1);
  assert.equal(attempts, 2);
  assert.equal(f.store.task("OFF-123").session_id, "original-session");
});

test("two updater lanes racing one recovered creator produce only one continuation", async t => {
  const f = creatorFixture(t);
  let entered;
  const preparing = new Promise(resolve => { entered = resolve; });
  let proceed;
  const resume = new Promise(resolve => { proceed = resolve; });
  let attempts = 0;
  const options = { ...f.options, callBohemia: async (_name, args) => {
    attempts++; entered(); await resume;
    return { ready: true, repoRoot: args.repoRoot, branch: args.branch, commit: f.pr.sourceCommit };
  } };
  const first = await createUpdater(options), second = await createUpdater(options);
  const running = first();
  await preparing;
  const other = await second();
  assert.equal(other.dispatched, 0);
  assert.match(other.holding, /Another runner/);
  proceed();
  assert.equal((await running).dispatched, 1);
  assert.equal(attempts, 1);
  assert.equal(f.store.tasks().length, 1);
  assert.equal(f.store.task("OFF-123").session_id, "original-session");
});

test("transient preparation cooldown applies to unchanged evidence, not repaired code or a changed checkout", async t => {
  const f = creatorFixture(t);
  let revision = "before", attempts = 0;
  const options = { ...f.options, preparationEvidence: () => revision, callBohemia: async (_name, args) => {
    attempts++;
    if (revision === "before") throw new Error("fixture transient network failure");
    return { ready: true, repoRoot: args.repoRoot, branch: args.branch, commit: f.pr.sourceCommit };
  } };
  assert.equal((await (await createUpdater(options))()).dispatched, 0);
  assert.equal((await (await createUpdater(options))()).dispatched, 0);
  assert.equal(attempts, 1);
  revision = "repaired";
  assert.equal((await (await createUpdater(options))()).dispatched, 1);
  assert.equal(attempts, 2);
});

test("malformed result comments produce explicit failed verification instead of waiting forever", async t => {
  const f = creatorFixture(t);
  const scan = await createUpdater({ ...f.options, callBohemia: async (_name, args) =>
    ({ ready: true, branch: args.branch, commit: f.pr.sourceCommit, repoRoot: args.repoRoot }) });
  await scan();
  const task = f.store.task("OFF-123");
  task.comments = [{ author: "perf", message: "PR_UPDATE_RESULT: {}\nafter: 733369" }];
  writeJson(task.file, task);
  renameSync(task.file, path.join(f.store.queues, "failed", "OFF-123.json"));
  await scan();
  const proof = readJson(path.join(f.store.records, "verification-OFF-123.json"));
  assert.equal(proof.ok, false);
  assert.match(proof.reason, /Malformed creator result/);
  assert.equal(proof.submissionId, f.store.metadata(task.id).key);
});

test("feedback disposition policy is preserved independently of the legacy transport", async () => {
  const { agencyFindings } = await engine("pr-updater/lib/triggers.mjs");
  const threads = [{ id: 1, status: "active", comments: [
    { author: { id: "agency" }, content: "**Blocking** Fix this", commentType: "text", publishedDate: "2026-09-14T01:00:00Z" },
    { author: { uniqueName: "owner" }, content: "Investigating", commentType: "text", publishedDate: "2026-09-14T02:00:00Z" },
  ] }];
  const options = { agencyAuthorId: "agency", authorAccount: "owner" };
  assert.deepEqual(agencyFindings(threads, { ...options, creatorRouting: true }),
    agencyFindings(threads, { ...options, requireDisposition: true }));
});

for (const change of ["none", "body", "timestamp", "head", "description", "new finding", "blocked", "missing receipt"]) {
  test(`historical answered feedback is revalidated across restart and older fallback: ${change}`, async t => {
    const f = creatorFixture(t);
    const { reviewFindings } = await engine("lib/creator-review.mjs");
    f.ado.listOwnPullRequests = async () => [{ ...f.pr, description: f.pr.description?.slice(0, 20) }];
    const thread = id => ({ id, status: "active", comments: [{
      id: 1, commentType: "text", author: { uniqueName: "reviewer@example.test", displayName: "Reviewer" },
      content: `Question ${id}`, publishedDate: `2026-09-${id === 1 ? "09" : "10"}T00:00:00Z`,
    }] });
    const threads = [thread(1), thread(2)];
    f.ado.listThreads = async () => threads;
    f.pr.mergeStatus = "succeeded";
    f.pr.description = "Original description\nVerified answer 1\nVerified answer 2";
    const key = "verified-review-before-restart";
    const contract = { version: 2, submissionId: key, fingerprint: "review:2026-09-10T00:00:00.000Z",
      prId: f.pr.id, head: f.pr.sourceCommit, branch: f.pr.branch, agent: "perf", responseMode: "pr_description",
      descriptionBaseline: "Original description", findings: reviewFindings(threads, f.config) };
    const result = { submissionId: key, fingerprint: contract.fingerprint, head: f.pr.sourceCommit,
      findings: contract.findings.map(finding => ({ threadId: finding.threadId, disposition: "answered",
        evidence: "Reproduced the requested behavior", descriptionEvidence: `Verified answer ${finding.threadId}`,
        verification: { command: "targeted reproduction", expected: "matching output", actual: "matching output" } })) };
    threads[1].status = "fixed";
    if (change === "body") threads[0].comments[0].content += " additional requirement";
    if (change === "timestamp") threads[0].comments[0].lastUpdatedDate = "2026-09-11T00:00:00Z";
    if (change === "head") f.pr.sourceCommit = "b".repeat(40);
    if (change === "description") f.pr.description = "Original description";
    if (change === "new finding") threads.push(thread(3));
    if (change === "blocked") result.findings[0].disposition = "blocked";
    const task = f.store.task("OFF-123");
    task.comments = [{ author: "perf", message: `PR_UPDATE_RESULT: ${JSON.stringify(result)}` }];
    writeJson(task.file, task);
    if (change !== "missing receipt") writeJson(path.join(f.store.records, `${digest(key)}.json`), {
      key, taskId: task.id, prId: f.pr.id, phase: "published", contract,
    });
    let preparations = 0;
    const options = { ...f.options, callBohemia: async (_name, args) => {
      preparations++;
      return { ready: true, branch: args.branch, commit: f.pr.sourceCommit, repoRoot: args.repoRoot };
    } };
    const first = await (await createUpdater(options))();
    assert.equal(first.dispatched, 1);
    if (change === "none") {
      assert.equal(f.store.metadata(task.id).contract.previousAnswerSubmissionId, key);
      assert.equal(f.store.metadata(task.id).contract.descriptionBaseline, "Original description");
      assert.equal((await (await createUpdater(options))()).dispatched, 0);
      assert.equal(preparations, 1);
    }

  });
}

test("creator contracts preserve the full description, not the truncated list response", async t => {
  const f = creatorFixture(t);
  f.pr.description = "Existing description ".repeat(80);
  f.ado.listOwnPullRequests = async () => [{ ...f.pr, description: f.pr.description.slice(0, 400) }];
  const scan = await createUpdater({ ...f.options, callBohemia: async (_name, args) =>
    ({ ready: true, branch: args.branch, commit: f.pr.sourceCommit, repoRoot: args.repoRoot }) });
  assert.equal((await scan()).dispatched, 1);
  assert.equal(f.store.metadata("OFF-123").contract.descriptionBaseline, f.pr.description);
});

