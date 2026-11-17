import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { creationContext, createWithOrigin as createOperation, preservePrOrigin } from "../../packages/bohemia-pr-mcp/src/pr-origin.mjs";
import { publicationFile, readPublications } from "../../packages/bohemia-agent-tooling/src/publications.js";
import { recoverSpoolCreator, resolveSpoolCreator } from "../creator-routing.mjs";
import { configure } from "../config.mjs";
import { createUpdater } from "../updater.mjs";
import { readJson, writeJson } from "../spool-store.mjs";
import { fixture } from "./fixtures.mjs";
import { listOwnPullRequests } from "../../scanners/pr-updater/lib/azure-devops.mjs";

const createWithOrigin = options => createOperation({ ...options,
  publication: { head: "a".repeat(40), targetCommit: "b".repeat(40), baseCommit: "b".repeat(40) } });

function publication(t) {
  const f = fixture(t);
  const put = (task, state) => {
    for (const previous of ["incoming", "in_progress", "completed", "failed"])
      if (previous !== state) rmSync(path.join(f.root, "queues", previous, `${task.id}.json`), { force: true });
    f.put(task, state);
  };
  const context = { version: 1, originKind: "spool", taskId: "TASK-origin", agent: "perf",
    sessionId: randomUUID(), workspace: f.workspace, branch: "user/origin",
    projectRoot: f.root, receiptDirectory: path.join(f.root, "publications"), originalPrompt: "Original creation task" };
  f.store.publicationDirectory = context.receiptDirectory;
  put({ id: context.taskId, agent: context.agent, session_id: context.sessionId, prompt: context.originalPrompt }, "in_progress");
  const contextFile = path.join(f.root, "controls", "executions", `${context.taskId}.json`);
  writeJson(contextFile, context);
  const environment = { SPOOL_EXECUTION_CONTEXT: contextFile, COPILOT_SESSION_ID: context.sessionId,
    REPOSITORY_MCP_PUBLICATIONS: context.receiptDirectory };
  const input = { repository: "fixture", sourceBranch: context.branch, targetBranch: "master",
    title: "Fixture", description: "# Description\nFixture description." };
  const prs = [];
  let posts = 0;
  const api = {
    url: (repo, id) => `https://example.invalid/OC/_git/${repo}/pullrequest/${id}`,
    async list(repo, branch) { return prs.filter(pr => (!pr.repository || pr.repository === repo) &&
      (!pr.sourceRefName || pr.sourceRefName === `refs/heads/${branch}`)); },
    async get(repo, id) { return structuredClone(prs.find(pr => pr.pullRequestId === id && pr.repository === repo)); },
    async create(request) {
      posts++;
      const pr = { pullRequestId: 122 + posts, repository: request.repository, description: request.description,
        status: "active", lastMergeSourceCommit: { commitId: "a".repeat(40) },
        sourceRefName: `refs/heads/${request.sourceBranch}`, targetRefName: `refs/heads/${request.targetBranch}` };
      prs.push(pr);
      return structuredClone(pr);
    },
  };
  const options = { context: creationContext(environment), input, repoRoot: f.workspace, api };
  const recordFile = publicationFile(api.url("fixture", 123), context.receiptDirectory);
  const key = createHash("sha256").update(api.url("fixture", 0).replace(/0$/, "").toLowerCase() + "\n" + context.branch).digest("hex");
  const intentFile = path.join(context.receiptDirectory, "creations", ".pending", `${key}.json`);
  return { ...f, put, context, contextFile, environment, input, prs, api, options, recordFile, intentFile, posts: () => posts };
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
  f.put({ id: f.context.taskId, agent: f.context.agent, session_id: f.context.sessionId,
    provider: { token: providerToken } }, "in_progress");
  const env = { ...f.environment, COPILOT_SESSION_ID: "", SPOOL_PROVIDER_TOKEN: providerToken };
  assert.equal(creationContext(env).sessionId, f.context.sessionId);
  assert.throws(() => creationContext({ ...env, SPOOL_PROVIDER_TOKEN: `spool-provider-${randomUUID()}` }), /context/);
  assert.throws(() => creationContext({ SPOOL_EXECUTION_CONTEXT: f.contextFile }), /context/);
  assert.throws(() => creationContext({ ...env, COPILOT_SESSION_ID: randomUUID() }), /context/);
  assert.equal(creationContext({ ...env, COPILOT_SESSION_ID: f.context.sessionId }).sessionId, f.context.sessionId);
  writeJson(f.contextFile, { ...f.context, providerToken: "arbitrary" });
  assert.throws(() => creationContext({ ...env, SPOOL_PROVIDER_TOKEN: "arbitrary" }), /context/);
});

