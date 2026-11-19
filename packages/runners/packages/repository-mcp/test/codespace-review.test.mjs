import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertReviewCoverage, assertReviewIdentity, readCodespaceConfig, shellQuote } from "../src/codespaces/config.mjs";
import { CodespaceReview, changedReviewFiles, assertFreshReview, readReviewPullRequest,
  assertPreparationEvidence, verifySavedCodespace } from "../src/codespaces/review.mjs";
import { repositoryRemoteIdentity } from "../src/checkout.mjs";
import { execute } from "../src/process.mjs";
import { CodespaceTransport, prepareExecutable, nativeExecutable, leaseCommand, pruneAbandonedGitPacks } from "../src/codespaces/transport.mjs";

const source = "a".repeat(40), target = "b".repeat(40), common = "c".repeat(40);
const pr = { id: 123, sourceCommit: source, targetCommit: target, sourceBranch: "refs/heads/user/review",
  status: "active", isDraft: false, title: "Library change" };
const directory = "midgard/packages/m365-copilot-app-library";

test("owned checkout maintenance reclaims only old unopened unindexed temporary packs", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codespace-packs-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pack = path.join(root, ".git", "objects", "pack");
  fs.mkdirSync(pack, { recursive: true });
  const names = ["tmp_pack_ABC123", "tmp_pack_DEF456", "tmp_pack_GHI789", "pack-verified.pack"];
  for (const name of names) {
    const file = path.join(pack, name);
    fs.writeFileSync(file, "preserved");
    if (name !== "tmp_pack_GHI789") fs.utimesSync(file, new Date(0), new Date(0));
  }
  fs.writeFileSync(path.join(pack, "tmp_pack_DEF456.idx"), "index");
  assert.deepEqual(await pruneAbandonedGitPacks(root, files => {
    assert.deepEqual(files, [path.join(pack, "tmp_pack_ABC123")]);
    return false;
  }), { removed: 0, bytes: 0 });
  assert.deepEqual(await pruneAbandonedGitPacks(root, () => true), { removed: 1, bytes: 9 });
  assert.deepEqual(fs.readdirSync(pack).sort(),
    ["pack-verified.pack", "tmp_pack_DEF456", "tmp_pack_DEF456.idx", "tmp_pack_GHI789"]);
});

test("temporary pack maintenance refuses redirected object stores and changed candidates", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codespace-pack-owner-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pack = path.join(root, ".git", "objects", "pack"), shared = path.join(root, "shared");
  fs.mkdirSync(path.dirname(pack), { recursive: true });
  fs.mkdirSync(shared);
  fs.symlinkSync(shared, pack, process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(await pruneAbandonedGitPacks(root, () => assert.fail("Redirects must not be inspected")),
    { removed: 0, bytes: 0 });
  fs.unlinkSync(pack);
  fs.mkdirSync(pack);
  const file = path.join(pack, "tmp_pack_ABC123");
  fs.writeFileSync(file, "old"); fs.utimesSync(file, new Date(0), new Date(0));
  assert.deepEqual(await pruneAbandonedGitPacks(root, () => {
    fs.writeFileSync(file, "active");
    return true;
  }), { removed: 0, bytes: 0 });
  assert.equal(fs.readFileSync(file, "utf8"), "active");
});

test("workspace-local runtimes reach remote commands without changing host or legacy tool paths", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codespace-runtime-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const nodeExecutable of ["/workspaces/.spool-review-runtime/bin/node",
    "/workspaces/reviewer's runtime/bin/node", "/usr/local/bin/node", "/workspaces/../usr/bin/node"]) {
    const transport = new CodespaceTransport({
      workspace, githubAccount: "fixture", nodeExecutable: process.execPath, azureCliDirectory: os.tmpdir(),
      connector: fileURLToPath(new URL("../src/codespaces/connector/src/connect.ts", import.meta.url)),
      nativeProfile: { storageRoot: "/workspaces", nodeExecutable },
    }, { execute: async () => ({ stdout: "fixture-token\n" }) });
    const environment = await transport.environment();
    assert.equal(environment.PATH,
      [os.tmpdir(), path.dirname(process.execPath), process.env.PATH].join(path.delimiter));
    assert.match(transport.gitEnvironment, /GIT_CONFIG_COUNT=/);
    if (nodeExecutable.startsWith("/workspaces/") && !nodeExecutable.includes("/../")) {
      assert.ok(transport.gitEnvironment.startsWith(`PATH=${shellQuote(path.posix.dirname(nodeExecutable))}:"$PATH" `));
    } else {
      assert.ok(transport.gitEnvironment.startsWith("SKIP_PRE_COMMIT=1 "));
    }
  }
});

test("Codespace leases wait for cleanup and distinguish contention without stealing ownership", t => {
  const command = leaseCommand("/workspaces/.spool-perf-tools", "a".repeat(36), "/workspaces/1JS");
  assert.match(command, /flock -w 30 -E 75/);
  assert.ok(command.includes("/workspaces/1JS/.git/repository-mcp-codespace.lease"));
  assert.ok(command.includes("/workspaces/.spool-perf-tools.lease"));
  assert.ok(command.includes("CODESPACE_WORKSPACE_BUSY"));
  assert.doesNotMatch(command, /flock -n|kill|rm /);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "codespace-busy-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const logFile = path.join(folder, "lease.log");
  fs.writeFileSync(logFile, "CODESPACE_WORKSPACE_BUSY: another operation owns this Codespace\n");
  assert.throws(() => CodespaceTransport.prototype.assertChildren.call({
    children: new Set([{ kind: "lease", failure: "exited 1", logFile }]),
  }), error => error.code === "CODESPACE_WORKSPACE_BUSY" && error.reasonCode === "workspace_busy");
});

