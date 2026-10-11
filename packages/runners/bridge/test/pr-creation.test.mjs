import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { creationContext, createWithOrigin, preservePrOrigin } from "../../packages/bohemia-pr-mcp/src/pr-origin.mjs";
import { recoverSpoolCreator, resolveSpoolCreator } from "../creator-routing.mjs";
import { configure } from "../config.mjs";
import { createUpdater } from "../updater.mjs";
import { readJson, writeJson } from "../spool-store.mjs";
import { fixture } from "./fixtures.mjs";
import { listOwnPullRequests } from "../../scanners/pr-updater/lib/azure-devops.mjs";

function publication(t) {
  const f = fixture(t);
  const context = { version: 1, originKind: "spool", taskId: "TASK-origin", agent: "perf",
    sessionId: randomUUID(), workspace: f.workspace, branch: "user/origin",
    receiptDirectory: path.join(f.store.records, "native-creators"), originalPrompt: "Original creation task" };
  const contextFile = path.join(f.root, "context.json");
  writeJson(contextFile, context);
  const environment = { BOHEMIA_CREATOR_CONTEXT: contextFile, COPILOT_SESSION_ID: context.sessionId };
  const input = { repository: "fixture", sourceBranch: context.branch, targetBranch: "master",
    title: "Fixture", description: "# Description\nFixture description." };
  const prs = [];
  let posts = 0;
  const api = {
    url: (repo, id) => `https://example.invalid/OC/_git/${repo}/pullrequest/${id}`,
    async list() { return prs; },
    async get(_repo, id) { return structuredClone(prs.find(pr => pr.pullRequestId === id)); },
    async create(request) {
      posts++;
      const pr = { pullRequestId: 123, description: request.description,
        sourceRefName: `refs/heads/${request.sourceBranch}`, targetRefName: `refs/heads/${request.targetBranch}` };
      prs.push(pr);
      return structuredClone(pr);
    },
  };
  const options = { context: creationContext(environment), input, repoRoot: f.workspace, api };
  const recordFile = path.join(context.receiptDirectory, `${context.taskId}.json`);
  return { ...f, context, contextFile, environment, input, prs, api, options, recordFile, posts: () => posts };
}

test("creation records the exact creator and session, then routes outside the creation rollout", async t => {
  const f = publication(t);
  f.put({ id: f.context.taskId, agent: "perf", session_id: f.context.sessionId }, "completed");
  writeJson(path.join(f.store.records, "ownership.json"), { version: 1, pullRequests: [], verificationPrIds: ["999"] });
  const pr = await createWithOrigin(f.options);
  const record = readJson(f.recordFile);
  assert.equal(record.prId, "123");
  assert.equal(record.agent, "perf");
  assert.equal(record.sessionId, f.context.sessionId);
  assert.equal(record.workspace, f.workspace);
  assert.equal(record.originalPrompt, "Original creation task");
  const owner = resolveSpoolCreator(f.store, { id: "123", url: f.api.url("fixture", 123), branch: f.context.branch });
  assert.equal(owner.task.id, f.context.taskId);
  assert.equal(owner.task.session_id, f.context.sessionId);
  assert.ok(pr.description.startsWith("<!-- bohemia-origin:"));
  assert.ok(!pr.description.includes(f.context.sessionId));
  assert.ok(!pr.description.includes(f.context.taskId));
});

