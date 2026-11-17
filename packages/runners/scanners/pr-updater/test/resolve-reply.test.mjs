import assert from "node:assert/strict";
import test from "node:test";
import { reviewFindings, validateReviewResult } from "../../lib/creator-review.mjs";
import { resolveAnsweredThreads } from "../lib/resolve-guard.mjs";

function fixture() {
  const config = { authorAccount: "owner@example.invalid", botAccounts: [] };
  const pr = { id: "123", status: "active", branch: "user/topic", sourceCommit: "a".repeat(40),
    author: config.authorAccount, description: "Unchanged description" };
  const threads = [{ id: 42, status: "active", comments: [{
    id: 1, commentType: "text", publishedDate: "2026-10-16T19:48:00Z",
    author: { uniqueName: "reviewer@example.invalid", displayName: "Reviewer" },
    content: "Seems unrelated?",
  }] }];
  const contract = { version: 2, prId: pr.id, branch: pr.branch, head: pr.sourceCommit,
    at: "2026-10-16T20:06:00Z", submissionId: "review:42", fingerprint: "review:42",
    responseMode: "pr_thread", replyThreadIds: ["42"], findings: reviewFindings(threads, config) };
  const result = { submissionId: contract.submissionId, fingerprint: contract.fingerprint,
    head: pr.sourceCommit, findings: [{ threadId: "42", disposition: "answered",
      evidence: "Reproduced the fixture timeout without preloading.",
      reply: "The preloads preserve the required assertions and deadlines.",
      verification: { command: "targeted regression", expected: "unchanged assertions", actual: "passed" } }] };
  const writes = [];
  const ado = {
    getPullRequest: async () => pr,
    listThreads: async () => threads,
    addThreadComment: async () => assert.fail("Resolution must never post comments"),
    updateThreadStatus: async (_config, _pr, id, status) => {
      writes.push({ id, status });
      threads[0].status = status;
    },
  };
  const existingReply = () => {
    threads[0].comments.push({ id: 2, commentType: "text", content: result.findings[0].reply,
      author: { uniqueName: pr.author }, publishedDate: "2026-10-16T20:07:00Z" });
    result.findings[0].responseCommentId = "2";
  };
  return { config, prId: pr.id, pr, threads, contract, result, threadIds: ["42"], ado, writes, existingReply };
}

test("a description edit cannot silently resolve a legacy human-thread answer", async () => {
  const f = fixture();
  f.result.findings[0].descriptionEvidence = f.pr.description;
  assert.equal((await resolveAnsweredThreads(f)).refused, true);
  assert.deepEqual(f.writes, []);
});

test("legacy reply evidence is read back without posting or repeating comments", async () => {
  const f = fixture();
  assert.equal((await resolveAnsweredThreads(f)).refused, true);
  f.existingReply();
  assert.deepEqual((await resolveAnsweredThreads(f)).resolved, ["42"]);
  assert.equal(validateReviewResult(f.contract, f.result, f.pr, f.threads).ok, true);
  assert.deepEqual(f.writes, [{ id: "42", status: "fixed" }]);
  assert.equal(f.threads[0].comments.length, 2);
});

for (const change of ["head", "feedback", "evidence", "submission", "closed PR", "edited reply", "deleted reply", "author", "date", "bot"]) {
  test(`legacy reply resolution refuses ${change} without posting`, async () => {
    const f = fixture();
    f.existingReply();
    if (change === "head") f.pr.sourceCommit = "b".repeat(40);
    if (change === "feedback") f.threads[0].comments[0].content = "New feedback";
    if (change === "evidence") f.result.findings[0].verification.actual = "";
    if (change === "submission") f.result.submissionId = "another";
    if (change === "closed PR") f.pr.status = "completed";
    if (change === "edited reply") f.threads[0].comments[1].content = "Different reply";
    if (change === "deleted reply") f.threads[0].comments[1].isDeleted = true;
    if (change === "author") f.threads[0].comments[1].author.uniqueName = "another@example.invalid";
    if (change === "date") f.threads[0].comments[1].publishedDate = "2026-10-16T19:00:00Z";
    if (change === "bot") f.config.botAccounts.push("reviewer@example.invalid");
    assert.equal((await resolveAnsweredThreads(f)).refused, true);
    assert.deepEqual(f.writes, []);
  });
}

test("a purported fix still requires a pushed change, not just an existing reply", async () => {
  const f = fixture();
  f.existingReply();
  f.result.findings[0].disposition = "fixed";
  assert.equal((await resolveAnsweredThreads(f)).refused, true);
  f.pr.sourceCommit = f.result.head = "b".repeat(40);
  f.pr.sourceCommitDate = "2026-10-16T20:06:30Z";
  assert.deepEqual((await resolveAnsweredThreads(f)).resolved, ["42"]);
  assert.equal(validateReviewResult(f.contract, f.result, f.pr, f.threads).ok, true);
});