test("failed SSH-server startup preserves the actionable cause for shared message recovery", t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "codespace-ssh-startup-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const logFile = path.join(folder, "lease.log");
  fs.writeFileSync(logFile, "error getting ssh server details: failed to start SSH server\n");
  assert.throws(() => CodespaceTransport.prototype.assertChildren.call({
    children: new Set([{ kind: "lease", failure: "exited 1", logFile }]),
  }), /Codespace connection\/runtime exited 1; log: .*; error getting ssh server details: failed to start SSH server/);
});

test("cold native preparation has a bounded bootstrap deadline without extending steady-state operations", async () => {
  for (const operation of ["prepare", "build", "check", "pr"]) {
    const calls = [];
    const transport = {
      config: { remoteTools: "/workspaces/.tools", nativeProfile: { nodeExecutable: "/usr/bin/node" } },
      leaseToken: "a".repeat(36),
      logRoot: os.tmpdir(), assertChildren() {},
      ssh: async (...args) => {
        calls.push(args);
        return { stdout: JSON.stringify({ ready: true }) };
      },
    };
    assert.deepEqual(await CodespaceTransport.prototype.native.call(transport, operation, {}), { ready: true });
    assert.equal(calls[0][1], operation === "prepare" ? 21600 : 7200);
    assert.match(calls[0][2], new RegExp(`${operation}-.*\\.log$`));
    assert.equal(calls[1][1], undefined);
    assert.ok(calls[0][0].includes(nativeExecutable));
    const request = JSON.parse(calls[0][3]);
    assert.equal(request.remoteTools, transport.config.remoteTools);
    assert.equal(request.leaseToken, transport.leaseToken);
  }
});

test("large PR inventories travel intact on stdin without exceeding Windows command-line limits", async t => {
  const files = Array.from({ length: 1000 }, (_, index) =>
    `midgard/packages/library-module-exp-homepage/src/nested/component-${index}.tsx`);
  const calls = [];
  const transport = {
    config: { remoteTools: "/workspaces/.tools", nativeProfile: { nodeExecutable: "/usr/bin/node" } },
    leaseToken: "a".repeat(36), logRoot: os.tmpdir(), assertChildren() {},
    ssh: async (...args) => { calls.push(args); return { stdout: '{"ready":true}' }; },
  };
  await CodespaceTransport.prototype.native.call(transport, "prepare", { sourceCommit: source }, files);
  assert.ok(calls[0][3].length > 65536);
  assert.ok(calls[0][0].length < 1024);
  assert.deepEqual(JSON.parse(calls[0][3]).reviewFiles, files);
  const entry = new URL("../src/codespaces/native.mjs", import.meta.url);
  const invalid = { profile: { repoRoot: "/unregistered" }, reviewFiles: files };
  await assert.rejects(execute(process.execPath, ["-e", nativeExecutable, fileURLToPath(entry)],
    { input: JSON.stringify(invalid) }), /Codespace native entry requires its registered 1JS checkout/);
  await assert.rejects(execute(process.execPath, [fileURLToPath(entry), "--stdin"],
    { input: JSON.stringify(invalid) }), /Codespace native entry requires its registered 1JS checkout/);
  await assert.rejects(execute(process.execPath, [fileURLToPath(entry),
    Buffer.from(JSON.stringify({ profile: invalid.profile })).toString("base64")]),
  /Codespace native entry requires its registered 1JS checkout/);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "codespace-legacy-stdin-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const legacy = path.join(folder, "native.mjs");
  fs.writeFileSync(legacy, 'console.log(JSON.stringify(JSON.parse(Buffer.from(process.argv[2],"base64").toString("utf8")).reviewFiles));');
  const { stdout } = await execute(process.execPath, ["-e", nativeExecutable, legacy],
    { input: JSON.stringify(invalid) });
  assert.deepEqual(JSON.parse(stdout), files, "Already-deployed legacy backends must work without restart");
});

function fixture(t, overrides = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codespace-review-"));
  t.after(() => fs.rmSync(workspace, { force: true, recursive: true }));
  const file = path.join(workspace, "config.json");
  fs.writeFileSync(file, "{}");
  const config = { file, workspace, codespace: "fixture", remoteRoot: "/workspaces/1JS", minimumFreeGiB: 12 };
  const calls = [];
  let disposed = false;
  const transport = {
    config,
    leaseToken: "f".repeat(36), verifyLease: async () => {},
    children: new Set(), initialize: async () => calls.push("connect"),
    deploy: async () => calls.push("deploy"),
    assertChildren() {},
    async ssh(command) {
      calls.push(command);
      return { stdout: command.includes("git symbolic-ref") ? `${source}\nreview/pr-123-${source.slice(0, 12)}\n`
        : command.includes("ls-remote") ? `${source}\t${pr.sourceBranch}\n` : "" };
    },
    async native(operation, input) {
      calls.push({ operation, input });
      return { ready: true, buildWarmed: true, preparationKind: "repository-prepare", repoRoot: config.remoteRoot,
        commit: source, branch: `review/pr-123-${source.slice(0, 12)}` };
    },
    dispose: async () => { disposed = true; },
  };
  const dependencies = { config, transport, readPr: async () => ({ ...pr }),
    changes: async () => ({ commonCommit: common, files: [`${directory}/src/index.ts`] }),
    ...overrides };
  const session = new CodespaceReview(file, dependencies);
  return { session, calls, transport, workspace, disposed: () => disposed };
}

