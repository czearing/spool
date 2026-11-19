import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withCodespaceWorkspaces, verifyEngineeringCodespace } from "../src/codespaces/engineering.mjs";
import { stageCreatorReview, syncCreatorReview } from "../src/codespaces/creator-review.mjs";
import { CodespaceTransport } from "../src/codespaces/transport.mjs";
import { repositoryProfile } from "../src/adapters/1js-profile.mjs";
import { execute } from "../src/process.mjs";
import { readPublications } from "../../bohemia-agent-tooling/src/publications.js";

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "codespace-publications-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const save = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value));
  };
  const workspace = path.join(root, "control"), file = path.join(root, "codespace.json");
  fs.mkdirSync(workspace);
  save(file, {});
  const config = { file, workspace, purpose: "engineering", codespace: "fixture-space",
    remoteRoot: "/workspaces/1JS", remoteTools: "/workspaces/.fixture-tools", minimumFreeGiB: 12,
    nativeProfile: { nodeExecutable: "/usr/bin/node" } };
  const descriptor = { version: 1, originKind: "spool", taskId: "original", agent: "software-engineer",
    sessionId: randomUUID(), providerToken: `spool-provider-${randomUUID()}`, workspace,
    branch: "user/previous", receiptDirectory: path.join(root, ".runner-receipts", "native-creators") };
  const contextFile = path.join(root, ".runner-receipts", "creator-contexts", "original.json");
  save(contextFile, descriptor);
  save(path.join(root, "queues", "in_progress", "original.json"), { id: descriptor.taskId, agent: descriptor.agent,
    workspace, session_id: descriptor.sessionId, provider: { token: descriptor.providerToken },
    session_config: { provider: {} }, status: "in_progress" });
  const previous = { verified: true, prId: "9", branch: "user/previous",
    taskId: descriptor.taskId, agent: descriptor.agent, sessionId: descriptor.sessionId, workspace };
  const previousFile = path.join(descriptor.receiptDirectory, "original.json");
  save(previousFile, previous);
  const directory = path.join(root, "publications");
  for (const [key, value] of Object.entries({ BOHEMIA_CREATOR_CONTEXT: contextFile,
    SPOOL_EXECUTION_CONTEXT: "", COPILOT_SESSION_ID: "", SPOOL_PROVIDER_TOKEN: descriptor.providerToken,
    REPOSITORY_MCP_PUBLICATIONS: directory })) {
    const before = process.env[key];
    process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
  const snapshot = { root: config.remoteRoot, commit: "a".repeat(40), branch: "user/current", worktreeStatus: "" };
  const snapshots = new Map([[snapshot.root, snapshot]]), calls = [];
  let published = 0, dirty = false;
  const transport = { initialize: async () => {}, dispose: async () => {}, deploy: async () => {},
    environment: async () => {},
    ssh: async command => {
      const current = [...snapshots.values()].find(value => command.includes(`root=${JSON.stringify(value.root)}`));
      return { stdout: command.includes("branch:git") ? JSON.stringify(current) : "" };
    },
    native: async (operation, input) => {
      calls.push({ operation, input });
      const current = snapshots.get(input.repoRoot);
      if (operation === "prepare")
        return { ready: true, repoRoot: current.root, ...current, branch: input.branch || current.branch, buildWarmed: true };
      if (dirty) throw new Error("Checkout has staged, unstaged or untracked changes");
      if (operation !== "pr") return { ready: true, repoRoot: current.root, ...current };
      return { ready: true, repoRoot: current.root, commit: current.commit, targetCommit: "b".repeat(40),
        pullRequestId: ++published + 41, url: `https://example.test/OC/_git/1js/pullrequest/${published + 41}` };
    } };
  const adapter = withCodespaceWorkspaces({ id: "1js", tools: async () => [] }, [file], {
    readConfig: () => config, transport: selected => {
      assert.equal(selected, config, "Checkout selection must not change the assigned VM or its lifecycle lease");
      return transport;
    },
    session: { codespace: config.codespace, root: config.remoteRoot, tools: config.remoteTools } });
  return { root, workspace, config, descriptor, previous, previousFile, directory, snapshot, snapshots, transport,
    adapter, calls, setDirty: value => { dirty = value; }, publications: () => published };
}

