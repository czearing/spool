import assert from "node:assert/strict";
import test from "node:test";
import { extractPullRequestId, findWorkItemForPullRequest, submitAgentTask } from "../lib/paperclip.mjs";

const config = {
  paperclipApiUrl: "http://paperclip.test",
  paperclipCompanyId: "comp-1",
  paperclipProjectId: "proj-1",
  paperclipAgentId: "agent-updater",
  runtimeDirectory: "test-runtime",
};

test("extractPullRequestId extracts from options, submissionId, or body", () => {
  assert.equal(extractPullRequestId("repo:agent:5683578:fingerprint:0", "body", { pr: { id: "5683578" } }), "5683578");
  assert.equal(extractPullRequestId("repo:agent:5683578:fingerprint:0", "body"), "5683578");
  assert.equal(extractPullRequestId("custom-id", "Update PR 5684445 please"), "5684445");
  assert.equal(extractPullRequestId("custom-id", "https://office.visualstudio.com/OC/_git/repo/pullrequest/5684826"), "5684826");
});

test("findWorkItemForPullRequest finds the original work item and ignores updater tasks", async () => {
  const fakeIssues = [
    { id: "iss-1", title: "PR 5683578 needs an update", status: "done" },
    { id: "iss-2", title: "Review Azure DevOps pull request #5683578", status: "done" },
    { id: "iss-3", title: "[Livesite] flaky test in loop-page-container", status: "in_review", description: "PR: 5683578" },
  ];

  const fetchImpl = async (url) => {
    assert.ok(url.includes("5683578"));
    return { ok: true, json: async () => fakeIssues };
  };

  const found = await findWorkItemForPullRequest(config, "5683578", {}, fetchImpl);
  assert.equal(found?.id, "iss-3");
  assert.equal(found?.title, "[Livesite] flaky test in loop-page-container");
});

test("submitAgentTask assigns the updating task on the existing work item when present", async () => {
  const fakeIssues = [
    { id: "work-123", title: "[Livesite] flaky test", status: "in_review", description: "PR 5683578" },
  ];

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (url.includes("/issues?q=")) {
      return { ok: true, json: async () => fakeIssues };
    }
    if (url.includes("/issues/work-123") && options.method === "PATCH") {
      return { ok: true, json: async () => ({ id: "work-123", status: "todo", assigneeAgentId: "agent-updater" }) };
    }
    if (url.includes("/comments") && options.method === "POST") {
      return { ok: true, json: async () => ({ id: "comment-1" }) };
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const result = await submitAgentTask(config, "agent-updater", "Please fix the failing lint check", "repo:updater:5683578:conf:0", {}, fetchImpl);

  assert.equal(result.id, "work-123");
  assert.equal(result.status, "todo");

  const patchCall = calls.find((c) => c.method === "PATCH");
  assert.ok(patchCall, "PATCH was sent to reassign work item");
  assert.equal(patchCall.body.assigneeAgentId, "agent-updater");
  assert.equal(patchCall.body.status, "todo");

  assert.ok(patchCall.body.comment.includes("Please fix the failing lint check"), "instructions are attached atomically with the wake");
});

test("submitAgentTask falls back to creating a new issue when no work item exists", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (url.includes("/issues?q=")) {
      return { ok: true, json: async () => [] };
    }
    if (url.includes("/issues") && options.method === "POST") {
      return { ok: true, json: async () => ({ id: "new-issue-1", status: "todo", title: options.body ? JSON.parse(options.body).title : "" }) };
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const result = await submitAgentTask(config, "agent-updater", "New PR update body", "repo:updater:9999999:conf:0", {}, fetchImpl);
  assert.equal(result.id, "new-issue-1");
  const postCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues"));
  assert.ok(postCall, "POST created a new issue");
  assert.equal(postCall.body.assigneeAgentId, "agent-updater");
});
