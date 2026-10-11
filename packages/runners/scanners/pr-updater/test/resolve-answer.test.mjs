import assert from "node:assert/strict";
import test from "node:test";
import { reviewFindings, reuseDescriptionAnswerBaseline, validateReviewResult } from "../../lib/creator-review.mjs";
import { resolveAnsweredThreads } from "../lib/resolve-guard.mjs";

function fixture() {
  const config = { authorAccount: "owner@example.invalid", botAccounts: [] };
  const pr = { id: "123", status: "active", branch: "user/topic", sourceCommit: "a".repeat(40),
    description: "Original description\nMeasured explanation: repeated requests reuse the cached promise." };
  const threads = [{ id: 42, status: "active", comments: [{
    id: 1, commentType: "text", publishedDate: "2026-09-25T00:00:00Z",
    author: { uniqueName: "reviewer@example.invalid", displayName: "Reviewer" },
    content: "Should this be preloaded once?",
  }] }];
  const contract = { version: 2, prId: "123", branch: pr.branch, head: pr.sourceCommit,
    submissionId: "original", fingerprint: "review:42", responseMode: "pr_description",
    descriptionBaseline: "Original description", findings: reviewFindings(threads, config) };
  const result = { submissionId: contract.submissionId, fingerprint: contract.fingerprint,
    head: pr.sourceCommit, findings: [{
      threadId: "42", disposition: "answered", evidence: "Measured and published",
      descriptionEvidence: "Measured explanation: repeated requests reuse the cached promise.",
      verification: { command: "cache regression test", expected: "same promise", actual: "same promise" },
    }] };
  const writes = [];
  const ado = { getPullRequest: async () => pr, listThreads: async () => threads,
    updateThreadStatus: async (_config, _pr, id, status) => {
      writes.push({ id, status }); threads.find(t => String(t.id) === id).status = status;
    } };
  return { config, prId: pr.id, pr, threads, contract, result, threadIds: ["42"], ado, writes };
}

test("a published clarification is incomplete while its thread is open, and completes after guarded resolution", async () => {
  const f = fixture();
  assert.equal(validateReviewResult(f.contract, f.result, f.pr, f.threads).ok, false);
  const resolved = await resolveAnsweredThreads(f);
  assert.deepEqual(resolved.resolved, ["42"]);
  assert.equal(validateReviewResult(f.contract, f.result, f.pr, f.threads).ok, true);
  assert.equal(f.pr.sourceCommit, f.contract.head, "A clarification must not require a manufactured code commit");
});

for (const change of ["head", "feedback", "baseline", "evidence", "submission", "closed PR"]) {
  test(`answer resolution refuses ${change} changes without touching the thread`, async () => {
    const f = fixture();
    if (change === "head") f.pr.sourceCommit = "b".repeat(40);
    if (change === "feedback") f.threads[0].comments[0].content = "New unresolved defect";
    if (change === "baseline") f.contract.descriptionBaseline = f.pr.description;
    if (change === "evidence") f.result.findings[0].verification.actual = "";
    if (change === "submission") f.result.submissionId = "other";
    if (change === "closed PR") f.pr.status = "completed";
    assert.equal((await resolveAnsweredThreads(f)).refused, true);
    assert.deepEqual(f.writes, []);
  });
}

test("new feedback arriving during resolution is reopened instead of falsely reported resolved", async () => {
  const f = fixture();
  const update = f.ado.updateThreadStatus;
  f.ado.updateThreadStatus = async (...args) => {
    await update(...args);
    if (args[3] === "fixed") f.threads[0].comments[0].content = "New feedback";
  };
  const result = await resolveAnsweredThreads(f);
  assert.deepEqual(result.failed, ["42"]);
  assert.deepEqual(result.resolved, []);
  assert.equal(f.threads[0].status, "active");
});

test("an unchanged published answer survives a retry baseline without rewriting the answer", () => {
  const f = fixture();
  const next = { ...f.contract, submissionId: "continuation", descriptionBaseline: f.pr.description };
  const restored = reuseDescriptionAnswerBaseline(next, f.contract, f.result, f.pr);
  assert.equal(restored.descriptionBaseline, f.contract.descriptionBaseline);
  assert.equal(restored.previousAnswerSubmissionId, f.contract.submissionId);
  f.pr.sourceCommit = "b".repeat(40);
  assert.equal(reuseDescriptionAnswerBaseline(next, f.contract, f.result, f.pr), next);
});

test("a write failure propagates and an unpersisted status is never reported as resolved", async () => {
  const f = fixture();
  f.ado.updateThreadStatus = async () => { throw new Error("Write failed"); };
  await assert.rejects(resolveAnsweredThreads(f), /Write failed/);
  f.ado.updateThreadStatus = async () => {};
  const result = await resolveAnsweredThreads(f);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(result.failed, ["42"]);
});

test("a pushed revision during answer resolution causes the thread to be reopened", async () => {
  const f = fixture(), update = f.ado.updateThreadStatus;
  f.ado.updateThreadStatus = async (...args) => {
    await update(...args);
    if (args[3] === "fixed") f.pr.sourceCommit = "b".repeat(40);
  };
  const result = await resolveAnsweredThreads(f);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(result.failed, ["42"]);
  assert.equal(f.threads[0].status, "active");
});

test("a disproved finding also requires a published explanation and a resolved thread", async () => {
  const f = fixture();
  f.result.findings[0].disposition = "disproved";
  assert.equal(validateReviewResult(f.contract, f.result, f.pr, f.threads).ok, false);
  assert.deepEqual((await resolveAnsweredThreads(f)).resolved, ["42"]);
  assert.equal(validateReviewResult(f.contract, f.result, f.pr, f.threads).ok, true);
});