test("native result recovery retries transient Codespaces lookup failures without replaying the operation", async t => {
  for (const diagnostic of [
    "getting full codespace details: error making request: received response with status code 500",
    "getting full codespace details: HTTP 503: Service Unavailable (https://api.github.com/user/codespaces/fixture)",
  ]) {
    const f = fixture(t), calls = [], waits = [];
    const transport = new CodespaceTransport({
      ...f.transport.config, remoteTools: "/workspaces/.tools", nativeProfile: { nodeExecutable: "/usr/bin/node" },
    }, { delay: async ms => waits.push(ms) });
    transport.ssh = async command => {
      calls.push(command);
      if (command.startsWith("cat ") && calls.length < 4)
        throw new Error(`gh codespace ssh failed (1)\n${diagnostic}\n`);
      return { stdout: JSON.stringify({ ready: true, checked: true }) };
    };
    assert.deepEqual(await transport.native("check", {}), { ready: true, checked: true });
    assert.equal(calls.filter(command => !command.startsWith("cat ")).length, 1);
    assert.equal(new Set(calls.slice(1)).size, 1);
    assert.deepEqual(waits, [1000, 2000]);
  }
});

test("native result recovery is bounded and does not retry missing results or invalid JSON", async t => {
  for (const diagnostic of [
    "getting full codespace details: error making request: received response with status code 502",
    "getting full codespace details: HTTP 404: Not Found",
    "cat: result.json: No such file or directory",
    null,
  ]) {
    const f = fixture(t), calls = [];
    const transport = new CodespaceTransport({
      ...f.transport.config, remoteTools: "/workspaces/.tools", nativeProfile: { nodeExecutable: "/usr/bin/node" },
    }, { delay: async () => {} });
    transport.ssh = async command => {
      calls.push(command);
      if (!command.startsWith("cat ")) return { stdout: "" };
      if (diagnostic) throw new Error(`gh codespace ssh failed (1)\n${diagnostic}`);
      return { stdout: "not JSON" };
    };
    await assert.rejects(transport.native("pr", {}));
    assert.equal(calls.filter(command => !command.startsWith("cat ")).length, 1);
    assert.equal(calls.length, diagnostic?.includes("502") ? 4 : 2);
  }
});

test("review identity refuses imprecise revisions and unsafe branches", () => {
  assertReviewIdentity(pr);
  for (const patch of [{ id: 0 }, { sourceCommit: "main" }, { targetCommit: "" }, { sourceBranch: "refs/heads/a\nbad" }])
    assert.throws(() => assertReviewIdentity({ ...pr, ...patch }), /Review requires/);
});

