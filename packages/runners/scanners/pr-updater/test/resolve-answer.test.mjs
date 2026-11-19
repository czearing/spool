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

test("an unchanged published fix can finish a retried review without manufacturing another commit", async () => {
  const f = fixture();
  const previous = { ...f.contract, responseMode: "pr_thread", replyPolicy: "when_needed",
    replyThreadIds: ["42"] };
  f.pr.sourceCommit = "b".repeat(40);
  f.pr.sourceCommitDate = "2026-09-26T00:00:00Z";
  f.result.head = f.pr.sourceCommit;
  f.result.findings[0].disposition = "fixed";
  const next = { ...previous, submissionId: "retry", head: f.pr.sourceCommit };
  f.contract = reuseDescriptionAnswerBaseline(next, previous, f.result, f.pr);
  assert.equal(f.contract.head, previous.head);
  f.result.submissionId = f.contract.submissionId;
  assert.deepEqual((await resolveAnsweredThreads(f)).resolved, ["42"]);
  assert.equal(validateReviewResult(f.contract, f.result, f.pr, f.threads).ok, true);
  const changed = { ...next, fingerprint: "new-feedback" };
  assert.equal(reuseDescriptionAnswerBaseline(changed, previous, { ...f.result,
    submissionId: previous.submissionId }, f.pr), changed);
  const newHead = { ...f.pr, sourceCommit: "c".repeat(40) };
  assert.equal(reuseDescriptionAnswerBaseline(next, previous, { ...f.result,
    submissionId: previous.submissionId }, newHead), next);
});

test("runner resolution retains a proven description-mode fix baseline but still enforces the feedback timestamp", async () => {
  const f = fixture(), previous = { ...f.contract, resolutionMode: "runner" };
  f.pr.sourceCommit = "b".repeat(40);
  f.pr.sourceCommitDate = "2026-09-24T00:00:00Z";
  f.result.head = f.pr.sourceCommit;
  f.result.findings[0].disposition = "fixed";
  const next = { ...previous, submissionId: "retry", fingerprint: "review-retry", head: f.pr.sourceCommit };
  f.contract = reuseDescriptionAnswerBaseline(next, previous, f.result, f.pr);
  assert.equal(f.contract.head, f.pr.sourceCommit);
  assert.equal(f.contract.fixBaselineHead, previous.head);
  f.contract.previousFixSubmissionId = f.contract.previousAnswerSubmissionId;
  delete f.contract.previousAnswerSubmissionId;
  f.contract.fixBaselineThreadIds = ["another-finding"];
  f.result.submissionId = f.contract.submissionId;
  f.result.fingerprint = f.contract.fingerprint;
  assert.equal((await resolveAnsweredThreads(f)).refused, true);
  assert.deepEqual(f.writes, []);
  f.pr.sourceCommitDate = "2026-09-26T00:00:00Z";
  assert.equal((await resolveAnsweredThreads(f)).refused, true);
  assert.equal(validateReviewResult(f.contract, f.result, f.pr, [{ ...f.threads[0], status: "fixed" }]).ok, false);
  assert.deepEqual(f.writes, []);
  f.contract.fixBaselineThreadIds = ["42"];
  assert.deepEqual((await resolveAnsweredThreads(f)).resolved, ["42"]);
  assert.equal(validateReviewResult(f.contract, f.result, f.pr, f.threads).ok, true);
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

function descriptionFixFixture() {
  const f = fixture();
  f.threads[0].comments[0].content = "### PR description\nClarify the measurement setup.\n<!-- unslop-review v1 kind:description -->";
  f.contract.findings = reviewFindings(f.threads, f.config);
  f.contract.resolutionMode = "runner";
  f.result.findings[0].disposition = "fixed";
  return f;
}

test("a confirmed description-only fix resolves with new published evidence and no fabricated source push", async () => {
  const f = descriptionFixFixture();
  assert.equal(validateReviewResult(f.contract, f.result, f.pr, f.threads).ok, false);
  assert.deepEqual((await resolveAnsweredThreads(f)).resolved, ["42"]);
  assert.equal(validateReviewResult(f.contract, f.result, f.pr, f.threads).ok, true);
  assert.equal(f.pr.sourceCommit, f.contract.head);
});

for (const change of ["missing marker", "code context", "missing excerpt", "unchanged description", "new commit without description fix"]) {
  test(`description fixes cannot bypass ${change}`, async () => {
    const f = descriptionFixFixture();
    if (change === "missing marker") f.threads[0].comments[0].content = "Fix this code";
    if (change === "code context") f.threads[0].threadContext = { filePath: "/src/code.ts" };
    if (change === "missing excerpt") f.result.findings[0].descriptionEvidence = "";
    if (change === "unchanged description") f.contract.descriptionBaseline = f.pr.description;
    if (change === "new commit without description fix") {
      f.pr.sourceCommit = "b".repeat(40);
      f.pr.sourceCommitDate = "2026-09-26T00:00:00Z";
      f.result.head = f.pr.sourceCommit;
      f.result.findings[0].descriptionEvidence = "";
    }
    f.contract.findings = reviewFindings(f.threads, f.config);
    assert.equal(validateReviewResult(f.contract, f.result, f.pr, [{ ...f.threads[0], status: "fixed" }]).ok, false);
    assert.equal((await resolveAnsweredThreads(f)).refused, true);
    assert.deepEqual(f.writes, []);
  });
}

test("a retried description fix preserves only its published description baseline, never a code-fix baseline", () => {
  const f = descriptionFixFixture();
  const next = { ...f.contract, submissionId: "continuation", descriptionBaseline: f.pr.description };
  const restored = reuseDescriptionAnswerBaseline(next, f.contract, f.result, f.pr);
  assert.equal(restored.descriptionBaseline, f.contract.descriptionBaseline);
  assert.equal(restored.previousAnswerSubmissionId, f.contract.submissionId);
  assert.equal(restored.fixBaselineHead, undefined);
  assert.equal(restored.fixBaselineThreadIds, undefined);
});

for (const disposition of ["answered", "fixed"]) {
  for (const phase of ["before write", "after write"]) {
    test(`${disposition} description evidence changing ${phase} is not falsely resolved`, async () => {
      const f = disposition === "fixed" ? descriptionFixFixture() : fixture();
      if (phase === "before write") {
        let reads = 0;
        f.ado.getPullRequest = async () => {
          if (++reads === 2) f.pr.description = "Replacement without the verified excerpt";
          return f.pr;
        };
      } else {
        const update = f.ado.updateThreadStatus;
        f.ado.updateThreadStatus = async (...args) => {
          await update(...args);
          if (args[3] === "fixed") f.pr.description = "Replacement without the verified excerpt";
        };
      }
      const outcome = await resolveAnsweredThreads(f);
      assert.deepEqual(outcome.resolved, []);
      assert.deepEqual(outcome.failed, ["42"]);
      assert.equal(f.threads[0].status, "active");
      if (phase === "before write") assert.deepEqual(f.writes, []);
    });
  }
}