test("registered engineering workspaces accept Windows path casing changes", {
  skip: process.platform !== "win32",
}, async t => {
  const f = fixture(t);
  const adapter = withCodespaceWorkspaces({ id: "1js", tools: async () => [],
    call: async () => assert.fail("Registered workspace must not fall through to local execution") }, [f.config.file], {
    readConfig: () => f.config, transport: () => f.transport,
  });
  const result = await adapter.call("prepare", { repoRoot: f.workspace.toLowerCase(),
    operation: "branch", mode: "checkout", branch: f.snapshot.branch });
  assert.equal(result.structuredContent.ready, true);
  assert.equal(result.structuredContent.repoRoot, f.workspace);
});

test("creator review artifacts retain workspace identity across Windows casing changes", {
  skip: process.platform !== "win32",
}, async t => {
  const f = fixture(t);
  const contract = { cwd: f.workspace.toLowerCase(), submissionId: randomUUID(), fingerprint: "feedback",
    resultFile: path.join(f.workspace, "creator-result.json") };
  const result = { submissionId: contract.submissionId, fingerprint: contract.fingerprint };
  f.transport.ssh = async () => ({ stdout: JSON.stringify(result) });
  const staged = await stageCreatorReview({ repoRoot: f.workspace,
    execution: { codespace: f.config.codespace } }, contract, "Creator instructions.",
  { config: f.config, transport: f.transport });
  await syncCreatorReview(staged, { config: f.config, transport: f.transport });
  assert.deepEqual(JSON.parse(fs.readFileSync(contract.resultFile, "utf8")), result);
  await assert.rejects(stageCreatorReview({ repoRoot: f.workspace,
    execution: { codespace: f.config.codespace } }, { ...contract, cwd: f.root }, "Creator instructions.",
  { config: f.config, transport: f.transport }), /do not belong/);
});

test("the Codespace MCP records verified publications without a task-global PR reservation", async t => {
  const { adapter, snapshot, directory, descriptor, previousFile, previous, publications } = fixture(t);
  await adapter.call("prepare", { operation: "branch", mode: "create", branch: snapshot.branch });
  for (const pullRequestId of [42, 43])
    await adapter.call("pr", { action: "update", pullRequestId });
  const records = readPublications(directory);
  assert.equal(records.length, 2);
  assert.ok(records.every(record => record.sessionId === descriptor.sessionId && record.branch === snapshot.branch));
  assert.deepEqual(JSON.parse(fs.readFileSync(previousFile, "utf8")), previous);
  snapshot.branch = "user/foreign";
  await assert.rejects(adapter.call("pr", { action: "update", pullRequestId: 42 }), /prepared branch/);
  assert.equal(publications(), 2);
});

test("an agent can prepare and publish its repair checkout without replacing unrelated checkout evidence", async t => {
  const f = fixture(t);
  await f.adapter.call("prepare", { operation: "setup" });
  const mainReceipt = fs.readFileSync(path.join(f.workspace, "preparation.json"), "utf8");
  const root = "/workspaces/.spool-engineer-2-tools/jobs/library-cache-conflict";
  f.snapshots.set(root, { root, commit: "c".repeat(40), branch: "user/repair", worktreeStatus: "" });
  await assert.rejects(f.adapter.call("pr", { repoRoot: root, pullRequestId: 42 }), /ENOENT/);
  const prepared = (await f.adapter.call("prepare", { repoRoot: root, operation: "setup", runBuild: false })).structuredContent;
  assert.equal(prepared.execution.nativeRepoRoot, root);
  assert.notEqual(prepared.repoRoot, f.workspace);
  assert.ok(prepared.repoRoot.startsWith(path.join(f.workspace, "checkouts") + path.sep));
  await verifyEngineeringCodespace(prepared, { config: f.config, transport: f.transport });
  const host = withCodespaceWorkspaces({ id: "1js", tools: async () => [] }, [f.config.file], {
    readConfig: () => f.config, transport: () => f.transport });
  await host.call("check", { repoRoot: prepared.repoRoot });
  assert.equal(f.calls.at(-1).input.repoRoot, root);
  await f.adapter.call("pr", { repoRoot: root, pullRequestId: 42, sourceBranch: "user/repair" });
  assert.equal(f.calls.at(-1).input.repoRoot, root);
  assert.equal(f.calls.at(-1).input.sourceBranch, "user/repair");
  assert.equal(fs.readFileSync(path.join(f.workspace, "preparation.json"), "utf8"), mainReceipt);
  const [record] = readPublications(f.directory);
  assert.equal(record.branch, "user/repair");
  assert.equal(record.sessionId, f.descriptor.sessionId);
  assert.equal(record.publications.at(-1).head, "c".repeat(40));
  f.setDirty(true);
  await assert.rejects(f.adapter.call("pr", { repoRoot: root, pullRequestId: 42 }), /staged, unstaged/);
  assert.equal(f.publications(), 1);
});