test("UI review hands off without browser provisioning or application startup", async t => {
  const f = fixture(t, { changes: async () => ({ commonCommit: common,
    files: ["midgard/packages/library-module-ux/src/Tile.styles.ts"] }) });
  const prepared = await f.session.prepare({ prId: pr.id, sourceCommit: source });
  assert.equal(prepared.ready, true);
  assert.equal(prepared.browserRuntime, undefined);
  assert.equal(f.calls.some(call => typeof call === "string" && /browser\.mjs|runtime\.mjs/.test(call)), false);
  await f.session.dispose();
});
test("full Codespace coverage accepts other packages but rejects unsafe or absent paths", () => {
  assertReviewCoverage([`${directory}/src/a.ts`, "midgard/change/fixture.json",
    "midgard/packages/bebop-icons/src/index.ts", "packages/tooling/package.json", "README.md"]);
  for (const files of [[], ["../outside"], ["/root/file"], ["midgard/../file"], [".git/config"], [null]])
    assert.throws(() => assertReviewCoverage(files));
});
test("shell arguments retain literal quotes", () => assert.equal(shellQuote("a'b"), "'a'\\''b'"));
test("official ADO legacy origin is equivalent, without accepting another repository or host", () => {
  const expected = repositoryRemoteIdentity("https://dev.azure.com/office/Office/_git/1JS");
  assert.equal(repositoryRemoteIdentity("https://office.visualstudio.com/Office/_git/1JS.git"), expected);
  for (const value of ["https://office.visualstudio.com.attacker/Office/_git/1JS",
    "https://other.visualstudio.com/Office/_git/1JS", "https://office.visualstudio.com/OC/_git/1JS",
    "https://office.visualstudio.com/Office/_git/not1JS"])
    assert.notEqual(repositoryRemoteIdentity(value), expected);
});
test("pinned comparison reads complete Git inventory instead of paginating branch changes", async () => {
  const urls = [];
  const comparison = await changedReviewFiles(pr, async url => {
    urls.push(url);
    return { commonCommit: common, baseCommit: target, targetCommit: source };
  }, async (base, head) => {
    assert.equal(base, common);
    assert.equal(head, source);
    return [`${directory}/new.ts`, `${directory}/old.ts`, `${directory}/last.ts`];
  });
  assert.equal(comparison.commonCommit, common);
  assert.equal(comparison.files.length, 3);
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes("$top=0"));
  assert.ok(urls.every(url => url.includes(`baseVersion=${target}`) && url.includes(`targetVersion=${source}`)));
});
test("renames across packages retain both source and destination for remote validation", async () => {
  const comparison = await changedReviewFiles(pr, async () => ({
    commonCommit: common, baseCommit: target, targetCommit: source,
  }), async () => [`${directory}/new.ts`, "midgard/packages/other/old.ts"]);
  assert.deepEqual(comparison.files, [`${directory}/new.ts`, "midgard/packages/other/old.ts"].sort());
});
test("incomplete or unstable comparison cannot pass", async () => {
  for (const patch of [{ commonCommit: undefined }, { baseCommit: source }, { targetCommit: target },
    { changes: [{ item: { path: "/unexpected" } }] }])
    await assert.rejects(changedReviewFiles(pr, async () => ({
      commonCommit: common, baseCommit: target, targetCommit: source, ...patch,
    }), async () => assert.fail("Unpinned metadata must not reach Git")));
  await assert.rejects(changedReviewFiles(pr, async () => ({
    commonCommit: common, baseCommit: target, targetCommit: source,
  }), async () => []), /inventory is missing/);
});
test("large real PRs keep their complete inventory beyond the former REST pagination limit", async () => {
  const files = Array.from({ length: 100001 }, (_, index) => `${directory}/file-${index}.ts`);
  const comparison = await changedReviewFiles(pr, async () => ({
    commonCommit: common, baseCommit: target, targetCommit: source,
  }), async () => files);
  assert.equal(comparison.files.length, files.length);
  assert.deepEqual(new Set(comparison.files), new Set(files));
});
test("remote comparison fetches only missing pinned objects and reports both rename paths", async () => {
  let command;
  const files = await CodespaceTransport.prototype.changedReviewFiles.call({
    config: { remoteRoot: "/workspaces/1JS" }, assertChildren() {},
    ssh: async (value, timeout) => {
      command = value;
      assert.equal(timeout, 900);
      return { stdout: `${directory}/old.ts\0${directory}/new.ts\0` };
    },
  }, common, source);
  assert.deepEqual(files, [`${directory}/old.ts`, `${directory}/new.ts`]);
  assert.ok(command.includes(`cat-file -e '${common}^{commit}'`));
  assert.ok(command.includes(`cat-file -e '${source}^{commit}'`));
  assert.ok(command.includes("fetch_filter=--filter=tree:0"));
  assert.ok(command.includes("fetch_filter=--no-filter"));
  assert.ok(command.includes(`--negotiation-tip='${common}' origin '${source}'`));
  assert.ok(command.includes(`--no-renames --name-only -z '${common}' '${source}' --`));
  assert.doesNotMatch(command, /checkout|reset|clean|merge-base/);
  await assert.rejects(CodespaceTransport.prototype.changedReviewFiles.call({}, "main", source), /pinned/);
});
test("cold comparisons fetch pinned history without hydrating discarded historical trees", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codespace-cold-comparison-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin"), client = path.join(root, "client");
  const git = (args, cwd = origin, env) => execute("git", args, { cwd, env });
  const localObjects = async cwd => new Set((await git(["cat-file", "--batch-all-objects",
    "--batch-check=%(objectname)"], cwd)).stdout.trim().split(/\r?\n/));
  await git(["init", "-b", "main", origin], root);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.com"]);
  await git(["config", "uploadpack.allowFilter", "true"]);
  await git(["config", "uploadpack.allowAnySHA1InWant", "true"]);
  fs.writeFileSync(path.join(origin, "retired.txt"), "retired\n");
  await git(["add", "."]);
  await git(["commit", "-qm", "Historical tree"]);
  const historicalTree = (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim();
  await git(["rm", "retired.txt"]);
  const folder = path.join(origin, ...directory.split("/"));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "old.ts"), "old\n");
  fs.writeFileSync(path.join(origin, "unrelated.ts"), "before\n");
  await git(["add", "."]);
  await git(["commit", "-qm", "Comparison base"]);
  const base = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await git(["branch", "comparison-base"]);
  fs.renameSync(path.join(folder, "old.ts"), path.join(folder, "new.ts"));
  fs.writeFileSync(path.join(origin, "unrelated.ts"), "after\n");
  await git(["add", "."]);
  await git(["commit", "-qm", "Comparison source"]);
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await git(["init", client], root);
  await git(["remote", "add", "origin", pathToFileURL(origin).href], client);
  await git(["config", "remote.origin.promisor", "true"], client);
  await git(["config", "remote.origin.partialclonefilter", "blob:none"], client);
  const execPath = (await git(["--exec-path"])).stdout.trim();
  const bash = process.platform === "win32" ? path.resolve(execPath, "..", "..", "..", "bin", "bash.exe") : "bash";
  let comparisonTrace;
  const files = await CodespaceTransport.prototype.changedReviewFiles.call({
    config: { remoteRoot: client }, assertChildren() {},
    ssh: async command => {
      const result = await execute(bash, ["-exc", command], { cwd: client,
        env: { ...process.env, GIT_TRACE: "1" } });
      comparisonTrace = result.output;
      return result;
    },
  }, base, head);
  assert.deepEqual(files.sort(), [`${directory}/new.ts`, `${directory}/old.ts`, "unrelated.ts"]);
  assert.equal((await localObjects(client)).has(historicalTree), false,
    `Comparison must not hydrate discarded historical trees:\n${comparisonTrace}`);
  const cache = path.join(root, "cache"), nativeClient = path.join(root, "native-client");
  await git(["clone", "--bare", "--single-branch", "--branch", "comparison-base", pathToFileURL(origin).href, cache], root);
  await git(["init", nativeClient], root);
  await git(["remote", "add", "origin", pathToFileURL(origin).href], nativeClient);
  await git(["config", "core.gvfs", "150"], nativeClient);
  await git(["config", "remote.origin.promisor", "true"], nativeClient);
  await git(["config", "remote.origin.partialclonefilter", "blob:none"], nativeClient);
  fs.writeFileSync(path.join(nativeClient, ".git", "objects", "info", "alternates"),
    `${path.join(cache, "objects").replaceAll("\\", "/")}\n`);
  await git(["fetch", "--filter=tree:0", "origin", head], nativeClient);
  const headTree = (await git(["rev-parse", `${head}^{tree}`])).stdout.trim();
  assert.equal((await localObjects(nativeClient)).has(headTree), false);
  let trace;
  const nativeFiles = await CodespaceTransport.prototype.changedReviewFiles.call({
    config: { remoteRoot: nativeClient }, assertChildren() {},
    ssh: async command => {
      const result = await execute(bash, ["-ec", command],
        { cwd: nativeClient, env: { ...process.env, GIT_TRACE: "1" } });
      trace = result.output;
      return result;
    },
  }, base, head);
  assert.deepEqual(nativeFiles.sort(), files.sort());
  assert.match(trace, /fetch[^\n]*--no-filter/);
  assert.doesNotMatch(trace, /index-pack[^\n]*--promisor|exclude-promisor-objects-best-effort/);
});
test("freshness checks source, target, branch, draft and status", () => {
  assertFreshReview(pr, { ...pr });
  for (const patch of [{ sourceCommit: target }, { targetCommit: source }, { sourceBranch: "refs/heads/other" },
    { status: "completed" }, { isDraft: true }])
    assert.throws(() => assertFreshReview(pr, { ...pr, ...patch }), /changed/);
});
test("PR metadata refuses inactive, draft and absent exact commit", async () => {
  for (const patch of [{ status: "completed" }, { isDraft: true }, { lastMergeSourceCommit: {} }]) {
    await assert.rejects(readReviewPullRequest(123, async () => ({
      status: "active", isDraft: false, sourceRefName: pr.sourceBranch,
      lastMergeSourceCommit: { commitId: source }, lastMergeTargetCommit: { commitId: target }, ...patch,
    })));
  }
});
test("canonical setup and build hand off the fresh revision without checks, application or browser startup", async t => {
  const f = fixture(t);
  f.session.startRuntime = () => assert.fail("Preparation must not start the application");
  f.session.browserProbe = () => assert.fail("Preparation must not open a browser");
  f.session.checkLocalRuntimePort = () => assert.fail("Preparation must not reserve an application port");
  const result = await f.session.prepare({ prId: pr.id, sourceCommit: source });
  assert.equal(result.ready, true);
  assert.equal(result.execution.kind, "codespace");
  assert.equal(result.repoRoot, f.workspace);
  const operations = f.calls.filter(call => typeof call === "object");
  assert.deepEqual(operations.map(call => call.operation), ["prepare"]);
  assert.equal(operations[0].input.sourceCommit, source);
  assert.equal(operations[0].input.expectedHead, undefined);
  assert.equal(operations[0].input.reset, true);
  assert.equal(operations[0].input.mergeMaster, false);
  assert.equal(operations[0].input.runBuild, true);
  assert.equal(operations[0].input.runSetup, true);
  assert.equal(result.checks, undefined);
  assert.equal(result.runtime, undefined);
  assert.equal(result.browser, undefined);
  assertPreparationEvidence(result, f.session.config);
});
test("queued stale revision is rejected before contacting Codespace", async t => {
  const f = fixture(t);
  await assert.rejects(f.session.prepare({ prId: pr.id, sourceCommit: target }), /stale/);
  assert.deepEqual(f.calls, []);
  assert.equal(JSON.parse(fs.readFileSync(f.session.receiptFile)).ready, false);
});
test("saved review verification reuses approved owner credentials only after proving the lease", async t => {
  const f = fixture(t);
  f.session.config.remoteTools = "/workspaces/.review-tools";
  f.session.config.nativeProfile = { nodeExecutable: "/usr/bin/node" };
  f.session.useOwnedAuthentication = true;
  f.transport.reviewAccessToken = CodespaceTransport.prototype.reviewAccessToken.bind(f.transport);
  f.session.receipt = { pr, commit: source, branch: `review/pr-123-${source.slice(0, 12)}` };
  let leaseVerified = false, credentialRequests = 0;
  f.transport.verifyLease = async () => { leaseVerified = true; };
  const ssh = f.transport.ssh.bind(f.transport);
  f.transport.ssh = async command => {
    if (!command.includes("azure-helper.mjs")) return ssh(command);
    assert.equal(leaseVerified, true);
    assert.match(command, /SPOOL_REVIEW_AZURE_AUTH_FILE='\/workspaces\/\.review-tools\/azure-auth.json'/);
    assert.match(command, /get-access-token 499b84ac-1321-427f-aa17-267ca6975798 --json$/);
    credentialRequests++;
    return { stdout: JSON.stringify({ accessToken: "fixture-token", expires_on: Date.now() / 1000 + 3600 }) };
  };
  f.session.readPr = async () => {
    assert.equal(await f.session.accessToken(), "fixture-token");
    return { ...pr };
  };
  await f.session.verify();
  assert.equal(await f.session.accessToken(), "fixture-token");
  assert.equal(credentialRequests, 1);
  leaseVerified = false;
  f.transport.verifyLease = async () => { throw new Error("Owner lease lost"); };
  await assert.rejects(f.session.verify(), /Owner lease lost/);
  assert.equal(credentialRequests, 1);
});

