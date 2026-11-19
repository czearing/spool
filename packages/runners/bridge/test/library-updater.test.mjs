import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { configure } from "../config.mjs";
import { repositoryCall } from "../repository-call.mjs";
import { createUpdater } from "../updater.mjs";
import { creatorWorkflowEvidence } from "../updater-dispatch.mjs";
import { setupDependency, setupDependencyAvailable } from "../setup-dependency.mjs";
import { writeJson } from "../spool-store.mjs";
import { fixture } from "./fixtures.mjs";
import { finishTask } from "./continuation-fixtures.mjs";
import { withSpoolReviewTools, readReviewProcedure } from "../../scanners/lib/creator-review.mjs";

function libraryFixture(t) {
  const f = fixture(t);
  const configFile = path.join(f.root, "spool-runners.json"), mcpFile = path.join(f.root, "repository-mcp.json");
  fs.writeFileSync(mcpFile, "{}");
  const input = {
    spool_dir: f.root, repository_profile: "1js", repository_mcp_config: mcpFile,
    repository_config_file: configFile, agent_workspaces: { perf: f.workspace },
    ado: { organization: "office", project: "Office", repository: "1JS",
      project_id: "a4aa557b-7dca-453d-9d83-2fe9271852b9" },
    pr_updater: { enabled: true },
  };
  writeJson(configFile, input);
  const config = configure(input, "pr-updater", f.root).config;
  config.creatorMinimumFreeGiB = 0.001;
  const pr = { id: "5880398", url: "https://dev.azure.com/office/Office/_git/1JS/pullrequest/5880398",
    status: "active", isDraft: false, title: "Library query", branch: "user/library",
    sourceCommit: "a".repeat(40), targetBranch: "main", mergeStatus: "succeeded", description: "",
    votes: [], reviewers: [] };
  const taskId = "library-original", sessionId = "00000000-0000-4000-8000-000000000123";
  f.put({ id: taskId, agent: "perf", session_id: sessionId, prompt: "Original measured work.", turns: 4 }, "completed");
  writeJson(path.join(f.store.records, "native-creators", `${taskId}.json`), {
    verified: true, prId: pr.id, prUrl: pr.url, branch: pr.branch, taskId, agent: "perf",
    sessionId, workspace: f.workspace, originKind: "spool",
  });
  return { ...f, input, config, pr, taskId, sessionId, configFile };
}

test("1JS PR fixes wait for account cooldown and resume the original creator after reset without prompt changes", async t => {
  const f = libraryFixture(t);
  f.pr.mergeStatus = "conflicts";
  let deferred = { reason: "Waiting for GitHub API reset", retryAt: "2026-11-02T20:00:00Z" };
  let preparations = 0;
  const scan = await createUpdater({
    store: f.store, config: f.config, agent: "pr-updater", workspace: f.root,
    runtime: f.config.runtimeDirectory, transportHold: () => deferred,
    ado: { listOwnPullRequests: async () => [f.pr], getPullRequest: async () => f.pr,
      listThreads: async () => [], listBuilds: async () => [] },
    callBohemia: async () => {
      preparations++;
      return { ready: true, repoRoot: f.workspace, branch: f.pr.branch, commit: f.pr.sourceCommit };
    },
  });
  assert.equal((await scan()).dispatched, 0);
  assert.equal(preparations, 0);
  deferred = null;
  assert.equal((await scan()).dispatched, 1);
  finishTask(f, f.taskId, "failed", { error: "GitHub API rate limit blocked startup" });
  deferred = { reason: "Waiting for GitHub API reset", retryAt: "2026-11-02T20:00:00Z" };
  assert.equal((await scan()).dispatched, 0);
  assert.equal(preparations, 1);
  deferred = null;
  assert.equal((await scan()).dispatched, 1);
  assert.equal(f.store.task(f.taskId).session_id, f.sessionId);
  assert.equal((await scan()).dispatched, 0);
});

test("Bohemia keeps its original preparation client and configuration", t => {
  const f = fixture(t), bohemia = () => {};
  const config = configure({ spool_dir: f.root, pr_updater: { enabled: true } }, "pr-updater", f.root).config;
  assert.equal(config.repositoryProfile, "bohemia");
  assert.equal(repositoryCall(config, { bohemia }), bohemia);
  assert.equal(config.appRel, "apps/new-office");
});