test("fresh ACP creators bind their assigned session to the immutable provider launch without weakening resumed-session checks", t => {
  const f = publication(t);
  const providerToken = `spool-provider-${randomUUID()}`;
  writeJson(f.contextFile, { ...f.context, providerToken });
  const env = { BOHEMIA_CREATOR_CONTEXT: f.contextFile, SPOOL_PROVIDER_TOKEN: providerToken };
  assert.equal(creationContext(env).sessionId, f.context.sessionId);
  assert.throws(() => creationContext({ ...env, SPOOL_PROVIDER_TOKEN: `spool-provider-${randomUUID()}` }), /context/);
  assert.throws(() => creationContext({ BOHEMIA_CREATOR_CONTEXT: f.contextFile }), /context/);
  assert.throws(() => creationContext({ ...env, COPILOT_SESSION_ID: randomUUID() }), /context/);
  assert.equal(creationContext({ ...env, COPILOT_SESSION_ID: f.context.sessionId }).sessionId, f.context.sessionId);
  writeJson(f.contextFile, { ...f.context, providerToken: "arbitrary" });
  assert.throws(() => creationContext({ ...env, SPOOL_PROVIDER_TOKEN: "arbitrary" }), /context/);
});

test("duplicate and concurrent creates recover one PR and never replace its original session", async t => {
  const f = publication(t);
  await Promise.all([createWithOrigin(f.options), createWithOrigin(f.options)]);
  const original = readFileSync(f.recordFile, "utf8");
  await createWithOrigin({ ...f.options, context: { ...f.context, sessionId: randomUUID() } });
  assert.equal(f.posts(), 1);
  assert.equal(readFileSync(f.recordFile, "utf8"), original);
});

test("lost POST response recovers by the persisted intent, not by guessing branch ownership", async t => {
  const f = publication(t), create = f.api.create;
  f.api.create = async input => { await create(input); throw new Error("response lost"); };
  await assert.rejects(createWithOrigin(f.options), /response lost/);
  assert.equal(readJson(f.recordFile), null);
  f.api.create = async () => assert.fail("A lost response must not replay POST");
  assert.equal((await createWithOrigin(f.options)).pullRequestId, 123);
  assert.equal(readJson(f.recordFile).sessionId, f.context.sessionId);
  assert.equal(f.posts(), 1);
});

test("receipt write failure after remote creation is recoverable without another POST", async t => {
  const f = publication(t);
  await assert.rejects(createWithOrigin({ ...f.options, write(file, data) {
    if (file === f.recordFile) throw new Error("receipt storage failed");
    writeJson(file, data);
  } }), /receipt storage failed/);
  assert.equal(readJson(f.recordFile), null);
  await createWithOrigin(f.options);
  assert.equal(f.posts(), 1);
  assert.equal(readJson(f.recordFile).verified, true);
});

test("uncertain request with no visible PR never creates a duplicate on retry", async t => {
  const f = publication(t);
  let attempts = 0;
  f.api.create = async () => { attempts++; throw new Error("connection lost"); };
  await assert.rejects(createWithOrigin(f.options), /connection lost/);
  await assert.rejects(createWithOrigin(f.options), /outcome is uncertain/);
  assert.equal(attempts, 1);
});

test("definitively rejected creation retains its origin and permits a reconciled retry", async t => {
  const f = publication(t), create = f.api.create;
  f.api.create = async () => { throw Object.assign(new Error("Azure DevOps rejected missing branch"), {
    creationRejected: true, status: 400, typeKey: "GitPullRequestCannotBeActivated",
  }); };
  await assert.rejects(createWithOrigin(f.options), /rejected missing branch/);
  const intentFile = path.join(f.context.receiptDirectory, ".pending", `${f.context.taskId}.json`);
  const rejected = readJson(intentFile);
  assert.equal(rejected.attempted, false);
  assert.equal(rejected.rejection.status, 400);
  f.api.create = create;
  await createWithOrigin(f.options);
  assert.equal(f.posts(), 1);
  assert.equal(readJson(f.recordFile).originId, rejected.originId);
});

test("unrecognized HTTP failures never permit replay of an ambiguous create", async t => {
  for (const status of [400, 408, 429, 500, 503]) {
    const f = publication(t);
    f.api.create = async () => { throw Object.assign(new Error(`HTTP ${status}`), { status }); };
    await assert.rejects(createWithOrigin(f.options), /HTTP/);
    f.api.create = async () => assert.fail("Ambiguous outcome must not replay");
    await assert.rejects(createWithOrigin(f.options), /outcome is uncertain/);
  }
});