test("owner authentication rejects expired or malformed credentials without a local CLI fallback", async t => {
  for (const expires_on of [0, "invalid"]) {
    const f = fixture(t);
    f.session.config.remoteTools = "/workspaces/.review-tools";
    f.session.config.nativeProfile = { nodeExecutable: "/usr/bin/node" };
    f.session.useOwnedAuthentication = true;
    f.transport.reviewAccessToken = CodespaceTransport.prototype.reviewAccessToken.bind(f.transport);
    f.transport.ssh = async () => ({ stdout: JSON.stringify({ accessToken: "fixture-token", expires_on }) });
    await assert.rejects(f.session.accessToken(), /review authentication is unavailable or requires renewal/);
  }
});
test("failed shared build still hands off the exact checkout without claiming build success", async t => {
  const f = fixture(t), native = f.transport.native;
  f.transport.native = async (...args) => ({ ...await native(...args),
    buildWarmed: false, buildError: "Required build failed" });
  const prepared = await f.session.prepare({ prId: pr.id });
  assert.equal(prepared.ready, true);
  assert.equal(prepared.packagePreparation.buildWarmed, false);
  assert.equal(prepared.packagePreparation.buildError, "Required build failed");
  assertPreparationEvidence(prepared, f.session.config);
  assert.equal(f.disposed(), false);
  await f.session.dispose();
});
test("review preparation requires canonical setup evidence but not pre-assignment test execution", async t => {
  const f = fixture(t, {
    readSourceRef: async () => source,
  });
  f.session.config.repositoryReview = true;
  f.transport.native = async (operation, input, files) => {
    assert.equal(operation, "prepare");
    assert.deepEqual(files, [`${directory}/src/index.ts`]);
    return { ready: true, buildWarmed: true, preparationKind: "repository-prepare",
      repoRoot: f.session.config.remoteRoot, commit: source, branch: `review/pr-123-${source.slice(0, 12)}` };
  };
  const receipt = await f.session.prepare({ prId: pr.id });
  assert.equal(receipt.ready, true);
  assert.equal(receipt.runtime, undefined);
  assert.equal(receipt.browser, undefined);
  assertPreparationEvidence(receipt, f.session.config);
});
test("full-repository source-ref verification uses the exact authenticated provider ref", async t => {
  const f = fixture(t, { readSourceRef: async () => target });
  f.session.config.repositoryReview = true;
  await assert.rejects(f.session.prepare({ prId: pr.id }), /source branch moved/);
  assert.equal(f.calls.some(call => typeof call === "object" && call.operation === "prepare"), false);
});
test("moving target is refreshed only when the pinned source and complete comparison are unchanged", async t => {
  const f = fixture(t, {
    readPr: async () => ({ ...pr, targetCommit: common }), readSourceRef: async () => source,
  });
  f.session.config.repositoryReview = true;
  f.session.receipt = { pr, commit: source, branch: `review/pr-123-${source.slice(0, 12)}`,
    comparison: { commonCommit: common, files: [`${directory}/src/index.ts`] } };
  await f.session.verify();
  assert.equal(f.session.receipt.pr.targetCommit, common);
  assert.equal(f.session.receipt.targetRevalidation.unchangedDiff, true);
  f.session.receipt.pr = pr;
  f.session.changes = async () => ({ commonCommit: common, files: ["midgard/packages/other/new.ts"] });
  await assert.rejects(f.session.verify(), /comparison changed/);
});
test("auth, checkout and deployment failures persist blocked state", async t => {
  for (const stage of ["initialize", "ssh", "deploy", "native"]) {
    const f = fixture(t);
    f.transport[stage] = async () => { throw new Error(`${stage} failed`); };
    await assert.rejects(f.session.prepare({ prId: pr.id }), new RegExp(`${stage} failed`));
    assert.equal(JSON.parse(fs.readFileSync(f.session.receiptFile)).status, "blocked");
    assert.equal(f.disposed(), true);
  }
});
test("a noncanonical preparation cannot be handed to the reviewer", async t => {
  const f = fixture(t), native = f.transport.native;
  f.transport.native = async (...args) => ({ ...await native(...args), preparationKind: undefined });
  await assert.rejects(f.session.prepare({ prId: pr.id }), /canonical repository preparation/);
  assert.equal(f.session.receipt.ready, false);
  assert.equal(f.disposed(), true);
});
test("late source changes block handoff after preparation", async t => {
  let reads = 0;
  const f = fixture(t, { readPr: async () => ({ ...pr, sourceCommit: reads++ ? target : source }) });
  await assert.rejects(f.session.prepare({ prId: pr.id }), /changed during preparation/);
});
test("lost lifecycle ownership blocks a previously passing revision", async t => {
  const f = fixture(t);
  f.transport.verifyLease = async () => { throw new Error("Remote review owner changed"); };
  await assert.rejects(f.session.prepare({ prId: pr.id }), /owner changed/);
  assert.equal(f.session.receipt.ready, false);
});
test("lost connections invalidate a successful receipt but owned cleanup does not invent a failure", async t => {
  for (const dispose of [false, true]) {
    const f = fixture(t);
    const child = new EventEmitter();
    child.logFile = "fixture-runtime.log";
    f.transport.children.add(child);
    await f.session.prepare({ prId: pr.id });
    if (dispose) await f.session.dispose();
    child.emit("exit", 1);
    assert.equal(f.session.receipt.ready, false);
    assert.equal(f.session.receipt.status, dispose ? "stopped" : "blocked");
  }
});
test("remote revision changes block handoff", async t => {
  const f = fixture(t);
  const ssh = f.transport.ssh;
  f.transport.ssh = async command => command.includes("git symbolic-ref")
    ? { stdout: `${target}\nreview/pr-123-${source.slice(0, 12)}\n` } : ssh(command);
  await assert.rejects(f.session.prepare({ prId: pr.id }), /Remote revision changed/);
});
test("pinned review branches do not bypass the actual PR source-ref guard", async t => {
  const f = fixture(t);
  const ssh = f.transport.ssh;
  f.transport.ssh = async command => command.includes("ls-remote")
    ? { stdout: `${target}\t${pr.sourceBranch}\n` } : ssh(command);
  await assert.rejects(f.session.prepare({ prId: pr.id }), /source branch moved/);
  assert.equal(f.calls.some(call => call.operation === "prepare"), false);
});
test("configuration cannot silently weaken authenticated runtime or escape remote root", () => {
  assert.throws(() => readCodespaceConfig("relative.json"), /absolute/);
});
test("saved handoff evidence requires exact preparation identity and an honest build outcome, not a browser", async () => {
  const valid = { version: 1, preparationKind: "repository-prepare", commit: source,
    sourceCommit: source, branch: "review/fixture", pr,
    packagePreparation: { ready: true, preparationKind: "repository-prepare",
      buildWarmed: true, commit: source, branch: "review/fixture" } };
  assertPreparationEvidence(valid);
  assertPreparationEvidence({ ...valid, packagePreparation: { ...valid.packagePreparation, buildWarmed: false } });
  for (const patch of [{ version: undefined }, { preparationKind: undefined }, { packagePreparation: undefined },
    { packagePreparation: { ...valid.packagePreparation, buildWarmed: undefined } },
    { packagePreparation: { ...valid.packagePreparation, commit: target } },
    { packagePreparation: { ...valid.packagePreparation, branch: "other" } },
    { packagePreparation: { ...valid.packagePreparation, preparationKind: undefined } },
    { sourceCommit: target }, { pr: { ...pr, sourceCommit: target } }])
    assert.throws(() => assertPreparationEvidence({ ...valid, ...patch }), /lacks exact-revision/);
  await assert.rejects(verifySavedCodespace({ ready: false, status: "blocked" }), /not ready/);
});