test("1JS updater requires explicit repository, project and MCP scopes without WSL", t => {
  const f = libraryFixture(t);
  assert.equal(f.config.repositoryProfile, "1js");
  assert.equal(f.config.project, "Office");
  assert.equal(f.config.repository, "1JS");
  assert.equal(f.config.appRel, undefined);
  assert.equal(f.config.appPort, undefined);
  assert.equal(f.config.adoWslDistribution, undefined);
  for (const mutate of [
    input => { delete input.ado.project_id; },
    input => { delete input.repository_mcp_config; },
    input => { delete input.ado.organization; },
  ]) {
    const invalid = structuredClone(f.input);
    mutate(invalid);
    assert.throws(() => configure(invalid, "pr-updater", f.root));
  }
});

test("1JS preparation forwards the identical lifecycle fields only through repository MCP", async t => {
  const f = libraryFixture(t), calls = [];
  const call = repositoryCall(f.config, { bohemia: () => assert.fail("must not prepare Bohemia"),
    repository: async (...args) => {
      calls.push(args);
      return { structuredContent: { ready: true, branch: "user/library", commit: "a".repeat(40) } };
    } });
  const input = { repoRoot: f.workspace, operation: "branch", mode: "resume", branch: "user/library",
    reset: false, mergeMaster: true, allowConflicts: true, runBuild: false, expectedHead: "a".repeat(40) };
  assert.equal((await call("bohemia_prepare", input)).ready, true);
  assert.equal(calls[0][0], "prepare");
  assert.equal(calls[0][1], "1js");
  assert.deepEqual(calls[0][2], input);
  assert.equal(calls[0][3].env.REPOSITORY_MCP_CONFIG, f.input.repository_mcp_config);
  await assert.rejects(call("bohemia_build", input), /only request repository preparation/);
  const invalid = repositoryCall(f.config, { repository: async () => ({ structuredContent: { ready: false } }) });
  await assert.rejects(invalid("bohemia_prepare", input), /did not verify/);
});

test("1JS feedback resumes the original creator with the verbatim project updater prompt", async t => {
  const f = libraryFixture(t);
  const roleBefore = fs.readFileSync(path.join(f.root, "agents", "perf.md"), "utf8");
  const calls = [];
  const scan = await createUpdater({
    store: f.store, config: f.config, agent: "pr-updater", workspace: f.root,
    runtime: f.config.runtimeDirectory,
    ado: {
      listOwnPullRequests: async () => [f.pr], getPullRequest: async () => f.pr,
      listThreads: async () => [{ id: 42, status: "active", comments: [{ id: 1, commentType: "text",
        publishedDate: "2026-10-20T00:00:00Z", author: { uniqueName: "reviewer@example.invalid" },
        content: "Please preserve the cursor." }] }],
      listBuilds: async () => [],
    },
    callBohemia: repositoryCall(f.config, { repository: async (_operation, repo, input) => {
      calls.push({ repo, input });
      return { structuredContent: { ready: true, repoRoot: f.workspace, branch: input.branch, commit: f.pr.sourceCommit } };
    } }),
  });
  assert.equal((await scan()).dispatched, 1);
  const task = f.store.task(f.taskId), metadata = f.store.metadata(f.taskId);
  assert.equal(task.session_id, f.sessionId);
  assert.equal(task.agent, "perf");
  assert.equal(task.prompt, "Original measured work.");
  assert.equal(calls[0].repo, "1js");
  assert.equal(calls[0].input.mode, "checkout");
  assert.equal(calls[0].input.reset, true);
  assert.equal(calls[0].input.expectedHead, f.pr.sourceCommit);
  const prompt = task.interaction.messages.at(-1).text;
  const procedure = await readReviewProcedure(f.root);
  assert.equal(prompt, `${procedure}\n\nContinue this existing PR on its original task/session.\nRead "${metadata.contract.contractFile}" for the PR, branch, checkout, creator instructions, feedback, and completion details.\nSwitch branches.`);
  assert.equal(fs.readFileSync(path.join(f.root, "agents", "perf.md"), "utf8"), roleBefore);
  assert.equal(metadata.contract.repositoryConfigFile, f.configFile);
  assert.equal(metadata.contract.resolverCommands, undefined);
  assert.equal(metadata.contract.reviewTool, undefined);
  assert.equal(metadata.contract.resolutionMode, "runner");
  assert.match(metadata.contract.completionInstructions, /spool_update_task_status/);
  assert.equal((await scan()).dispatched, 0, "same feedback cannot produce a duplicate handoff");
});