test("duplicate and concurrent creates recover one PR and never replace its original session", async t => {
  const f = publication(t);
  await Promise.all([createWithOrigin(f.options), createWithOrigin(f.options)]);
  const original = readFileSync(f.recordFile, "utf8");
  await createWithOrigin(f.options);
  assert.equal(f.posts(), 1);
  assert.equal(readFileSync(f.recordFile, "utf8"), original);
});

test("a rejected CI creation acknowledgement cannot register ownership or repeat the remote POST", async t => {
  const f = publication(t);
  const options = { ...f.options, context: { ...f.options.context, agent: "ci" },
    input: { ...f.input, draft: true } };
  await assert.rejects(createWithOrigin(options), /CI experiments must remain drafts/);
  assert.equal(f.posts(), 1);
  assert.deepEqual(readPublications(f.store.publicationDirectory), []);
  assert.equal(readJson(f.intentFile).prId, "123");
  f.prs[0].isDraft = true;
  await createWithOrigin(options);
  assert.equal(f.posts(), 1);
  assert.equal(readPublications(f.store.publicationDirectory).length, 1);
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
  const intentFile = f.intentFile;
  const rejected = readJson(intentFile);
  assert.equal(rejected.attempted, false);
  assert.equal(rejected.rejection.status, 400);
  f.api.create = create;
  await createWithOrigin(f.options);
  assert.equal(f.posts(), 1);
  assert.equal(readJson(f.intentFile).originId, rejected.originId);
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
  await assert.rejects(createWithOrigin(f.options), /use action=update/);
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
  for (const change of [{ agent: "pr-updater" }, { agent: "pr-reviewer" },
    { sessionId: "unknown" }, { taskId: "../escape" }, { workspace: "relative" }]) {
    writeJson(f.contextFile, { ...f.context, ...change });
    assert.throws(() => creationContext(f.environment), /context/);
  }
  rmSync(f.contextFile);
  assert.throws(() => creationContext(f.environment), /context/);
  assert.equal(f.posts(), 0);
  assert.equal(creationContext({}), null);
});

