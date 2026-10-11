import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createPaperclipQueue } from "../src/queue/paperclip-queue.js";
import { createMemoryQueue } from "../src/queue/memory-queue.js";

function recordingFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const next = responses.shift() ?? { ok: true, status: 200, body: "[]" };
    return {
      ok: next.ok,
      status: next.status,
      text: async () => next.body,
    };
  };
  return { calls, fetchImpl };
}

function makeQueue(responses, options = {}) {
  const { calls, fetchImpl } = recordingFetch(responses);
  const queue = createPaperclipQueue({
    baseUrl: "https://queue.example/",
    apiKey: "key",
    companyId: "company",
    runId: "run",
    sourceIssueId: "source-issue",
    env: {},
    fetchImpl,
    ...options,
  });
  return { queue, calls };
}

test("listing issues reads the company collection", async () => {
  const { queue, calls } = makeQueue([{ ok: true, status: 200, body: JSON.stringify([{ id: "a" }]) }]);
  const issues = await queue.listIssues();
  assert.deepEqual(issues, [{ id: "a" }]);
  assert.equal(calls[0].url, "https://queue.example/api/companies/company/issues");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers["X-Paperclip-Run-Id"], "run");
});

test("a wrapped collection reads the same as a bare array", async () => {
  const { queue } = makeQueue([{ ok: true, status: 200, body: JSON.stringify({ issues: [{ id: "b" }] }) }]);
  assert.deepEqual(await queue.listIssues(), [{ id: "b" }]);
});

test("an unreadable collection is an error rather than an empty list", async () => {
  const { queue } = makeQueue([{ ok: false, status: 500, body: "boom" }]);
  await assert.rejects(() => queue.listIssues(), /failed with 500/);
});

test("cancelling sets the status and carries the reason", async () => {
  const { queue, calls } = makeQueue([{ ok: true, status: 200, body: JSON.stringify({ id: "a", status: "cancelled" }) }]);
  await queue.cancelIssue("a", "the pull request is no longer eligible");
  assert.equal(calls[0].method, "PATCH");
  assert.equal(calls[0].url, "https://queue.example/api/issues/a");
  assert.deepEqual(calls[0].body, {
    status: "cancelled",
    comment: "the pull request is no longer eligible",
  });
});

test("an update sends only what it was given", async () => {
  const { queue, calls } = makeQueue([{ ok: true, status: 200, body: "{}" }]);
  await queue.updateIssue("a", { status: "done" });
  assert.deepEqual(calls[0].body, { status: "done" });
});

test("the memory queue answers the same three questions", async () => {
  const queue = createMemoryQueue();
  const created = await queue.createIssue({ title: "one", description: "body" });
  assert.deepEqual((await queue.listIssues()).map((issue) => issue.id), [created.id]);
  await queue.cancelIssue(created.id);
  assert.equal((await queue.getIssue(created.id)).status, "cancelled");
  assert.equal(await queue.updateIssue("absent", { status: "done" }), null);
});

test("a refusal carries its code even when the sentence is truncated away", async () => {
  const filler = "x".repeat(600);
  const body = JSON.stringify({
    error: `${filler}`,
    details: { code: "issue_write_assignee_run_lock", boundary: "Run checkout lock" },
  });
  const { queue } = makeQueue([{ ok: false, status: 409, body }]);

  const error = await queue.updateIssue("issue-1", { title: "t", description: "d" }).then(
    () => null,
    (thrown) => thrown,
  );

  assert.equal(error.code, "issue_write_assignee_run_lock");
  assert.equal(error.status, 409);
  assert.equal(error.details.boundary, "Run checkout lock");
  assert.match(error.message, /issue_write_assignee_run_lock/);
  assert.equal(error.message.includes("x".repeat(200)), true);
});

test("a refusal with no readable body is still an error with its status", async () => {
  const { queue } = makeQueue([{ ok: false, status: 502, body: "bad gateway" }]);
  const error = await queue.getIssue("issue-1").then(
    () => null,
    (thrown) => thrown,
  );
  assert.equal(error.status, 502);
  assert.equal(error.code, undefined);
  assert.equal(error.details, null);
});

test("a queue built from a timer woken run holds its writes instead of sending them", async () => {
  const { queue, calls } = makeQueue([], { sourceIssueId: null });
  const error = await queue.updateIssue("issue-1", { status: "done" }).then(
    () => null,
    (thrown) => thrown,
  );
  assert.equal(error.held, true);
  assert.equal(error.code, "cross_issue_influence_run_context_required");
  assert.equal(queue.runContext.attributable, false);
  assert.deepEqual(calls, [], "a held write must never leave the process");
});

test("a queue built from a timer woken run still reads and still opens new work", async () => {
  const { queue, calls } = makeQueue(
    [
      { ok: true, status: 200, body: JSON.stringify([{ id: "a" }]) },
      { ok: true, status: 200, body: JSON.stringify({ id: "new" }) },
    ],
    { sourceIssueId: null },
  );
  assert.deepEqual(await queue.listIssues(), [{ id: "a" }]);
  assert.deepEqual(await queue.createIssue({ title: "t", description: "d" }), { id: "new" });
  assert.deepEqual(calls.map((call) => call.method), ["GET", "POST"]);
});

test("the run context is read from the wake environment when it is not configured", async () => {
  const { queue } = makeQueue([{ ok: true, status: 200, body: "{}" }], {
    runId: undefined,
    sourceIssueId: undefined,
    env: { PAPERCLIP_RUN_ID: "env-run", PAPERCLIP_TASK_ID: "env-issue" },
  });
  assert.equal(queue.runContext.attributable, true);
  assert.equal(queue.runContext.runId, "env-run");
});

test("a live run context refusal is raised as a hold rather than a failure", async () => {
  const body = JSON.stringify({
    error: "Cross-issue writes need a run to attribute them to (Heartbeat run context).",
    details: { code: "cross_issue_influence_run_context_required", boundary: "Heartbeat run context" },
  });
  const { queue } = makeQueue([{ ok: false, status: 403, body }]);
  const error = await queue.updateIssue("issue-1", { status: "done" }).then(
    () => null,
    (thrown) => thrown,
  );
  assert.equal(error.held, true);
  assert.equal(error.status, 403);
  assert.equal(error.details.boundary, "Heartbeat run context");
});

test("a run lock refusal stays a deferral and is not turned into a hold", async () => {
  const body = JSON.stringify({
    error: "locked",
    details: { code: "issue_write_assignee_run_lock" },
  });
  const { queue } = makeQueue([{ ok: false, status: 409, body }]);
  const error = await queue.updateIssue("issue-1", { status: "done" }).then(
    () => null,
    (thrown) => thrown,
  );
  assert.equal(error.held, undefined);
  assert.equal(error.code, "issue_write_assignee_run_lock");
});