test("1JS expired policy retries run in the shared script, survive restart, and never dispatch an agent", async t => {
  const f = libraryFixture(t), requeues = [];
  let build = { id: 100, name: "Library CI", evaluationId: "library-policy", result: "queued", timedOut: true };
  const createScan = () => createUpdater({
    store: f.store, config: f.config, agent: "pr-updater", workspace: f.root, runtime: f.config.runtimeDirectory,
    ado: {
      listOwnPullRequests: async () => [f.pr], getPullRequest: async () => f.pr,
      listThreads: async () => [], listBuilds: async () => [build],
      requeuePolicy: async (config, evaluationId, options) => {
        assert.equal(config.projectId, f.input.ado.project_id);
        assert.equal(config.project, "Office");
        assert.equal(config.repository, "1JS");
        assert.equal(options.prId, f.pr.id);
        const state = JSON.parse(fs.readFileSync(f.config.stateFile, "utf8"));
        assert.equal(state.builds[f.pr.id].retried["library-policy"], build.id, "ledger precedes write");
        requeues.push(evaluationId);
      },
    },
    callBohemia: () => assert.fail("expiry cannot prepare or wake an agent"),
  });

  assert.equal((await (await createScan())()).dispatched, 0);
  assert.equal((await (await createScan())()).dispatched, 0);
  assert.equal(requeues.length, 1);
  build = { ...build, id: 101 };
  assert.equal((await (await createScan())()).dispatched, 0);
  assert.equal(requeues.length, 2, "a second actual expiry can be retried, not escalated");
  build = { ...build, id: 102, timedOut: false, result: "succeeded" };
  assert.equal((await (await createScan())()).dispatched, 0);
  assert.equal(requeues.length, 2);
  assert.equal(f.store.task(f.taskId).status, "completed");
});

test("1JS conflict restoration skips host Git and stale local holds and cleanly prepares its Codespace", async t => {
  const f = libraryFixture(t), calls = [];
  f.pr.mergeStatus = "conflicts";
  writeJson(path.join(f.store.records, `preparation-hold-${f.taskId}.json`), {
    evidence: "obsolete-local-checkout", reason: "Local branch mismatch",
  });
  const previous = path.join(f.root, "previous-control-workspace");
  fs.mkdirSync(previous);
  const task = f.store.task(f.taskId);
  writeJson(task.file, { ...task, workspace: previous });
  const binding = path.join(f.store.records, "native-creators", `${f.taskId}.json`);
  writeJson(binding, { ...JSON.parse(fs.readFileSync(binding)), workspace: previous });
  const scan = await createUpdater({
    store: f.store, config: f.config, agent: "pr-updater", workspace: f.root,
    runtime: f.config.runtimeDirectory,
    preparationEvidence: () => assert.fail("1JS cannot inspect host Git"),
    assertMigrationSafe: () => assert.fail("1JS control workspaces are not source checkouts"),
    ado: {
      listOwnPullRequests: async () => [f.pr], getPullRequest: async () => f.pr,
      listThreads: async () => [], listBuilds: async () => [],
    },
    callBohemia: repositoryCall(f.config, { repository: async (_operation, _repo, input) => {
      calls.push(input);
      return { structuredContent: { ready: true, repoRoot: f.workspace, branch: f.pr.branch,
        commit: f.pr.sourceCommit, merge: { conflicted: true, files: ["query.ts"] } } };
    } }),
  });
  assert.equal((await scan()).dispatched, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, "checkout");
  assert.ok(calls.every(input => input.reset === true && input.mergeMaster === true &&
    input.allowConflicts === true && input.runBuild === false));
  assert.equal(f.store.task(f.taskId).session_id, f.sessionId);
});