test("one conversation can publish another branch and repository while checkout checks remain enforced", async t => {
  const f = publication(t);
  await createWithOrigin(f.options);
  const original = readFileSync(f.recordFile, "utf8");
  const otherWorkspace = path.join(f.root, "other");
  mkdirSync(otherWorkspace);
  await assert.rejects(createWithOrigin({ ...f.options, repoRoot: otherWorkspace }));
  for (const change of [
    { input: { ...f.input, sourceBranch: "user/another" } },
    { input: { ...f.input, repository: "another" } },
  ]) await createWithOrigin({ ...f.options, ...change });
  assert.equal(readFileSync(f.recordFile, "utf8"), original);
  assert.equal(f.posts(), 3);
  assert.equal(readPublications(f.context.receiptDirectory).length, 3);
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

test("verified VM history import retains original PR ownership without accepting an unrelated session", async t => {
  const f = publication(t);
  await createWithOrigin(f.options);
  const sessionId = randomUUID();
  const profile = path.join(f.root, "vm.json");
  const provider = { command: "node", args: ["copilot.mjs", "--config", profile] };
  writeJson(profile, { codespace: "engineer-vm", remoteRoot: "/workspaces/1JS", sshHost: "engineer-vm" });
  writeJson(path.join(f.root, "spool.json"), { copilotProviders: { perf: provider } });
  f.put({ id: f.context.taskId, agent: "perf", session_id: sessionId,
    session_config: { agent: "perf", provider } }, "completed");
  const pr = { id: "123", url: f.api.url("fixture", 123), branch: f.context.branch };
  const directory = path.join(f.store.records, "copilot-usage", sessionId);
  writeJson(path.join(directory, "provider.json"),
    { codespace: "engineer-vm", root: "/workspaces/1JS", sshHost: "engineer-vm" });
  const receipt = { ok: true, dryRun: false, textVerified: true, externalId: f.context.sessionId,
    sessionId, transcriptSha256: "a".repeat(64), imported: { messages: 3 }, diagnostics: [] };
  const file = path.join(directory, "conversation-import.json");
  for (const change of [{ textVerified: false }, { externalId: randomUUID() },
    { sessionId: randomUUID() }, { diagnostics: ["incomplete"] }]) {
    writeJson(file, { ...receipt, ...change });
    assert.throws(() => resolveSpoolCreator(f.store, pr), /originating Copilot session/);
  }
  writeJson(file, receipt);
  const owner = resolveSpoolCreator(f.store, pr);
  assert.equal(owner.taskId, f.context.taskId);
  assert.equal(owner.sessionId, sessionId);
  assert.equal(owner.continuity.originalSessionId, f.context.sessionId);
  assert.equal(readJson(f.recordFile).sessionId, f.context.sessionId, "Creation provenance remains immutable");
});

test("a corrupted or unverified publication cannot be silently replaced", async t => {
  const f = publication(t);
  await createWithOrigin(f.options);
  const record = readJson(f.recordFile);
  for (const change of [{ verified: false }, { prUrl: "https://example.invalid/wrong" }]) {
    writeJson(f.recordFile, { ...record, ...change });
    await assert.rejects(createWithOrigin(f.options), /Verified publication changed/);
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

test("actual CI publisher forces draft creation, rejects public acknowledgements and preserves accepted review", t => {
  for (const explicitDraft of ["omitted", "false"]) {
  const f = publication(t);
  writeJson(f.contextFile, { ...f.context, agent: "ci" });
  f.put({ id: f.context.taskId, agent: "ci", session_id: f.context.sessionId }, "in_progress");
  const script = fileURLToPath(new URL("./fixtures/pr-publication.ts", import.meta.url));
  const result = spawnSync("bun", [script], { cwd: f.workspace, encoding: "utf8", windowsHide: true,
    timeout: 60_000, env: { ...process.env, ...f.environment, USERPROFILE: f.root, HOME: f.root,
      CI_EXPLICIT_DRAFT: explicitDraft } });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
  assert.equal(readJson(f.recordFile).agent, "ci");
  }
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
    timeout: 60_000, env: { ...process.env, SPOOL_EXECUTION_CONTEXT: contextFile,
      REPOSITORY_MCP_PUBLICATIONS: f.context.receiptDirectory,
      COPILOT_SESSION_ID: "", SPOOL_PROVIDER_TOKEN: "", USERPROFILE: f.root, HOME: f.root } });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
  const receipt = readJson(f.recordFile);
  assert.equal(receipt.originKind, "mcp");
  assert.equal(receipt.sessionId, null);
  assert.equal(receipt.deferred, true);
  assert.equal(f.store.task(context.taskId).status, "completed");
  assert.equal(f.store.task(context.taskId).turns, 0);
});

test("an activated reserved creator keeps its verified original session after native deferred flags retire", async t => {
  const f = publication(t);
  await createWithOrigin(f.options);
  const record = readJson(f.recordFile);
  writeJson(f.recordFile, { ...record, deferred: true, sessionId: null });
  const providerToken = `spool-provider-${randomUUID()}`;
  f.put({ id: f.context.taskId, agent: f.context.agent, session_id: f.context.sessionId,
    turns: 2, provider: { token: providerToken } }, "completed");
  const contextFile = path.join(f.store.records, "creator-contexts", `${f.context.taskId}.json`);
  const context = { ...f.context, providerToken };
  writeJson(contextFile, context);
  const pr = { id: "123", url: f.api.url("fixture", 123), branch: f.context.branch };
  const owner = resolveSpoolCreator(f.store, pr);
  assert.equal(owner.sessionId, f.context.sessionId);
  assert.equal(owner.deferred, false);
  for (const mismatch of [{ providerToken: "spool-provider-wrong" }, { sessionId: randomUUID() },
    { agent: "spelling" }, { taskId: "another-task" }]) {
    writeJson(contextFile, { ...context, ...mismatch });
    assert.throws(() => resolveSpoolCreator(f.store, pr), /saved execution identity/);
  }
  writeJson(contextFile, context);
  f.put({ id: f.context.taskId, agent: f.context.agent, session_id: f.context.sessionId,
    turns: 2, provider: null }, "completed");
  assert.equal(resolveSpoolCreator(f.store, pr).sessionId, f.context.sessionId);
  writeJson(contextFile, { ...context, sessionId: randomUUID() });
  assert.throws(() => resolveSpoolCreator(f.store, pr), /saved execution identity/);
});

test("an unrelated invalid reserved publication cannot block a verified original creator", async t => {
  const f = publication(t);
  await createWithOrigin(f.options);
  const invalid = { ...readJson(f.recordFile), prId: "456", prUrl: f.api.url("fixture", 456),
    taskId: "invalid-reservation", branch: "user/invalid", sessionId: null, deferred: true };
  f.put({ id: invalid.taskId, agent: invalid.agent, session_id: randomUUID(),
    deferred_pr_owner: true }, "completed");
  writeJson(path.join(f.store.records, "ownership.json"), { version: 1, pullRequests: [invalid] });
  const owner = resolveSpoolCreator(f.store, { id: "123", url: f.api.url("fixture", 123), branch: f.context.branch });
  assert.equal(owner.taskId, f.context.taskId);
  assert.throws(() => resolveSpoolCreator(f.store, {
    id: invalid.prId, url: invalid.prUrl, branch: invalid.branch,
  }), /saved execution identity/);
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
  const record = readPublications(directory)[0];
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
