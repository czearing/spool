import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { recoverSpoolCreator, resolveSpoolCreator } from "../creator-routing.mjs";
import { digest, readJson, samePath, writeJson } from "../spool-store.mjs";
import { finishTask } from "./continuation-fixtures.mjs";
import { handoff } from "./updater-fixture.mjs";
import { publicationFile } from "../../packages/bohemia-agent-tooling/src/publications.js";

async function implicitCreator(t, trigger = "review") {
  const f = await handoff(t, "ci", { dispatch: false, trigger,
    assertMigrationSafe: workspace => {
      assert.notEqual(workspace, f.root, "An implicit execution root is not an abandoned PR checkout");
    } });
  writeFileSync(path.join(f.root, "agents", "ci.md"), "Maintain the original CI PR; never add AI attribution.");
  const task = f.store.task(f.taskId);
  const sessionConfig = { model: "original-model", reasoning_effort: "medium",
    workspace: f.root, agent: "ci", mcp: { original: "tools" } };
  writeJson(task.file, { ...task, workspace: null, session_config: sessionConfig });
  const registry = path.join(f.store.records, "ownership.json");
  const owner = { ...readJson(registry).pullRequests[0], originKind: "spool" };
  writeJson(registry, { version: 1, pullRequests: [] });
  const binding = path.join(f.store.records, "native-creators", `${f.taskId}.json`);
  writeJson(binding, owner);
  const contextFile = path.join(f.store.records, "creator-contexts", `${f.taskId}.json`);
  const context = { version: 1, originKind: "spool", taskId: f.taskId,
    agent: "ci", sessionId: f.session, workspace: null, branch: null };
  writeJson(contextFile, context);
  return { ...f, owner, binding, context, contextFile, sessionConfig };
}

async function projectRootMcpCreator(t) {
  const f = await implicitCreator(t);
  const task = f.store.task(f.taskId);
  writeJson(task.file, { ...task, workspace: f.root });
  const owner = { ...f.owner, version: 1, originKind: "mcp",
    projectRoot: f.root, taskWorkspace: f.root };
  const binding = publicationFile(f.pr.url, f.store.publicationDirectory);
  writeJson(binding, owner);
  return { ...f, owner, binding };
}

async function sessionWorkspaceMcpCreator(t) {
  const f = await projectRootMcpCreator(t);
  const previous = path.join(f.root, "original-session-workspace");
  mkdirSync(previous);
  const task = f.store.task(f.taskId);
  writeJson(task.file, { ...task, workspace: previous,
    session_config: { ...task.session_config, workspace: previous } });
  const owner = { ...f.owner, taskWorkspace: previous };
  writeJson(f.binding, owner);
  return { ...f, previous, owner };
}

test("checked MCP routing preserves a captured explicit session workspace without interrupting its author", async t => {
  const f = await sessionWorkspaceMcpCreator(t);
  const owner = resolveSpoolCreator(f.store, f.pr);
  assert.equal(owner.workspace, f.workspace);
  assert.equal(owner.workspaceMigration.previousWorkspace, f.previous);
  finishTask(f, f.taskId, "in_progress");
  assert.equal((await f.scan()).dispatched, 0);
  assert.equal(f.preparations(), 0);
  assert.equal(f.store.task(f.taskId).workspace, f.previous);
  finishTask(f, f.taskId);
  assert.equal((await f.scan()).dispatched, 1);
  const task = f.store.task(f.taskId);
  assert.equal(task.workspace, f.workspace);
  assert.equal(task.session_id, f.session);
  assert.equal(task.prompt, f.brief);
  assert.equal(task.session_config.model, f.sessionConfig.model);
  assert.equal(f.store.metadata(f.taskId).workspaceMigration.previousWorkspace, f.previous);
  assert.equal(resolveSpoolCreator(f.store, f.pr).workspace, f.workspace);
});