test("1JS never cleans or switches a Codespace while its agent is working", async t => {
  const f = libraryFixture(t);
  f.pr.mergeStatus = "conflicts";
  f.put({ id: "active-perf-work", agent: "perf", session_id: "active-session" }, "in_progress");
  const scan = await createUpdater({
    store: f.store, config: f.config, agent: "pr-updater", workspace: f.root,
    runtime: f.config.runtimeDirectory,
    ado: {
      listOwnPullRequests: async () => [f.pr], getPullRequest: async () => f.pr,
      listThreads: async () => [], listBuilds: async () => [],
    },
    callBohemia: () => assert.fail("Active agent checkout must not be reset"),
  });

  assert.equal((await scan()).dispatched, 0);
  assert.equal(f.store.task(f.taskId).status, "completed");
});

test("1JS native completion is not reopened just because shared workflow files change", async t => {
  const f = libraryFixture(t);
  let version = "original-infrastructure";
  f.pr.mergeStatus = "conflicts";
  const scan = await createUpdater({
    store: f.store, config: f.config, agent: "pr-updater", workspace: f.root,
    runtime: f.config.runtimeDirectory, workflowEvidence: () => version,
    ado: { listOwnPullRequests: async () => [f.pr], getPullRequest: async () => f.pr,
      listThreads: async () => [], listBuilds: async () => [] },
    callBohemia: repositoryCall(f.config, { repository: async () => ({ structuredContent: {
      ready: true, repoRoot: f.workspace, branch: f.pr.branch, commit: f.pr.sourceCommit,
    } }) }),
  });
  assert.equal((await scan()).dispatched, 1);
  const { contract } = f.store.metadata(f.taskId);
  f.pr.mergeStatus = "succeeded";
  writeJson(contract.resultFile, {
    submissionId: contract.submissionId, fingerprint: contract.fingerprint, head: f.pr.sourceCommit, findings: [],
    repair: { evidence: "Fixture conflict resolved", verification: {
      command: "fixture merge check", expected: "No conflicts", actual: "No conflicts",
    } },
  });
  finishTask(f, f.taskId);
  assert.equal((await scan()).dispatched, 0);
  version = "repaired-cross-codespace-artifacts";
  assert.equal((await scan()).dispatched, 0);
  assert.equal(f.store.task(f.taskId).session_id, f.sessionId);
});

test("1JS resumes a failed original conversation after repair without reopening fixed review threads", async t => {
  const f = libraryFixture(t);
  let version = "broken-transport";
  const thread = { id: 42, status: "active", comments: [{ id: 1, commentType: "text",
    publishedDate: "2026-10-20T00:00:00Z", author: { uniqueName: "reviewer@example.invalid" },
    content: "Could this preserve the cursor?" }] };
  const scan = await createUpdater({
    store: f.store, config: f.config, agent: "pr-updater", workspace: f.root,
    runtime: f.config.runtimeDirectory, workflowEvidence: () => version,
    ado: { listOwnPullRequests: async () => [f.pr], getPullRequest: async () => f.pr,
      listThreads: async () => [thread], listBuilds: async () => [] },
    callBohemia: repositoryCall(f.config, { repository: async () => ({ structuredContent: {
      ready: true, repoRoot: f.workspace, branch: f.pr.branch, commit: f.pr.sourceCommit,
    } }) }),
  });
  assert.equal((await scan()).dispatched, 1);
  finishTask(f, f.taskId, "failed");
  thread.status = "fixed";
  assert.equal((await scan()).dispatched, 0);
  const previous = f.store.metadata(f.taskId);
  const file = path.join(f.store.records, `verification-${f.taskId}.json`);
  const verification = JSON.parse(fs.readFileSync(file));
  writeJson(file, { ...verification, result: { submissionId: previous.key,
    fingerprint: previous.contract.fingerprint, head: f.pr.sourceCommit,
    findings: [{ threadId: "42", disposition: "blocked" }] } });
  assert.equal((await scan()).dispatched, 0, "unchanged infrastructure must not loop the failed response");
  version = "repaired-transport";
  assert.equal((await scan()).dispatched, 1);
  assert.equal(f.store.task(f.taskId).session_id, f.sessionId);
  assert.deepEqual(f.store.metadata(f.taskId).contract.findings, []);
  assert.equal(thread.status, "fixed", "recovery must not mutate the review thread");
});

