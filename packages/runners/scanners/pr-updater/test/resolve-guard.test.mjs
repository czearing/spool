/**
 * The proof-of-push gate on resolving a review thread.
 *
 * Regression coverage for PR 5678017 (office-bohemia): an agent implemented a fix, never pushed
 * it, and still called the resolve tool. The thread showed fixed while the pushed branch kept the
 * original bug. These tests pin the behavior that closes that hole.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { commitIsPushed, resolveGuard, resolveThreads, threadFeedbackDate, resolveCreatorFindings } from "../lib/resolve-guard.mjs";
import { reviewFindings } from "../../lib/creator-review.mjs";

for (const scenario of ["answer", "fix", "changed feedback", "changed head", "missing evidence", "failed write",
  "feedback race", "failed build", "unknown commit date"]) {
  test(`runner resolution uses the common evidence guards without posting comments: ${scenario}`, async () => {
    const config = { authorAccount: "owner@example.test" };
    const thread = { id: 42, status: "active", comments: [{ id: 1, commentType: "text",
      author: { uniqueName: "reviewer@example.test" }, content: "Verify the cursor behavior.",
      publishedDate: "2026-09-09T00:00:00Z" }] };
    const current = { id: "123", status: "active", branch: "user/fix", sourceCommit: "b".repeat(40),
      sourceCommitDate: "2026-09-10T00:00:00Z", description: "Original\nVerified cursor reproduction." };
    const contract = { version: 2, prId: "123", submissionId: "job", fingerprint: "feedback",
      resolutionMode: "runner", responseMode: "pr_description", head: "a".repeat(40),
      branch: current.branch, descriptionBaseline: "Original", findings: reviewFindings([thread], config) };
    const fixed = ["fix", "unknown commit date"].includes(scenario);
    const result = { submissionId: "job", fingerprint: "feedback", head: current.sourceCommit,
      findings: [{ threadId: "42", disposition: fixed ? "fixed" : "answered",
        evidence: "Direct cursor reproduction", descriptionEvidence: "Verified cursor reproduction.",
        verification: { command: "cursor-test", expected: "cursor retained", actual: "cursor retained" } }] };
    if (scenario === "changed feedback") thread.comments[0].content += " New requirement.";
    if (scenario === "missing evidence") delete result.findings[0].verification;
    if (scenario === "unknown commit date") delete current.sourceCommitDate;
    if (scenario === "failed build") {
      contract.repair = { type: "build" };
      result.repair = { evidence: "Build attempted",
        verification: { command: "check", expected: "passed", actual: "failed" } };
    }
    const writes = [];
    const ado = { getPullRequest: async () => scenario === "changed head"
      ? { ...current, sourceCommit: "c".repeat(40) } : current,
    listThreads: async () => [thread], updateThreadStatus: async (_config, _id, _thread, status) => {
      writes.push(status);
      if (scenario !== "failed write") thread.status = status;
      if (scenario === "feedback race" && status === "fixed") thread.comments[0].content += " Changed during write.";
    } };
    const resolve = () => resolveCreatorFindings({ config, contract, result, pr: current,
      threads: [thread], builds: [{ result: "failed", status: "completed" }], ado });
    if (["answer", "fix"].includes(scenario)) {
      await resolve();
      assert.deepEqual(writes, ["fixed"]);
      assert.equal(thread.status, "fixed");
    } else {
      await assert.rejects(resolve);
      assert.equal(thread.status, "active");
      if (!["failed write", "feedback race"].includes(scenario)) assert.deepEqual(writes, []);
    }
  });
}

const pr = {
  id: "5678017",
  sourceCommit: "48e99e4dfabc78117b06ab519721d03a475afa6a",
  sourceCommitDate: "2026-09-09T03:00:00.000Z",
  author: "caleb@example.com",
};

test("a commit matching the pull request's source commit is recognized as pushed", () => {
  assert.equal(commitIsPushed(pr, "48e99e4dfabc78117b06ab519721d03a475afa6a"), true);
});

test("a short prefix of the pushed commit is still recognized", () => {
  assert.equal(commitIsPushed(pr, "48e99e4dfabc"), true);
});

test("a commit the pull request does not have is not pushed", () => {
  // This is exactly the shape of the failure on PR 5678017: an agent's local, uncommitted fix
  // has no sha the branch's actual head would ever match.
  assert.equal(commitIsPushed(pr, "deadbeefcafefeedfacefeedfacefeedfacefeed"), false);
});

test("an unreadable pull request never counts as pushed", () => {
  assert.equal(commitIsPushed(null, "48e99e4dfabc"), false);
  assert.equal(commitIsPushed(undefined, "48e99e4dfabc"), false);
});

test("a sha too short to trust is rejected even if it happens to be a prefix", () => {
  assert.equal(commitIsPushed(pr, "48e"), false);
  assert.equal(commitIsPushed({ id: "x", sourceCommit: "48e" }, "48e99e4dfabc"), false);
});

test("the guard allows resolving once the commit matches the pushed head", () => {
  const guard = resolveGuard({ pr, commit: "48e99e4dfabc78117b06ab519721d03a475afa6a" });
  assert.equal(guard.allowed, true);
});

test("the guard refuses when no commit is given", () => {
  const guard = resolveGuard({ pr, commit: "" });
  assert.equal(guard.allowed, false);
  assert.match(guard.reason, /no commit sha was given/);
});

test("the guard refuses when the pull request could not be read", () => {
  const guard = resolveGuard({ pr: null, commit: "48e99e4dfabc" });
  assert.equal(guard.allowed, false);
  assert.match(guard.reason, /could not be read/);
});

test("the guard refuses and names both commits when the given sha is not the pushed head", () => {
  const guard = resolveGuard({ pr, commit: "0000000000000000000000000000000000000000" });
  assert.equal(guard.allowed, false);
  assert.match(guard.reason, /is not pull request 5678017's current pushed source commit/);
  assert.match(guard.reason, /48e99e4dfabc78117b06ab519721d03a475afa6a/);
});

test("threadFeedbackDate extracts the newest reviewer comment timestamp", () => {
  const thread = {
    id: 1,
    publishedDate: "2026-09-09T01:00:00.000Z",
    comments: [
      {
        commentType: "text",
        author: { uniqueName: "reviewer@example.com" },
        publishedDate: "2026-09-09T01:30:00.000Z",
      },
      {
        commentType: "text",
        author: { uniqueName: "reviewer@example.com" },
        publishedDate: "2026-09-09T02:00:00.000Z",
      },
    ],
  };
  assert.equal(threadFeedbackDate(thread, "caleb@example.com"), "2026-09-09T02:00:00.000Z");
});

test("threadFeedbackDate ignores author replies when computing feedback date", () => {
  const thread = {
    id: 1,
    publishedDate: "2026-09-09T01:00:00.000Z",
    comments: [
      {
        commentType: "text",
        author: { uniqueName: "reviewer@example.com" },
        publishedDate: "2026-09-09T01:30:00.000Z",
      },
      {
        commentType: "text",
        author: { uniqueName: "caleb@example.com" },
        publishedDate: "2026-09-09T03:30:00.000Z",
      },
    ],
  };
  assert.equal(threadFeedbackDate(thread, "caleb@example.com"), "2026-09-09T01:30:00.000Z");
});

test("the guard refuses when the commit was authored before the review feedback", () => {
  const threads = [
    {
      id: 72796163,
      publishedDate: "2026-09-09T04:00:00.000Z",
      comments: [
        {
          commentType: "text",
          author: { uniqueName: "agency" },
          publishedDate: "2026-09-09T04:00:00.000Z",
        },
      ],
    },
  ];

  const guard = resolveGuard({
    pr, // sourceCommitDate is 03:00:00
    commit: "48e99e4dfabc78117b06ab519721d03a475afa6a",
    threads,
    threadIds: ["72796163"],
  });

  assert.equal(guard.allowed, false);
  assert.match(guard.reason, /predates review feedback in thread 72796163/);
});

test("the guard allows when the commit was authored after the review feedback", () => {
  const threads = [
    {
      id: 72796163,
      publishedDate: "2026-09-09T02:00:00.000Z",
      comments: [
        {
          commentType: "text",
          author: { uniqueName: "agency" },
          publishedDate: "2026-09-09T02:00:00.000Z",
        },
      ],
    },
  ];

  const guard = resolveGuard({
    pr, // sourceCommitDate is 03:00:00
    commit: "48e99e4dfabc78117b06ab519721d03a475afa6a",
    threads,
    threadIds: ["72796163"],
  });

  assert.equal(guard.allowed, true);
});

function fakeAdo({ pr: prToReturn, threads: threadsToReturn = [], closed = [] }) {
  return {
    getPullRequest: async () => prToReturn,
    listThreads: async () => threadsToReturn,
    updateThreadStatus: async (config, prId, threadId, status) => {
      closed.push({ prId, threadId, status });
      return true;
    },
  };
}

test("resolveThreads writes nothing when the commit was never pushed", async () => {
  const closed = [];
  const logs = [];
  const ado = fakeAdo({ pr, closed });

  const result = await resolveThreads({
    config: {},
    prId: "5678017",
    commit: "deadbeefcafefeedfacefeedfacefeedfacefeed",
    threadIds: ["72519459"],
    ado,
    log: (message) => logs.push(message),
  });

  assert.equal(result.refused, true);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(closed, [], "no Azure DevOps write happened");
  assert.ok(logs.some((line) => line.includes("Refusing to resolve")));
});

test("resolveThreads writes nothing when the commit predates the feedback", async () => {
  const closed = [];
  const logs = [];
  const threads = [
    {
      id: "72796163",
      publishedDate: "2026-09-09T05:00:00.000Z",
      comments: [
        {
          commentType: "text",
          author: { uniqueName: "agency" },
          publishedDate: "2026-09-09T05:00:00.000Z",
        },
      ],
    },
  ];
  const ado = fakeAdo({ pr, threads, closed });

  const result = await resolveThreads({
    config: {},
    prId: "5678017",
    commit: "48e99e4dfabc78117b06ab519721d03a475afa6a",
    threadIds: ["72796163"],
    ado,
    log: (message) => logs.push(message),
  });

  assert.equal(result.refused, true);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(closed, []);
  assert.ok(logs.some((line) => line.includes("predates review feedback")));
});

test("resolveThreads writes only once the commit matches the pushed head and postdates feedback", async () => {
  const closed = [];
  const threads = [
    {
      id: "72519459",
      publishedDate: "2026-09-09T01:00:00.000Z",
      comments: [
        {
          commentType: "text",
          author: { uniqueName: "reviewer@example.com" },
          publishedDate: "2026-09-09T01:00:00.000Z",
        },
      ],
    },
    {
      id: "72461236",
      publishedDate: "2026-09-09T02:00:00.000Z",
      comments: [
        {
          commentType: "text",
          author: { uniqueName: "reviewer@example.com" },
          publishedDate: "2026-09-09T02:00:00.000Z",
        },
      ],
    },
  ];
  const ado = fakeAdo({ pr, threads, closed });

  const result = await resolveThreads({
    config: {},
    prId: "5678017",
    commit: "48e99e4dfabc78117b06ab519721d03a475afa6a",
    threadIds: ["72519459", "72461236"],
    ado,
    log: () => {},
  });

  assert.equal(result.refused, false);
  assert.deepEqual(result.resolved, ["72519459", "72461236"]);
  assert.equal(closed.length, 2);
  assert.deepEqual(closed[0], { prId: "5678017", threadId: "72519459", status: "fixed" });
});

test("resolveThreads reports a failed pull request read as a refusal rather than throwing", async () => {
  const ado = {
    getPullRequest: async () => {
      throw new Error("Azure DevOps 503");
    },
    updateThreadStatus: async () => true,
  };

  const result = await resolveThreads({
    config: {},
    prId: "5678017",
    commit: "48e99e4dfabc78117b06ab519721d03a475afa6a",
    threadIds: ["72519459"],
    ado,
    log: () => {},
  });

  assert.equal(result.refused, true);
  assert.deepEqual(result.resolved, []);
});

test("resolveThreads reports per-thread write failures without refusing the whole batch", async () => {
  const ado = {
    getPullRequest: async () => pr,
    listThreads: async () => [],
    updateThreadStatus: async (config, prId, threadId) => {
      if (threadId === "bad") throw new Error("Azure DevOps 404 closing thread bad");
      return true;
    },
  };

  const result = await resolveThreads({
    config: {},
    prId: "5678017",
    commit: "48e99e4dfabc78117b06ab519721d03a475afa6a",
    threadIds: ["72519459", "bad"],
    ado,
    log: () => {},
  });

  assert.equal(result.refused, false);
  assert.deepEqual(result.resolved, ["72519459"]);
  assert.deepEqual(result.failed, ["bad"]);
});