for (const transient of [true, false])
test(`saved review preparation ${transient ? "survives a temporary disconnect and is verified again" : "is invalidated after a real revision change"}`, async t => {
  const f = fixture(t);
  const config = { version: 1, purpose: "review", codespace: "fixture", githubAccount: "fixture",
    workspace: f.workspace, nodeExecutable: process.execPath, azureCliDirectory: f.workspace,
    remoteRoot: "/workspaces/1JS", remoteTools: "/workspaces/.reviewer", minimumFreeGiB: 12,
    nativeProfile: { repoRoot: "/workspaces/1JS", toolchainRoot: "/workspaces/1JS",
      storageRoot: "/workspaces", baseBranch: "main", nodeExecutable: "/usr/bin/node" } };
  fs.writeFileSync(f.session.config.file, JSON.stringify(config));
  Object.assign(f.session.config, config);
  const prepared = await f.session.prepare({ prId: pr.id });
  f.transport.env = {};
  const receiptFile = path.join(f.workspace, "preparation.json"), before = fs.readFileSync(receiptFile, "utf8");
  const failure = new Error(transient ? "Connection reset by peer" : "Remote revision changed; handoff blocked");
  let calls = 0;
  t.mock.method(CodespaceReview.prototype, "verify", async () => {
    if (++calls === 1) throw failure;
  });
  await assert.rejects(verifySavedCodespace(prepared, { transport: f.transport }), error => error === failure);
  if (transient) {
    assert.equal(fs.readFileSync(receiptFile, "utf8"), before, "A connection outage is not proof of stale preparation");
    await verifySavedCodespace(prepared, { transport: f.transport });
    assert.equal(calls, 2, "Preserved evidence must still be freshly verified on every attempt");
  } else {
    assert.equal(JSON.parse(fs.readFileSync(receiptFile, "utf8")).ready, false);
    await assert.rejects(verifySavedCodespace(prepared, { transport: f.transport }), /stopped, changed or unverified/);
    assert.equal(calls, 1);
  }
});