test("stock dependency availability stays within the approved feed and respects caret release bounds", async () => {
  const dependency = setupDependency('Setup failed: Couldn\'t find any versions for "@1js/scc-lazy-component" that matches "^1.3.663"');
  assert.deepEqual(dependency, { name: "@1js/scc-lazy-component", range: "^1.3.663" });
  assert.equal(setupDependency('Cannot find module "unrelated"'), null);
  const probe = (range, versions) => setupDependencyAvailable({ ...dependency, range }, {
    token: () => "fixture-token",
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).origin, "https://pkgs.dev.azure.com");
      assert.equal(options.redirect, "error");
      return Response.json({ name: dependency.name, versions: Object.fromEntries(versions.map(v => [v, {}])) });
    },
  });
  assert.equal(await probe("^1.3.663", ["1.3.662", "1.3.663-beta.1", "2.0.0"]), false);
  assert.equal(await probe("^1.3.663", ["1.3.664"]), true);
  assert.equal(await probe("^0.2.3", ["0.3.0"]), false);
  assert.equal(await probe("^0.2.3", ["0.2.4"]), true);
  assert.equal(await probe("^0.0.3", ["0.0.4"]), false);
  assert.equal(await probe("^0.0.3", ["0.0.3"]), true);
  assert.equal(await setupDependencyAvailable(dependency, {
    token: () => "fixture-token", fetchImpl: async () => new Response(null, { status: 401 }),
  }), null);
  await assert.rejects(setupDependencyAvailable({ name: "https://unapproved.invalid", range: "^1.0.0" },
    { fetchImpl: () => assert.fail("Unapproved package must not trigger authentication or fetch") }), /Unsupported/);
});

test("1JS waits cheaply for a missing setup release and retries the original task once availability changes", async t => {
  const f = libraryFixture(t), reason =
    'Couldn\'t find any versions for "@1js/scc-lazy-component" that matches "^1.3.663"';
  f.pr.mergeStatus = "conflicts";
  let version = "initial", available = false, preparations = 0;
  const scan = await createUpdater({
    store: f.store, config: f.config, agent: "pr-updater", workspace: f.root,
    runtime: f.config.runtimeDirectory,
    workflowEvidence: (store, owner) => `${version}:${creatorWorkflowEvidence(store, owner)}`,
    dependencyAvailability: async dependency => {
      assert.equal(dependency.name, "@1js/scc-lazy-component");
      return available;
    },
    ado: { listOwnPullRequests: async () => [f.pr], getPullRequest: async () => f.pr,
      listThreads: async () => [], listBuilds: async () => [] },
    callBohemia: repositoryCall(f.config, { repository: async () => {
      preparations++;
      return { structuredContent: { ready: true, repoRoot: f.workspace,
        branch: f.pr.branch, commit: f.pr.sourceCommit } };
    } }),
  });
  const block = async () => {
    finishTask(f, f.taskId, "failed");
    await scan();
    const file = path.join(f.store.records, `verification-${f.taskId}.json`);
    writeJson(file, { ...JSON.parse(fs.readFileSync(file)), reason });
  };
  assert.equal((await scan()).dispatched, 1);
  await block();
  version = "repaired-infrastructure";
  const held = await scan();
  assert.equal(held.dispatched, 0);
  assert.match(held.holding, /awaiting publication/);
  assert.equal(preparations, 1, "An outage must not cause another expensive checkout/setup");
  available = true;
  assert.equal((await scan()).dispatched, 1);
  assert.equal(f.store.task(f.taskId).session_id, f.sessionId);
  await block();
  assert.equal((await scan()).dispatched, 0, "Unchanged availability must not create an endless retry loop");
  assert.equal(preparations, 2);
});

test("legacy direct-resolver contracts cannot generate new updater instructions", () => {
  const base = { prId: "5880398", submissionId: "job", responseMode: "pr_thread",
    resultFile: "result.json", contractFile: "contract.json", creatorRoleFile: "perf.md" };
  assert.throws(() => withSpoolReviewTools(base), /runner-owned resolution/);
  assert.throws(() => withSpoolReviewTools({ ...base, repositoryConfigFile: "C:\\project\\config.json" }),
    /runner-owned resolution/);
});