test("failed intent persistence prevents every remote write", async t => {
  const f = publication(t);
  await assert.rejects(createWithOrigin({ ...f.options, write() { throw new Error("disk unavailable"); } }), /disk unavailable/);
  assert.equal(f.posts(), 0);
});

test("a pre-existing PR on the same branch is not adopted as this task's creation", async t => {
  const f = publication(t);
  f.prs.push({ pullRequestId: 55, description: "Somebody else's existing PR" });
  await assert.rejects(createWithOrigin(f.options), /recover its original owner/);
  assert.equal(f.posts(), 0);
  assert.equal(readJson(f.recordFile), null);
});

test("wrong or ambiguous remote evidence cannot produce a verified owner", async t => {
  for (const scenario of ["branch", "marker", "duplicate"]) {
    const f = publication(t), get = f.api.get;
    if (scenario === "duplicate") {
      const create = f.api.create;
      f.api.create = async input => { await create(input); f.prs.push({ ...f.prs[0], pullRequestId: 124 }); throw new Error("lost"); };
      await assert.rejects(createWithOrigin(f.options), /lost/);
      await assert.rejects(createWithOrigin(f.options), /Multiple PRs/);
    } else {
      f.api.get = async (...args) => ({ ...await get(...args), ...(scenario === "branch"
        ? { sourceRefName: "refs/heads/wrong" } : { description: "no marker" }) });
      await assert.rejects(createWithOrigin(f.options), /does not match/);
    }
    assert.equal(readJson(f.recordFile), null);
  }
});

test("missing, malformed and wrong-session context fails before publication", t => {
  const f = publication(t);
  assert.throws(() => creationContext({ ...f.environment, COPILOT_SESSION_ID: randomUUID() }), /context/);
  for (const change of [{ agent: "pr-updater" }, { agent: "pr-reviewer" }, { branch: " " },
    { sessionId: "unknown" }, { taskId: "../escape" }, { workspace: "relative" }]) {
    writeJson(f.contextFile, { ...f.context, ...change });
    assert.throws(() => creationContext(f.environment), /context/);
  }
  rmSync(f.contextFile);
  assert.throws(() => creationContext(f.environment), /context/);
  assert.equal(f.posts(), 0);
  assert.equal(creationContext({}), null);
});

test("a different agent, checkout, branch or repository cannot replace the owner", async t => {
  const f = publication(t);
  await createWithOrigin(f.options);
  const original = readFileSync(f.recordFile, "utf8");
  const otherWorkspace = path.join(f.root, "other");
  mkdirSync(otherWorkspace);
  for (const change of [
    { context: { ...f.context, agent: "software-engineer" } },
    { repoRoot: otherWorkspace },
    { input: { ...f.input, sourceBranch: "user/another" } },
    { input: { ...f.input, repository: "another" } },
  ]) await assert.rejects(createWithOrigin({ ...f.options, ...change }));
  assert.equal(readFileSync(f.recordFile, "utf8"), original);
  assert.equal(f.posts(), 1);
});

test("same numeric PR ID in another repository does not make ownership ambiguous", async t => {
  const f = publication(t);
  await createWithOrigin(f.options);
  f.put({ id: f.context.taskId, agent: "perf", session_id: f.context.sessionId }, "completed");
  writeJson(path.join(f.store.records, "ownership.json"), { version: 1,
    pullRequests: [{ ...readJson(f.recordFile), prUrl: f.api.url("another", 123), agent: "software-engineer" }] });
  const pr = { id: "123", url: f.api.url("fixture", 123), branch: f.context.branch };
  assert.equal(resolveSpoolCreator(f.store, pr).agent, "perf");
  f.put({ id: f.context.taskId, agent: "perf", session_id: randomUUID() }, "completed");
  assert.throws(() => resolveSpoolCreator(f.store, pr), /originating Copilot session/);
});