test("explicit MCP session workspace routing rejects mismatched captured provenance before preparation", async t => {
  const f = await sessionWorkspaceMcpCreator(t);
  for (const changes of [
    { taskWorkspace: null }, { taskWorkspace: f.workspace },
    { projectRoot: f.workspace }, { sessionId: "another-session" },
    { originKind: "spool" }, { verified: false },
  ]) {
    writeJson(f.binding, { ...f.owner, ...changes });
    assert.equal((await f.scan()).dispatched, 0);
  }
  writeJson(f.binding, f.owner);
  const task = f.store.task(f.taskId);
  for (const changes of [
    { workspace: f.root },
    { session_config: { ...task.session_config, workspace: f.root } },
    { session_config: { ...task.session_config, agent: "perf" } },
  ]) {
    writeJson(task.file, { ...task, ...changes });
    assert.equal((await f.scan()).dispatched, 0);
  }
  assert.equal(f.preparations(), 0);
});

test("checked MCP publication resumes a project-root task in its actual repository workspace", async t => {
  const f = await projectRootMcpCreator(t);
  const owner = resolveSpoolCreator(f.store, f.pr);
  assert.equal(owner.workspace, f.workspace);
  assert.equal(owner.taskId, f.taskId);
  assert.equal(owner.sessionId, f.session);
  assert.equal(f.store.task(f.taskId).workspace, f.root);
  assert.equal((await f.scan()).dispatched, 1);
  assert.equal(f.store.task(f.taskId).workspace, f.workspace);
  assert.equal(f.store.task(f.taskId).session_id, f.session);
  assert.equal(f.store.metadata(f.taskId).workspaceMigration.previousWorkspace, f.root);
  assert.equal(resolveSpoolCreator(f.store, f.pr).workspace, f.workspace);
});

test("project-root MCP routing requires matching task, execution, and publication provenance", async t => {
  const f = await projectRootMcpCreator(t);
  for (const changes of [
    { taskWorkspace: null }, { taskWorkspace: f.workspace },
    { projectRoot: f.workspace }, { sessionId: "another-session" }, { originKind: "spool" },
  ]) {
    writeJson(f.binding, { ...f.owner, ...changes });
    assert.equal((await f.scan()).dispatched, 0);
  }
  writeJson(f.binding, f.owner);
  const task = f.store.task(f.taskId);
  const unrelated = path.join(f.root, "unrelated");
  mkdirSync(unrelated);
  for (const changes of [
    { workspace: unrelated },
    { session_config: { ...task.session_config, workspace: f.workspace } },
    { session_config: { ...task.session_config, agent: "perf" } },
  ]) {
    writeJson(task.file, { ...task, ...changes });
    assert.equal((await f.scan()).dispatched, 0);
  }
  assert.equal(f.preparations(), 0);
});

for (const trigger of ["review", "build"]) {
  test(`${trigger} resumes a verified implicit-workspace CI creator through native preparation`, async t => {
    const f = await implicitCreator(t, trigger);
    assert.equal(resolveSpoolCreator(f.store, f.pr).workspace, f.workspace);
    assert.equal((await f.scan()).dispatched, 1);
    const task = f.store.task(f.taskId), metadata = f.store.metadata(f.taskId);
    assert.equal(task.id, f.taskId);
    assert.equal(task.session_id, f.session);
    assert.equal(task.prompt, f.brief);
    assert.equal(task.workspace, f.workspace);
    assert.equal(task.session_config.model, f.sessionConfig.model);
    assert.equal(task.session_config.reasoning_effort, f.sessionConfig.reasoning_effort);
    assert.deepEqual(task.session_config.mcp, f.sessionConfig.mcp);
    assert.ok(samePath(task.session_config.workspace, f.workspace));
    assert.equal(metadata.workspaceMigration.previousWorkspace, f.root);
    assert.equal(metadata.contract.cwd, f.workspace);
    assert.equal(metadata.contract.findings.length, 1);
    assert.equal(metadata.contract.creatorRoleFile, path.join(f.root, "agents", "ci.md"));
    assert.ok(task.interaction.messages.at(-1).text.includes(metadata.contract.contractFile));
    assert.equal(metadata.updatePrompt.roleSha256, digest("Maintain the original CI PR; never add AI attribution."));
    assert.equal((await f.scan()).dispatched, 0);
    finishTask(f, f.taskId);
    f.pr.sourceCommit = "c".repeat(40);
    if (trigger === "review") f.pr.mergeStatus = "conflicts";
    assert.equal((await f.scan()).dispatched, 1);
    assert.equal(resolveSpoolCreator(f.store, f.pr).workspace, f.workspace);
    assert.equal(f.store.task(f.taskId).session_id, f.session);
  });
}

