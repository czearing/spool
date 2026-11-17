import assert from "node:assert/strict";
import test from "node:test";
import { reviewFindings, validateReviewResult } from "../../lib/creator-review.mjs";
import { replyToReviewThreads, resolveAnsweredThreads } from "../lib/resolve-guard.mjs";
import { addThreadComment } from "../lib/azure-devops.mjs";

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
      reply: "The preloads let the required validation pass without changing assertions or deadlines.",
      verification: { command: "targeted regression", expected: "unchanged assertions", actual: "passed" } }] };
  const writes = [];
  const ado = {
    getPullRequest: async () => pr,
    listThreads: async () => threads,
    addThreadComment: async (_config, _pr, id, content) => {
      writes.push({ kind: "reply", id, content });
      const comment = { id: 2, commentType: "text", content, author: { uniqueName: pr.author },
        publishedDate: "2026-10-16T20:07:00Z" };
      threads[0].comments.push(comment);
      return comment;
    },
    updateThreadStatus: async (_config, _pr, id, status) => {
      writes.push({ kind: "status", id, status });
      threads[0].status = status;
    },
  };
  return { config, prId: pr.id, pr, threads, contract, result, threadIds: ["42"], ado, writes };
}

test("a description edit cannot silently resolve a human review question", async () => {
  const f = fixture();
  f.result.findings[0].descriptionEvidence = f.pr.description;
  assert.equal((await resolveAnsweredThreads(f)).refused, true);
  assert.deepEqual(f.writes, []);
});

test("post a visible reply before resolution and independently verify completion", async () => {
  const f = fixture();
  assert.deepEqual((await replyToReviewThreads(f)).replied, ["42"]);
  assert.equal(f.result.findings[0].responseCommentId, "2");
  assert.equal(f.threads[0].status, "active", "Posting does not silently resolve feedback");
  assert.equal(validateReviewResult(f.contract, f.result, f.pr, f.threads).ok, false);
  assert.deepEqual((await resolveAnsweredThreads(f)).resolved, ["42"]);
  assert.equal(validateReviewResult(f.contract, f.result, f.pr, f.threads).ok, true);
  assert.deepEqual(f.writes.map(write => write.kind), ["reply", "status"]);
  assert.equal(f.pr.description, "Unchanged description");
});

for (const change of ["head", "feedback", "evidence", "submission", "closed PR", "empty reply", "bot"]) {
  test(`reply refuses ${change} before posting or resolving`, async () => {
    const f = fixture();
    if (change === "head") f.pr.sourceCommit = "b".repeat(40);
    if (change === "feedback") f.threads[0].comments[0].content = "New feedback";
    if (change === "evidence") f.result.findings[0].verification.actual = "";
    if (change === "submission") f.result.submissionId = "another";
    if (change === "closed PR") f.pr.status = "completed";
    if (change === "empty reply") f.result.findings[0].reply = " ";
    if (change === "bot") {
      f.config.botAccounts.push("reviewer@example.invalid");
      f.contract.findings = reviewFindings(f.threads, { ...f.config, botAccounts: [] });
    }
    assert.equal((await replyToReviewThreads(f)).refused, true);
    assert.deepEqual(f.writes, []);
  });
}

test("a retry after a lost acknowledgement does not post a duplicate reply", async () => {
  const f = fixture(), post = f.ado.addThreadComment;
  f.ado.addThreadComment = async (...args) => {
    await post(...args);
    throw new Error("Lost acknowledgement");
  };
  await assert.rejects(replyToReviewThreads(f), /Lost acknowledgement/);
  assert.deepEqual((await replyToReviewThreads(f)).replied, ["42"]);
  assert.equal(f.writes.length, 1);
  assert.equal(f.result.findings[0].responseCommentId, "2");
});

test("edited or deleted replies cannot count as verified answers", async () => {
  const f = fixture();
  await replyToReviewThreads(f);
  f.threads[0].comments[1].content = "Different reply";
  assert.equal((await resolveAnsweredThreads(f)).refused, true);
  f.threads[0].status = "fixed";
  assert.equal(validateReviewResult(f.contract, f.result, f.pr, f.threads).ok, false);
});

test("feedback arriving while posting stays unresolved and is reported explicitly", async () => {
  const f = fixture(), post = f.ado.addThreadComment;
  f.ado.addThreadComment = async (...args) => {
    const comment = await post(...args);
    f.threads[0].comments[0].content = "New feedback";
    return comment;
  };
  const result = await replyToReviewThreads(f);
  assert.deepEqual(result.failed, ["42"]);
  assert.equal(f.result.findings[0].responseCommentId, undefined);
  assert.equal(f.threads[0].status, "active");
});