test("binary SSH deployment input is delivered without local shell interpretation", async () => {
  const input = Buffer.from([0, 1, 10, 13, 39, 255, 128]);
  const result = await execute(process.execPath, ["-e",
    "const chunks=[];process.stdin.on('data',b=>chunks.push(b));process.stdin.on('end',()=>console.log(Buffer.concat(chunks).toString('hex')))"],
  { input });
  assert.equal(result.stdout.trim(), input.toString("hex"));
});
test("Windows deployment preserves a Linux-executable LF shebang", async t => {
  const f = fixture(t);
  const file = path.join(f.workspace, "helper.mjs");
  fs.writeFileSync(file, "#!/usr/bin/env node\r\nconsole.log('fixture');\r\n");
  await execute(process.execPath, ["-e", prepareExecutable, file]);
  assert.equal(fs.readFileSync(file, "utf8"), "#!/usr/bin/env node\nconsole.log('fixture');\n");
});


test("invalid remote configuration fails before connecting", t => {
  const f = fixture(t);
  const base = { version: 1, codespace: "fixture", githubAccount: "fixture", connector: f.session.config.file,
    nodeExecutable: process.execPath, azureCliDirectory: f.workspace, workspace: f.workspace,
    remoteRoot: "/workspaces/1JS", remoteTools: "/workspaces/.reviewer",
    minimumFreeGiB: 12, nativeProfile: { repoRoot: "/workspaces/1JS", toolchainRoot: "/workspaces/1JS",
      storageRoot: "/workspaces", baseBranch: "main", nodeExecutable: "/usr/local/bin/node" } };
  for (const patch of [{ remoteTools: "/workspaces/1JS/tools" }, { remoteRoot: "/workspaces/../other" },
    { minimumFreeGiB: 0 }, { runtime: {} },
    { nativeProfile: { ...base.nativeProfile, toolchainRoot: "/other" } },
    { remoteRoot: "/workspaces/another", nativeProfile: { ...base.nativeProfile,
      repoRoot: "/workspaces/another", toolchainRoot: "/workspaces/another" } },
    { nativeProfile: { ...base.nativeProfile, nodeExecutable: "node" } }]) {
    fs.writeFileSync(f.session.config.file, JSON.stringify({ ...base, ...patch }));
    assert.throws(() => readCodespaceConfig(f.session.config.file));
  }
  fs.writeFileSync(f.session.config.file, JSON.stringify(base));
  assert.equal(readCodespaceConfig(f.session.config.file).codespace, "fixture");
  const review = { ...base, purpose: "review", repositoryReview: true };
  fs.writeFileSync(f.session.config.file, JSON.stringify(review));
  assert.equal(readCodespaceConfig(f.session.config.file).runtime, undefined);
});