test("checkout selection never routes an assigned agent to a host checkout or another Codespace", async t => {
  const f = fixture(t);
  for (const repoRoot of [f.workspace, "/elsewhere/1JS", "/workspaces/one/../two", "/workspaces/1JS/"])
    await assert.rejects(f.adapter.call("prepare", { repoRoot, operation: "setup" }), /absolute checkout path/);
  assert.equal(f.calls.length, 0);
  assert.throws(() => withCodespaceWorkspaces({}, [f.config.file], { readConfig: () => f.config,
    session: { codespace: "another-vm", root: f.config.remoteRoot, tools: f.config.remoteTools } }), /no matching registered/);
});

test("native commands and preparation reuse select the requested checkout without changing the VM lease", async () => {
  const root = "/workspaces/repair", requests = [];
  const config = { purpose: "engineering", remoteRoot: "/workspaces/1JS", remoteTools: "/workspaces/.spool-engineer-tools",
    nativeProfile: { repoRoot: "/workspaces/1JS", toolchainRoot: "/workspaces/1JS",
      nodeExecutable: "/usr/bin/node", storageRoot: "/workspaces", baseBranch: "main" } };
  const transport = { config, leaseToken: "a".repeat(36), logRoot: os.tmpdir(), assertChildren() {},
    borrowed: true, ssh: async (...args) => { requests.push(args); return { stdout: '{"ready":true}' }; } };
  await CodespaceTransport.prototype.native.call(transport, "check", { repoRoot: root });
  const request = JSON.parse(requests[0][3]);
  assert.equal(request.profile.repoRoot, root);
  assert.equal(request.profile.toolchainRoot, root);
  assert.equal(request.remoteTools, config.remoteTools);
  assert.equal(request.leaseToken, transport.leaseToken);
  assert.equal(config.nativeProfile.repoRoot, "/workspaces/1JS");
  await CodespaceTransport.prototype.reusePreparation.call(transport, { repoRoot: root });
  assert.ok(requests.at(-1)[0].includes(`"repoRoot":"${root}"`));
  assert.ok(requests.at(-1)[0].includes(`"toolchainRoot":"${root}"`));
});

test("first-use preparation reuse creates its state directory before taking the real workspace lock", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codespace-first-cache-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, "checkout");
  fs.mkdirSync(checkout);
  const git = (...args) => execFileSync("git", ["--no-pager", ...args], { cwd: checkout, encoding: "utf8" });
  git("init", "--initial-branch=main");
  git("remote", "add", "origin", "https://dev.azure.com/office/Office/_git/1JS");
  fs.writeFileSync(path.join(checkout, "fixture.txt"), "fixture\n");
  git("add", "fixture.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fixture");
  const profile = { repoRoot: checkout, toolchainRoot: checkout, storageRoot: root,
    nodeExecutable: process.execPath, baseBranch: "main" };
  const { stateRoot } = repositoryProfile(profile);
  const transport = {
    borrowed: true,
    config: { purpose: "engineering", remoteRoot: checkout, nativeProfile: profile,
      remoteTools: fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "") },
    ssh: async command => {
      const program = command.slice(command.indexOf(" -e ") + 4).slice(1, -1).replaceAll("'\\''", "'");
      return execute(process.execPath, ["-e", program]);
    },
  };
  assert.equal(fs.existsSync(stateRoot), false);
  assert.equal(await CodespaceTransport.prototype.reusePreparation.call(transport, { repoRoot: checkout, operation: "setup" }), null);
  assert.equal(fs.statSync(stateRoot).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(stateRoot, "repository-mcp.lock")), false);
});