test("fixed human findings also require a visible reply", async () => {
  const f = fixture();
  f.result.findings[0].disposition = "fixed";
  f.pr.sourceCommit = f.result.head = "b".repeat(40);
  f.pr.sourceCommitDate = "2026-10-16T20:06:30Z";
  f.threads[0].status = "fixed";
  assert.equal(validateReviewResult(f.contract, f.result, f.pr, f.threads).ok, false);
  await replyToReviewThreads(f);
  assert.equal(validateReviewResult(f.contract, f.result, f.pr, f.threads).ok, true);
});

test("the sparing-comment policy permits a verified fix without a gratuitous reply", async () => {
  const f = fixture();
  f.contract.replyPolicy = "when_needed";
  f.result.findings[0].disposition = "fixed";
  delete f.result.findings[0].reply;
  f.pr.sourceCommit = f.result.head = "b".repeat(40);
  f.pr.sourceCommitDate = "2026-10-16T20:06:30Z";
  assert.deepEqual((await resolveAnsweredThreads(f)).resolved, ["42"]);
  assert.equal(validateReviewResult(f.contract, f.result, f.pr, f.threads).ok, true);
  assert.deepEqual(f.writes.map(write => write.kind), ["status"]);
});

for (const disposition of ["answered", "disproved", "fixed"]) {
  test(`the sparing-comment policy still verifies ${disposition} replies rather than accepting a description edit`, async () => {
    const f = fixture();
    f.contract.replyPolicy = "when_needed";
    f.result.findings[0].disposition = disposition;
    if (disposition === "fixed") {
      f.pr.sourceCommit = f.result.head = "b".repeat(40);
      f.pr.sourceCommitDate = "2026-10-16T20:06:30Z";
    }
    assert.equal((await resolveAnsweredThreads(f)).refused, true);
    assert.deepEqual(f.writes, []);
    await replyToReviewThreads(f);
    assert.deepEqual((await resolveAnsweredThreads(f)).resolved, ["42"]);
    assert.equal(validateReviewResult(f.contract, f.result, f.pr, f.threads).ok, true);
  });
}

test("a purported fix cannot be described as fixed before it is pushed", async () => {
  const f = fixture();
  f.result.findings[0].disposition = "fixed";
  assert.equal((await replyToReviewThreads(f)).refused, true);
  assert.deepEqual(f.writes, []);
});

test("concurrent retries post only one reply", async () => {
  const f = fixture();
  const outcomes = await Promise.all([replyToReviewThreads(f), replyToReviewThreads(f)]);
  assert.ok(outcomes.every(outcome => outcome.replied[0] === "42"));
  assert.equal(f.writes.length, 1);
});

test("a later refused thread does not hide an earlier verified reply", async () => {
  const f = fixture();
  const second = structuredClone(f.threads[0]);
  second.id = 43;
  f.threads.push(second);
  f.contract.findings = reviewFindings(f.threads, f.config);
  f.contract.replyThreadIds.push("43");
  f.result.findings.push({ ...f.result.findings[0], threadId: "43" });
  f.threadIds.push("43");
  const post = f.ado.addThreadComment;
  f.ado.addThreadComment = async (...args) => {
    const reply = await post(...args);
    second.comments[0].content = "New feedback";
    return reply;
  };
  const result = await replyToReviewThreads(f);
  assert.equal(result.refused, true);
  assert.deepEqual(result.replied, ["42"]);
  assert.equal(f.result.findings[0].responseCommentId, "2");
  assert.equal(f.writes.length, 1);
});

test("a reply by another author or before the assignment is not completion evidence", async () => {
  const f = fixture();
  await replyToReviewThreads(f);
  const reply = f.threads[0].comments[1];
  reply.author.uniqueName = "another@example.invalid";
  assert.equal((await resolveAnsweredThreads(f)).refused, true);
  reply.author.uniqueName = f.pr.author;
  reply.publishedDate = "2026-10-16T19:00:00Z";
  assert.equal((await resolveAnsweredThreads(f)).refused, true);
});

test("the Azure DevOps writer posts inside the existing thread, not a new PR thread", async () => {
  let request;
  const reply = await addThreadComment({ organization: "https://dev.azure.com/example",
    project: "project", repository: "repo" }, "123", "42", "Verified reply", {
    token: "fixture-token",
    fetchImpl: async (url, options) => {
      request = { url, ...options };
      return new Response(JSON.stringify({ id: 2, content: "Verified reply" }),
        { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.match(request.url, /pullRequests\/123\/threads\/42\/comments\?api-version=7\.1$/);
  assert.equal(request.method, "POST");
  assert.deepEqual(JSON.parse(request.body), { content: "Verified reply", parentCommentId: 1, commentType: 1 });
  assert.equal(reply.id, 2);
});