test("description updates retain the original opaque creation reference", async t => {
  const f = publication(t);
  const created = await createWithOrigin(f.options);
  const updated = preservePrOrigin(created.description, "New description");
  assert.equal(updated.split("\n")[0], created.description.split("\n")[0]);
  assert.ok(updated.endsWith("New description"));
  assert.equal(preservePrOrigin("ordinary PR", "new"), "new");
  assert.equal(preservePrOrigin(undefined, "new"), "new");
});

test("a corrupted saved session or unverified receipt cannot be reported as successful ownership", async t => {
  const f = publication(t);
  await createWithOrigin(f.options);
  const record = readJson(f.recordFile);
  for (const change of [{ sessionId: randomUUID() }, { verified: false }, { prUrl: "https://example.invalid/wrong" }]) {
    writeJson(f.recordFile, { ...record, ...change });
    await assert.rejects(createWithOrigin(f.options), /matching creation intent/);
  }
  assert.equal(f.posts(), 1);
});

test("actual ADO transport only classifies definitive creation rejection and matches exact refs", () => {
  const script = fileURLToPath(new URL("./fixtures/ado-publication.ts", import.meta.url));
  const result = spawnSync("bun", [script], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
});

test("actual publisher create/update entry points retain gates and record ownership automatically", t => {
  const f = publication(t);
  const script = fileURLToPath(new URL("./fixtures/pr-publication.ts", import.meta.url));
  const result = spawnSync("bun", [script], { cwd: f.workspace, encoding: "utf8", windowsHide: true,
    timeout: 60_000, env: { ...process.env, ...f.environment, USERPROFILE: f.root, HOME: f.root } });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
  assert.equal(readJson(f.recordFile).sessionId, f.context.sessionId);
});

test("actual canonical publisher accepts native dormant ownership without a fabricated session", t => {
  const f = publication(t);
  const contextFile = path.join(f.store.records, "creator-contexts", `${f.context.taskId}.json`);
  mkdirSync(f.context.receiptDirectory, { recursive: true });
  const context = { ...f.context, version: 2, originKind: "spool_automation", sessionId: null,
    nativeRoot: f.root, deferred: true, commit: "a".repeat(40) };
  writeJson(contextFile, context);
  f.put({ id: context.taskId, agent: context.agent, session_id: null, deferred_pr_owner: true }, "completed");
  const script = fileURLToPath(new URL("./fixtures/pr-publication.ts", import.meta.url));
  const result = spawnSync("bun", [script], { cwd: f.workspace, encoding: "utf8", windowsHide: true,
    timeout: 60_000, env: { ...process.env, BOHEMIA_CREATOR_CONTEXT: contextFile,
      COPILOT_SESSION_ID: "", SPOOL_PROVIDER_TOKEN: "", USERPROFILE: f.root, HOME: f.root } });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
  const receipt = readJson(f.recordFile);
  assert.equal(receipt.originKind, "spool_automation");
  assert.equal(receipt.sessionId, null);
  assert.equal(receipt.deferred, true);
  assert.equal(f.store.task(context.taskId).status, "completed");
  assert.equal(f.store.task(context.taskId).turns, 0);
});

test("normal updater scan recovers interrupted registration and resumes the same creator without another POST", async t => {
  const f = publication(t), create = f.api.create;
  f.api.create = async input => { await create(input); throw new Error("creator exited after POST"); };
  await assert.rejects(createWithOrigin(f.options), /creator exited/);
  f.put({ id: f.context.taskId, agent: "perf", session_id: f.context.sessionId, turns: 7 }, "failed");
  const pr = { id: "123", url: f.api.url("fixture", 123), branch: f.context.branch, targetBranch: "master",
    description: f.prs[0].description, sourceCommit: "a".repeat(40), status: "active",
    title: "Fixture conflict", mergeStatus: "conflicts", votes: [], reviewers: [] };
  const ado = {
    async listOwnPullRequests(_config, options = {}) {
      if (options.sourceBranch) {
        assert.equal(options.status, "all");
        assert.equal(options.allPages, true);
        assert.equal(options.refresh, true);
      }
      return [pr];
    },
    async getPullRequest() { return pr; }, async listThreads() { return []; }, async listBuilds() { return []; },
  };
  const config = configure({ spool_dir: f.root, pr_updater: { enabled: true, workspace_dir: f.workspace } }, "pr-updater", f.root).config;
  config.creatorMinimumFreeGiB = 0.001;
  const scan = await createUpdater({ store: f.store, config, agent: "pr-updater",
    workspace: f.workspace, runtime: config.runtimeDirectory, ado,
    preparationEvidence: () => "fixture-evidence",
    callBohemia: async (_name, args) => ({ ready: true, repoRoot: args.repoRoot, branch: args.branch, commit: pr.sourceCommit }) });
  assert.equal((await scan()).dispatched, 1);
  const resumed = f.store.task(f.context.taskId);
  assert.equal(resumed.agent, "perf");
  assert.equal(resumed.session_id, f.context.sessionId);
  assert.equal(resumed.turns, 7);
  assert.equal(readJson(f.recordFile).sessionId, f.context.sessionId);
  assert.equal(f.posts(), 1);
});

test("pending creation recovery refuses changed task ownership or session", async t => {
  const f = publication(t), create = f.api.create;
  f.api.create = async input => { await create(input); throw new Error("lost"); };
  await assert.rejects(createWithOrigin(f.options), /lost/);
  f.put({ id: f.context.taskId, agent: "perf", session_id: randomUUID() }, "failed");
  const pr = { id: "123", url: f.api.url("fixture", 123), branch: f.context.branch, description: f.prs[0].description };
  await assert.rejects(recoverSpoolCreator(f.store, pr, {}, {}), /original work item\/session/);
  assert.equal(readJson(f.recordFile), null);
  assert.equal(f.posts(), 1);
});

test("ownership reconciliation pages through branch PR history and retains the target branch", async () => {
  const skips = [], rows = [1, 2, 3].map(pullRequestId => ({ pullRequestId,
    sourceRefName: "refs/heads/user/origin", targetRefName: "refs/heads/master", description: "fixture" }));
  const prs = await listOwnPullRequests({ organization: "https://example.invalid", project: "fixture", repository: "fixture" },
    { token: "fixture-only", top: 2, status: "all", sourceBranch: "user/origin", allPages: true, refresh: true,
      fetchImpl: async (url, request) => {
        assert.equal(request.method, "GET");
        const query = new URL(url).searchParams;
        assert.equal(query.get("searchCriteria.status"), "all");
        assert.equal(query.get("searchCriteria.sourceRefName"), "refs/heads/user/origin");
        const skip = Number(query.get("$skip"));
        skips.push(skip);
        return Response.json({ value: rows.slice(skip, skip + 2) });
      } });
  assert.deepEqual(skips, [0, 2]);
  assert.deepEqual(prs.map(pr => pr.id), ["1", "2", "3"]);
  assert.ok(prs.every(pr => pr.targetBranch === "master"));
});

test("standalone Copilot publication records its session without inventing a Spool owner", async t => {
  const f = publication(t);
  const context = creationContext({ COPILOT_SESSION_ID: f.context.sessionId });
  const directory = path.join(f.root, "standalone-origins");
  await createWithOrigin({ ...f.options, context: { ...context, receiptDirectory: directory } });
  const file = readdirSync(directory).find(name => name.endsWith(".json"));
  const record = readJson(path.join(directory, file));
  assert.equal(record.sessionId, f.context.sessionId);
  assert.equal(record.agent, null);
  assert.equal(record.taskId, null);
  assert.equal(record.workspace, f.workspace);
});

test("non-Copilot publication retains existing behavior without inventing ownership", async t => {
  const f = publication(t);
  const pr = await createWithOrigin({ ...f.options, context: creationContext({}) });
  assert.equal(pr.description, f.input.description);
  assert.equal(readJson(f.recordFile), null);
  assert.equal(f.posts(), 1);
});