test("native startup recreates only its control directory after validating the profile", t => {
  const f = fixture(t), workspace = path.join(f.workspace, "missing", "review");
  const value = { version: 1, purpose: "review", codespace: "fixture", githubAccount: "fixture",
    connector: f.session.config.file, nodeExecutable: process.execPath, azureCliDirectory: f.workspace, workspace,
    reviewTemplate: f.session.config.file,
    remoteRoot: "/workspaces/1JS", remoteTools: "/workspaces/.reviewer", minimumFreeGiB: 12,
    nativeProfile: { repoRoot: "/workspaces/1JS", toolchainRoot: "/workspaces/1JS",
      storageRoot: "/workspaces", baseBranch: "main", nodeExecutable: "/usr/local/bin/node" } };
  fs.writeFileSync(f.session.config.file, JSON.stringify(value));
  assert.throws(() => readCodespaceConfig(f.session.config.file), /workspace.*ENOENT/);
  assert.equal(fs.existsSync(workspace), false);
  for (const patch of [{ connector: path.join(f.workspace, "missing.ts") },
    { remoteRoot: "/workspaces/../other" }, { reviewTemplate: path.join(f.workspace, "missing.md") }]) {
    fs.writeFileSync(f.session.config.file, JSON.stringify({ ...value, ...patch }));
    assert.throws(() => readCodespaceConfig(f.session.config.file, { createWorkspace: true }));
    assert.equal(fs.existsSync(workspace), false);
  }
  fs.writeFileSync(f.session.config.file, JSON.stringify(value));
  const config = readCodespaceConfig(f.session.config.file, { createWorkspace: true });
  assert.equal(config.workspace, fs.realpathSync.native(workspace));
  assert.deepEqual(fs.readdirSync(workspace), []);
  assert.equal(readCodespaceConfig(f.session.config.file).workspace, config.workspace);
});

test("the bundled connector runs and installs both stock auth shims without a host 1JS checkout", async t => {
  const f = fixture(t);
  const value = { version: 1, purpose: "engineering", codespace: "fixture", githubAccount: "fixture",
    nodeExecutable: process.execPath, azureCliDirectory: f.workspace, workspace: f.workspace,
    remoteRoot: "/workspaces/1JS", remoteTools: "/workspaces/.engineer", minimumFreeGiB: 12,
    nativeProfile: { repoRoot: "/workspaces/1JS", toolchainRoot: "/workspaces/1JS",
      storageRoot: "/workspaces", baseBranch: "main", nodeExecutable: "/usr/local/bin/node" } };
  fs.writeFileSync(f.session.config.file, JSON.stringify(value));
  const config = readCodespaceConfig(f.session.config.file);
  const help = await execute(process.execPath, [config.connector, "--help"]);
  assert.match(help.stdout, /usage: ado-auth-connect/);
  const { pathToFileURL } = await import("node:url");
  const auth = await import(pathToFileURL(path.join(path.dirname(config.connector), "agentsAuth.ts")).href);
  let command;
  auth.installShims("fixture", false, args => {
    command = args.at(-1);
    return { status: 0, stdout: "ado-auth-connect:shim-installed", stderr: "" };
  });
  assert.match(command, /ado-auth-helper/);
  assert.match(command, /git-credential-azure-devops/);
  fs.writeFileSync(f.session.config.file, JSON.stringify({ ...value, connector: path.join(f.workspace, "missing.ts") }));
  assert.throws(() => readCodespaceConfig(f.session.config.file), /connector.*ENOENT/);
});
