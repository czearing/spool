import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { enqueueReview, queuedReviews, retryAttempt, taskBody, taskFileName } from "../lib/work-queue.mjs";

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

test("resuming an unfinished review takes priority over new assignments without reordering either group", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-recovery-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [
    { pr: { ...pr, id: "1", repository: "repo-retry-name" } },
    { pr: { ...pr, id: "2" } },
    { pr: { ...pr, id: "3" }, retryOf: "saved-3", retryUpdatedAt: "2026-11-16T20:04:20Z" },
    { pr: { ...pr, id: "4" }, retryOf: "saved-4", retryUpdatedAt: "2026-11-16T20:04:21Z" },
  ];
  for (const [index, entry] of entries.entries()) {
    await enqueueReview(root, entry.pr, entry);
    const time = new Date(index * 1000);
    await utimes(path.join(root, taskFileName(entry.pr, entry)), time, time);
  }
  assert.deepEqual(await queuedReviews(root),
    [entries[2], entries[3], entries[0], entries[1]].map(entry => taskFileName(entry.pr, entry)));
});

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

test("Bohemia and 1JS share the same minimal handoff and round-trip retry identity", () => {
  const workspaces = [
    { branch: "review/pr-123-abc123", repoRoot: "C:\\Code\\bohemia\\office-bohemia-3",
      dependencyRepair: { packages: ["@office/fixture"] } },
    { branch: "review/pr-123-abc123", repoRoot: "C:\\control",
      dependencyRepair: { packages: ["@1js/library-module-ux"] },
      execution: { kind: "codespace", nativeRepoRoot: "/workspaces/1JS" } },
  ];
  const assignment = [
    "Review Azure DevOps pull request #123: Improve notebook cards",
    `PR URL: ${pr.url}`,
    "Source commit: abc123",
    "Branch: review/pr-123-abc123",
  ].join("\n");
  for (const workspace of workspaces) for (const phase of ["initial", "revision"]) {
    assert.equal(taskBody({ ...pr, preserveExistingVote: true }, { phase, transport: "spool" }, workspace), assignment);
    const retry = { retryOf: "original-task", retryUpdatedAt: "2026-10-27T17:08:23Z" };
    const body = taskBody(pr, { phase, transport: "spool", ...retry }, workspace);
    assert.equal(body, `${assignment}\nRetry of failed Harness task: original-task\nRetry failure updated at: ${retry.retryUpdatedAt}`);
    assert.deepEqual(retryAttempt(body), retry);
  }
});

test("unsuccessful shared preparation adds exactly the requested warning without build logs", () => {
  const warning = "The build was not successful please additionally debug and ensure your review branch is settup properly";
  for (const execution of [undefined, { kind: "codespace", nativeRepoRoot: "/workspaces/1JS" }]) {
    const workspace = { branch: "review/pr-123-abc123", repoRoot: "C:\\control",
      packagePreparation: { buildWarmed: false, buildError: "Detailed private build log output" }, execution };
    const body = taskBody(pr, { transport: "spool" }, workspace);
    assert.equal(body.split("\n").filter(line => line === warning).length, 1);
    assert.doesNotMatch(body, /Detailed private build log output/);
    assert.match(body, /Source commit: abc123/);
    assert.match(body, /Branch: review\/pr-123-abc123/);
  }
});