test("implicit native creator routing rejects absent or inconsistent provenance without preparation", async t => {
  const f = await implicitCreator(t);
  const mutations = [
    { version: 2 }, { originKind: "copilot_cli" }, { taskId: "another-task" },
    { agent: "perf" }, { sessionId: "another-session" }, { workspace: f.workspace }, { branch: "another-branch" },
  ];
  for (const changes of mutations) {
    writeJson(f.contextFile, { ...f.context, ...changes });
    assert.throws(() => resolveSpoolCreator(f.store, f.pr), /ownership\/workspace is inconsistent/);
    assert.equal((await f.scan()).dispatched, 0);
  }
  writeJson(f.contextFile, null);
  assert.equal((await f.scan()).dispatched, 0);
  writeJson(f.contextFile, f.context);
  const task = f.store.task(f.taskId);
  for (const changes of [
    { workspace: f.root },
    { session_config: { ...f.sessionConfig, workspace: f.workspace } },
    { session_config: { ...f.sessionConfig, agent: "perf" } },
    { session_id: "another-session" },
  ]) {
    writeJson(task.file, { ...task, ...changes });
    assert.equal((await f.scan()).dispatched, 0);
  }
  writeJson(task.file, task);
  writeJson(f.binding, { ...f.owner, originKind: "copilot_cli" });
  assert.equal((await f.scan()).dispatched, 0);
  assert.equal(f.preparations(), 0);
  assert.deepEqual(readJson(task.file), task);
});

test("implicit creator migration to a reassigned checkout retains the actual original session root", async t => {
  const f = await implicitCreator(t);
  const assigned = path.join(f.root, "assigned");
  mkdirSync(assigned);
  f.config.agentWorkspaces.ci = assigned;
  assert.equal((await f.scan()).dispatched, 1);
  assert.equal(f.store.metadata(f.taskId).workspaceMigration.previousWorkspace, f.root);
  assert.equal(f.store.task(f.taskId).workspace, assigned);
  assert.equal(resolveSpoolCreator(f.store, f.pr).workspace, assigned);
});

test("lost native publication receipt recovers an implicit creator only with matching execution evidence", async t => {
  const f = await implicitCreator(t);
  const originId = "00000000-0000-4000-8000-000000000456";
  f.pr.targetBranch = "master";
  f.pr.description = `<!-- bohemia-origin:${originId} -->\nOriginal description`;
  writeJson(path.join(f.store.records, "native-creators", ".pending", `${f.taskId}.json`), {
    version: 1, attempted: true, originId, scope: f.pr.url.replace(/\d+$/, ""),
    repository: "fixture", branch: f.pr.branch, targetBranch: "master", owner: f.owner,
    publication: { head: f.pr.sourceCommit, targetCommit: "b".repeat(40), baseCommit: "c".repeat(40) },
    createdAt: "2026-10-13T00:00:00Z",
  });
  unlinkSync(f.binding);
  const client = { getPullRequest: async () => f.pr, listOwnPullRequests: async () => [f.pr] };
  writeJson(f.contextFile, { ...f.context, sessionId: "wrong-session" });
  await assert.rejects(recoverSpoolCreator(f.store, f.pr, client, f.config), /original work item\/session/);
  writeJson(f.contextFile, f.context);
  await recoverSpoolCreator(f.store, f.pr, client, f.config);
  assert.equal(resolveSpoolCreator(f.store, f.pr).taskId, f.taskId);
  assert.equal((await f.scan()).dispatched, 1);
});
