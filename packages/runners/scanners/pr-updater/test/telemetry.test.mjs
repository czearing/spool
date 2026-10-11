/**
 * The durable job record and the message the agent receives.
 *
 * Two things are asserted here that nothing else can: that a half-written line from a kill does not
 * hide the history, and that the task body stays as small as it was designed to be. The prompt is
 * injected on the same turn, so anything restated in the body is paid for twice.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderDashboard } from "../lib/dashboard.mjs";
import { submissionId, taskBody } from "../lib/prompt.mjs";
import { jobBlocked, jobDispatched, jobDone, jobFailed, jobPrepared, jobQueued, jobStarted, readJobs, reconcileSupersededPreparations, summarize } from "../lib/telemetry.mjs";

function scratch() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-")), "jobs.jsonl");
}

const pr = { id: "5622136", url: "https://example/pr/5622136", branch: "user/caleb/composer" };

test("preparation incompatibilities render as blocked, not failed, done or running", t => {
  const file = scratch();
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  jobQueued(file, { jobId: "blocked", prId: pr.id, at: "2026-09-17T12:00:00Z" });
  jobBlocked(file, { jobId: "blocked", at: "2026-09-17T12:00:01Z", reason: "Interrupted merge is diverged; work preserved" });
  const jobs = readJobs(file), summary = summarize(jobs);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.done, 0);
  assert.equal(summary.running, 0);
  const html = renderDashboard({ status: { open: 1, actionable: 1 }, jobs, actions: [], summary });
  assert.match(html, /1 blocked/);
  assert.match(html, /preparation blocked/);
  assert.match(html, /Interrupted merge is diverged/);
});

test("a job folds into one row that keeps every field it was given", () => {
  const file = scratch();
  jobQueued(file, { jobId: "j1", prId: pr.id, prUrl: pr.url, trigger: "conflict", reason: "merge conflict", at: "2026-03-01T12:00:00.000Z" });
  jobPrepared(file, { jobId: "j1", at: "2026-03-01T12:01:00.000Z", ms: 4200, steps: { totalMs: 4200 }, branch: pr.branch, conflicts: ["a.ts"] });
  jobDispatched(file, { jobId: "j1", at: "2026-03-01T12:01:05.000Z", agent: "pr-updater", submissionId: "j1", body: "PR 5622136" });
  jobDone(file, { jobId: "j1", at: "2026-03-01T12:31:00.000Z", agentMs: 1_795_000, updateMs: 1_860_000, outcome: "completed" });

  const [job] = readJobs(file);
  assert.equal(job.state, "done");
  assert.equal(job.prId, pr.id, "the pull request survives three later lines");
  assert.equal(job.trigger, "conflict");
  assert.equal(job.setupMs, 4200);
  assert.deepEqual(job.conflicts, ["a.ts"]);
  assert.equal(job.agent, "pr-updater");
});

test("a truncated line is skipped rather than losing the history", () => {
  const file = scratch();
  jobQueued(file, { jobId: "j1", prId: pr.id, trigger: "review", reason: "1 comment", at: "2026-03-01T12:00:00.000Z" });
  fs.appendFileSync(file, '{"jobId":"j2","state":"que');
  jobQueued(file, { jobId: "j3", prId: "999", trigger: "agency", reason: "1 finding", at: "2026-03-01T13:00:00.000Z" });

  const jobs = readJobs(file);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].jobId, "j3", "newest first");
});

test("an empty log is not an error", () => {
  assert.deepEqual(readJobs(path.join(os.tmpdir(), "does-not-exist", "jobs.jsonl")), []);
});

test("a dispatched job that never reported back is counted as stalled", () => {
  const now = Date.parse("2026-03-01T18:00:00.000Z");
  const jobs = [
    { state: "dispatched", at: "2026-03-01T12:00:00.000Z", setupMs: 4000 },
    { state: "dispatched", at: "2026-03-01T17:50:00.000Z", setupMs: 8000 },
    { state: "done", at: "2026-03-01T13:00:00.000Z", setupMs: 6000 },
    { state: "failed", at: "2026-03-01T13:00:00.000Z" },
    { state: "queued", at: "2026-03-01T17:59:00.000Z" },
  ];
  const summary = summarize(jobs, now);
  assert.deepEqual(
    { total: summary.total, running: summary.running, stalled: summary.stalled, done: summary.done, failed: summary.failed, queued: summary.queued },
    { total: 5, running: 2, stalled: 1, done: 1, failed: 1, queued: 1 },
  );
  assert.equal(summary.medianSetupMs, 6000);
});

test("a failure summarises the error and keeps the rest as detail", () => {
  const file = scratch();
  jobFailed(file, { jobId: "j1", at: "2026-03-01T12:00:00.000Z", phase: "prepare", error: new Error("dirty tree\n  at somewhere") });
  assert.equal(readJobs(file)[0].error, "Error: dirty tree");
  assert.equal(readJobs(file)[0].detail, "at somewhere");
});

test("superseded exclusive preparations become durable failures without terminating live work", (t) => {
  const file = scratch();
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const queue = (jobId, issueId, prId, at) => {
    jobQueued(file, { jobId, issueId, prId, at });
    jobStarted(file, { jobId, at });
  };
  queue("creator:old", "issue", "7", "2026-09-11T12:00:00Z");
  queue("creator:other-issue", "other", "7", "2026-09-11T12:00:00Z");
  queue("creator:other-pr", "issue", "8", "2026-09-11T12:00:00Z");
  queue("legacy", "issue", "7", "2026-09-11T12:00:00Z");
  queue("creator:dispatched", "issue", "7", "2026-09-11T12:00:00Z");
  jobDispatched(file, { jobId: "creator:dispatched", at: "2026-09-11T12:00:01Z" });
  queue("creator:new", "issue", "7", "2026-09-12T12:00:00Z");
  assert.deepEqual(reconcileSupersededPreparations(file), ["creator:old"]);
  const old = readJobs(file).find((job) => job.jobId === "creator:old");
  assert.equal(old.state, "failed");
  assert.equal(old.phase, "prepare");
  assert.match(old.error, /superseded by exclusive creator attempt creator:new/);
  const size = fs.statSync(file).size;
  assert.deepEqual(reconcileSupersededPreparations(file), []);
  assert.equal(fs.statSync(file).size, size, "reconciliation is idempotent");
  assert.equal(readJobs(file).filter((job) => job.state === "in_progress").length, 4);
});

test("terminal blocked and unsuccessful outcomes count as failures, not completed work", () => {
  const summary = summarize([
    ...["blocked", "failed", "cancelled", "timed_out", "expired"].map((outcome) => ({ state: "done", outcome })),
    { state: "done", outcome: "completed" }, { state: "done" },
  ]);
  assert.equal(summary.failed, 5);
  assert.equal(summary.done, 2);
});

test("the task body says only what the standing prompt cannot know", () => {
  const body = taskBody(
    { trigger: "conflict", reason: "merge conflict" },
    { pr, prepared: { branch: pr.branch, merge: { files: ["a.ts", "b.ts"] } } },
  );
  assert.deepEqual(body.split("\n"), [
    "PR 5622136",
    "https://example/pr/5622136",
    "Conflicts: a.ts, b.ts",
    "user/caleb/composer is checked out and verified clean. Do not run an upfront baseline check; proceed directly to addressing the feedback.",
  ]);
  assert.ok(body.length < 300, "the prompt is injected on the same turn, so this stays tiny");
  assert.equal(body.toLowerCase().includes("bohemia_pr_update"), false, "tooling is the prompt's job");
});

test("the served url is mentioned only when a server was actually started", () => {
  const served = taskBody({ trigger: "review", reason: "2 comment(s) from Christian Gonzalez" }, {
    pr,
    prepared: { branch: pr.branch, server: { url: "http://127.0.0.1:4183" } },
  });
  assert.ok(served.includes("served at http://127.0.0.1:4183"));

  const bare = taskBody({ trigger: "review", reason: "1 comment(s) from A" }, { pr });
  assert.equal(bare.includes("checked out"), false, "nothing was prepared, so nothing is claimed");
});

test("a submission id is stable per cause and distinct per retry", () => {
  const first = submissionId("office-bohemia-repo-1", "5622136", "conflict:abc", 0);
  assert.equal(first, "office-bohemia-repo-1:pr-updater:5622136:conflict-abc:0");
  assert.equal(submissionId("office-bohemia-repo-1", "5622136", "conflict:abc", 0), first, "the harness drops a reused id");
  assert.notEqual(submissionId("office-bohemia-repo-1", "5622136", "conflict:abc", 7), first);
});

test("the dashboard escapes anything a reviewer could have typed", () => {
  const html = renderDashboard({
    status: { agent: "pr-updater", lastScan: "2026-03-01T12:00:00.000Z", pullRequests: [] },
    jobs: [{ jobId: "j1", prId: "1", state: "done", trigger: "review", reason: "<script>alert(1)</script>", at: "2026-03-01T12:00:00.000Z" }],
    summary: summarize([]),
  });
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("<html"), "still a whole document");
});

test("the dashboard renders before any job has ever run", () => {
  const html = renderDashboard({ status: null, jobs: [], summary: summarize([]) });
  assert.ok(html.includes("<html"));
});
