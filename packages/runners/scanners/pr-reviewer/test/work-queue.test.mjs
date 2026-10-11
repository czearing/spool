import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { taskBody } from "../lib/work-queue.mjs";

const pr = {
  id: "123",
  title: "Improve notebook cards",
  url: "https://dev.azure.com/office/OC/_git/office-bohemia/pullrequest/123",
  repository: "office-bohemia",
  author: "author@microsoft.com",
  sourceBranch: "refs/heads/user/author/notebook-cards",
  targetBranch: "refs/heads/master",
  sourceCommit: "abc123",
};

test("queued intent does not invent a prepared workspace", () => {
  const body = taskBody(pr);

  assert.match(body, /Review Azure DevOps pull request #123/);
  assert.match(body, /Source commit: abc123/);
  assert.match(body, /Phase: Initial review; start immediately even if CI is still running/);
  assert.doesNotMatch(body, /is checked out|verified clean|dependencies are already/);
  assert.match(body, /PATCH the current PAPERCLIP_TASK_ID to done/);
  assert.match(body, /Missing ADO MCP tools alone is not a blocker/);
});

test("only verified preparation adds checkout instructions", () => {
  const body = taskBody(pr, {}, {
    branch: "review/pr-123-abc123", repoRoot: "C:\\Code\\bohemia\\office-bohemia-3", sourceCommit: pr.sourceCommit,
  });
  assert.match(body, /Branch: review\/pr-123-abc123/);
  assert.match(body, /The branch review\/pr-123-abc123 is checked out in C:\\Code\\bohemia\\office-bohemia-3 at the source commit and verified clean/);
  assert.match(body, /Do not run git checkout, fetch, reset, or clean; proceed directly to code analysis and review/);
});

test("revision labels never claim CI passed without evidence", () => {
  const body = taskBody(pr, { phase: "revision" });
  assert.match(body, /Phase: Re-review of a stable new source revision/);
  assert.doesNotMatch(body, /CI-passed/);
});

test("Spool review handoffs use native completion and durable local evidence", () => {
  const workspace = { branch: "review/pr-123-abc123", repoRoot: "C:\\Work\\review", sourceCommit: pr.sourceCommit };
  for (const phase of ["initial", "revision"]) {
    const body = taskBody(pr, { phase, transport: "spool" }, workspace);
    assert.doesNotMatch(body, /PAPERCLIP_TASK_ID|PAPERCLIP_RUN_ID|X-Paperclip-Run-Id|Do not post PR comments/);
    for (const tool of ["spool_add_comment", "spool_update_task_status", "spool_get_task"]) assert.ok(body.includes(tool));
    assert.match(body, /no separate evidence service is required/);
    assert.match(body, /do not repeat completed external actions/);
    assert.match(body, /If blocked, save the exact cause and mark the task failed/);
  }
});

test("legacy review handoff still matches the independently captured Paperclip bytes", () => {
  const sourceCommit = "af35b3fcfd7c52c06294c07d24c3a557a2ff428e";
  const body = taskBody({
    id: "5758261", title: "[new-office] add initial chat pane", sourceCommit,
    url: "https://dev.azure.com/office/OC/_git/office-bohemia/pullrequest/5758261",
  }, {}, {
    branch: "review/pr-5758261-af35b3f", repoRoot: "C:\\Code\\bohemia\\office-bohemia-3", sourceCommit,
  });
  assert.equal(Buffer.byteLength(body), 1353);
  assert.equal(createHash("sha256").update(body).digest("hex"),
    "a4fd999f0fd54b525648c28edabb4d7fe6636fb000f7cb3737106838c67af647");
});
