import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readPublication } from "../../packages/bohemia-agent-tooling/src/publications.js";
import { recoverSpoolCreator, resolveSpoolCreator } from "../creator-routing.mjs";
import { recoverLibraryCreator } from "../library-creator-recovery.mjs";
import { readJson, writeJson } from "../spool-store.mjs";
import { fixture } from "./fixtures.mjs";

function setup(t) {
  const f = fixture(t), taskId = "original-library", sessionId = randomUUID();
  f.put({ id: taskId, agent: "software-engineer", session_id: sessionId, workspace: null,
    session_config: { agent: "software-engineer", workspace: f.root } }, "completed");
  const context = { version: 1, originKind: "spool", taskId, agent: "software-engineer",
    sessionId, workspace: null, branch: null };
  const contextFile = path.join(f.store.records, "creator-contexts", `${taskId}.json`);
  writeJson(contextFile, context);
  const pr = { id: "123", url: "https://dev.azure.com/office/Office/_git/1JS/pullrequest/123",
    branch: "user/original-library", status: "active", sourceCommit: "a".repeat(40) };
  const request = { type: "tool.execution_start", timestamp: "2026-10-21T00:00:00Z", data: {
    toolName: "repository-repo_pr", toolCallId: "publication", arguments: {
      repo: "1js", input: { action: "create", sourceBranch: pr.branch, repoRoot: f.workspace },
    },
  } };
  const result = { type: "tool.execution_complete", timestamp: "2026-10-21T00:01:00Z", data: {
    toolCallId: "publication", success: true, result: { structuredContent: {
      ok: true, ready: true, pullRequestId: 123, url: pr.url, repoRoot: f.workspace,
      commit: "a".repeat(40), targetCommit: "b".repeat(40), validationScope: {
        verified: { packageBuild: true, productionBundle: true, lint: true, typecheck: true, tests: true },
      },
    } },
  } };
  const logFile = path.join(f.root, "logs", `${taskId}.log`);
  mkdirSync(path.dirname(logFile));
  const saveLog = () => writeFileSync(logFile, [request, result].map(value => JSON.stringify(value)).join("\n") + "\n");
  saveLog();
  return { ...f, pr, context, contextFile, taskId, sessionId, request, result, saveLog, logFile,
    config: { repositoryProfile: "1js", agentWorkspaces: { "software-engineer": f.workspace } },
    client: { getPullRequest: async () => pr } };
}

test("recover an implicit native creator from its actual successful checked Library creation", async t => {
  const f = setup(t);
  const before = readFileSync(f.store.task(f.taskId).file, "utf8");
  await recoverSpoolCreator(f.store, f.pr, f.client, f.config);
  const owner = resolveSpoolCreator(f.store, f.pr);
  assert.equal(owner.taskId, f.taskId);
  assert.equal(owner.sessionId, f.sessionId);
  assert.equal(owner.workspace, f.workspace);
  assert.equal(owner.originKind, "mcp");
  assert.equal(owner.publications[0].creationEvidence.toolCallId, "publication");
  assert.equal(owner.publications[0].creationEvidence.requestSha256.length, 64);
  assert.equal(readFileSync(f.store.task(f.taskId).file, "utf8"), before);
  const original = readPublication(f.pr.url, f.store.publicationDirectory);
  await recoverSpoolCreator(f.store, f.pr, f.client, f.config);
  assert.deepEqual(readPublication(f.pr.url, f.store.publicationDirectory), original);
  assert.equal(readJson(path.join(f.store.records, "native-creators", `${f.taskId}.json`)), null);
});

for (const mutation of [
  "wrong-call", "failed-result", "wrong-pr", "wrong-url", "wrong-workspace", "failed-check",
  "update-not-create", "wrong-repo", "wrong-branch", "wrong-session", "wrong-context-root",
  "unassigned-workspace", "wrong-profile", "active-task",
]) {
  test(`creator recovery refuses ${mutation}`, async t => {
    const f = setup(t), output = f.result.data.result.structuredContent;
    if (mutation === "wrong-call") f.result.data.toolCallId = "other";
    if (mutation === "failed-result") f.result.data.success = false;
    if (mutation === "wrong-pr") output.pullRequestId = 456;
    if (mutation === "wrong-url") output.url += "4";
    if (mutation === "wrong-workspace") output.repoRoot = f.root;
    if (mutation === "failed-check") output.validationScope.verified.tests = false;
    if (mutation === "update-not-create") f.request.data.arguments.input.action = "update";
    if (mutation === "wrong-repo") f.request.data.arguments.repo = "bohemia";
    if (mutation === "wrong-branch") f.request.data.arguments.input.sourceBranch = "another";
    if (mutation === "wrong-session") writeJson(f.contextFile, { ...f.context, sessionId: "different" });
    if (mutation === "wrong-context-root") writeJson(f.contextFile, { ...f.context, workspace: f.workspace });
    if (mutation === "unassigned-workspace") f.config.agentWorkspaces = {};
    if (mutation === "wrong-profile") f.config.repositoryProfile = "bohemia";
    f.saveLog();
    if (mutation === "active-task") {
      const task = f.store.task(f.taskId);
      f.store.task = () => ({ ...task, status: "in_progress" });
    }
    assert.equal(await recoverLibraryCreator(f.store, f.pr, f.client, f.config), null);
    assert.equal(readJson(path.join(f.store.records, "native-creators", `${f.taskId}.json`)), null);
  });
}

test("creator recovery rejects changed PRs but never constrains a task to its historical PR", async t => {
  const f = setup(t);
  f.client.getPullRequest = async () => ({ ...f.pr, branch: "other" });
  await assert.rejects(recoverLibraryCreator(f.store, f.pr, f.client, f.config), /changed during/);
  f.client.getPullRequest = async () => f.pr;
  writeJson(path.join(f.store.records, "native-creators", `${f.taskId}.json`), {
    verified: true, prId: "different", taskId: f.taskId,
  });
  const recovered = await recoverLibraryCreator(f.store, f.pr, f.client, f.config);
  assert.equal(recovered.prId, f.pr.id);
  assert.equal(readJson(path.join(f.store.records, "native-creators", `${f.taskId}.json`)).prId, "different");
});

test("recovery requires a unique native author, not a branch-name guess", async t => {
  const f = setup(t), other = "another-author";
  f.put({ id: other, agent: "software-engineer", session_id: "another-session", workspace: null,
    session_config: { agent: "software-engineer", workspace: f.root } }, "completed");
  writeJson(path.join(f.store.records, "creator-contexts", `${other}.json`), {
    ...f.context, taskId: other, sessionId: "another-session",
  });
  writeFileSync(path.join(f.root, "logs", `${other}.log`), readFileSync(f.logFile));
  await assert.rejects(recoverLibraryCreator(f.store, f.pr, f.client, f.config), /ambiguous original/);
  assert.equal(readJson(path.join(f.store.records, "native-creators", `${f.taskId}.json`)), null);
});
