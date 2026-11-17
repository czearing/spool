import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { engineeringSnapshot, withCodespaceWorkspaces, verifyEngineeringCodespace } from "../src/codespaces/engineering.mjs";
import { readCodespaceConfig } from "../src/codespaces/config.mjs";
import { createHash } from "node:crypto";
import { stageCreatorReview, syncCreatorReview, resolveCreatorReview } from "../src/codespaces/creator-review.mjs";
import { withSpoolReviewTools, reviewFindings, reviewPrompt } from "../../../scanners/lib/creator-review.mjs";

function fixture(t) {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "codespace-engineering-")));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const file = path.join(workspace, "config.json"), calls = [];
  fs.writeFileSync(file, "{}");
  const config = { workspace, file, purpose: "engineering", codespace: "engineer-space",
    remoteRoot: "/workspaces/1JS", remoteTools: "/workspaces/.engineer-tools", minimumFreeGiB: 12,
    nativeProfile: { nodeExecutable: "/usr/bin/node" } };
  const snapshot = { root: config.remoteRoot, commit: "a".repeat(40), branch: "main", worktreeStatus: "" };
  const transport = { environment: async () => calls.push(["environment"]),
    initialize: async () => calls.push(["initialize"]), deploy: async () => calls.push(["deploy"]),
    dispose: async () => calls.push(["dispose"]),
    ssh: async (command, ...args) => {
      calls.push(["ssh", command, ...args]);
      return { stdout: command.includes("branch:git") ? JSON.stringify(snapshot) : "" };
    },
    native: async (operation, input) => {
      calls.push(["native", operation, input]);
      if (operation === "prepare") snapshot.branch = input.branch;
      return { ready: true, repoRoot: config.remoteRoot, commit: snapshot.commit, branch: snapshot.branch,
        ...(operation === "prepare" ? { buildWarmed: input.runBuild !== false } : {}) };
    } };
  const local = { id: "1js", tools: async () => [], call: async (...args) => {
    calls.push(["local", ...args]); return "unchanged";
  } };
  const adapter = withCodespaceWorkspaces(local, [file], { readConfig: () => config, transport: () => transport });
  const prepare = input => adapter.call("prepare", { repoRoot: workspace, operation: "branch", mode: "create",
    branch: "user/test/engineering", ...input });
  return { workspace, file, config, calls, snapshot, transport, local, adapter, prepare };
}

test("engineering preparation refuses unsupported operations before opening a transport", async t => {
  const f = fixture(t);
  const adapter = withCodespaceWorkspaces(f.local, [f.file], {
    readConfig: () => f.config,
    session: { codespace: f.config.codespace, root: f.config.remoteRoot, tools: f.config.remoteTools },
    transport: () => assert.fail("Invalid operations must not open a transport"),
  });
  await assert.rejects(adapter.call("prepare", { operation: "application" }), /Invalid operation/);
  assert.deepEqual(f.calls, []);
  await adapter.dispose();
});

test("large target merges stream their complete worktree fingerprint without buffering the monorepo status", async t => {
  const { EventEmitter } = await import("node:events");
  const { runInNewContext } = await import("node:vm");
  const f = fixture(t), chunk = Buffer.from("M  midgard/packages/target-change/src/file.ts\n".repeat(2000));
  const expected = createHash("sha256");
  let streamed = false;
  const transport = { ssh: command => new Promise((resolve, reject) => {
    const program = command.slice(command.indexOf(" -e ") + 4).slice(1, -1).replaceAll("'\\''", "'");
    const cp = {
      execFileSync: (_command, args) => {
        assert.ok(!args.includes("status"), "Worktree inventory must not use a bounded synchronous output buffer");
        return args.includes("--show-toplevel") ? f.config.remoteRoot
          : args.includes("HEAD") ? f.snapshot.commit : f.snapshot.branch;
      },
      spawn: () => {
        streamed = true;
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        queueMicrotask(() => {
          for (let count = 0; count < 24; count++) { expected.update(chunk); child.stdout.emit("data", chunk); }
          child.emit("close", 0);
        });
        return child;
      },
    };
    runInNewContext(program, { require: name => name === "node:child_process" ? cp
      : name === "node:fs" ? { realpathSync: () => f.config.remoteRoot } : { createHash },
      console: { log: stdout => resolve({ stdout }), error: reject }, process: {} });
  }) };
  const snapshot = await engineeringSnapshot(transport, f.config);
  assert.equal(streamed, true);
  assert.equal(snapshot.worktreeStatus, `sha256:${expected.digest("hex")}`);
  assert.equal(snapshot.commit, f.snapshot.commit);
});

test("review handoffs stage Linux artifacts and reuse the unchanged procedure and creator instructions", async t => {
  const f = fixture(t), payloads = [], role = "Original creator instructions.";
  const contract = withSpoolReviewTools({ prId: "42", submissionId: "submission", fingerprint: "feedback",
    responseMode: "pr_thread", cwd: f.workspace, repositoryConfigFile: path.join(f.workspace, "runner.json"),
    contractFile: path.join(f.workspace, "contract.json"), resultFile: path.join(f.workspace, "result.json"),
    creatorRoleFile: path.join(f.workspace, "creator.md") });
  f.transport.ssh = async (_command, _timeout, _log, payload) => { payloads.push(JSON.parse(payload)); };
  const staged = await stageCreatorReview({ repoRoot: f.workspace,
    execution: { codespace: f.config.codespace } }, contract, role, { config: f.config, transport: f.transport });
  const remote = JSON.parse(payloads[0][staged.remoteArtifacts.contractFile]);
  assert.equal(remote.cwd, "/workspaces/1JS");
  assert.equal(remote.completionInstructions, contract.completionInstructions);
  assert.equal(payloads[0][remote.creatorRoleFile], role);
  assert.ok(payloads[0][staged.remoteArtifacts.resolverFile].includes("repo_pr"));
  assert.doesNotMatch(remote.resolverCommands.answer, /--config|C:\\/);
  assert.ok(remote.resolverCommands.answer.includes(`"${staged.remoteArtifacts.resolverFile}"`));
  assert.equal(reviewPrompt(staged, "Existing review procedure.", { transport: "spool" }),
    `Existing review procedure.\n\nContinue this existing PR on its original task/session.\nRead "${remote.contractFile}" for the PR, branch, checkout, creator instructions, feedback, and completion details.\nSwitch branches.`);
  const result = { submissionId: contract.submissionId, fingerprint: contract.fingerprint, head: "a".repeat(40), findings: [] };
  f.transport.ssh = async () => ({ stdout: JSON.stringify(result) });
  await syncCreatorReview(staged, { config: f.config, transport: f.transport });
  assert.deepEqual(JSON.parse(fs.readFileSync(contract.resultFile)), result);
  f.transport.ssh = async () => ({ stdout: JSON.stringify({ ...result, fingerprint: "stale" }) });
  await assert.rejects(syncCreatorReview(staged, { config: f.config, transport: f.transport }), /different submission/);
  assert.deepEqual(JSON.parse(fs.readFileSync(contract.resultFile)), result);
  await assert.rejects(syncCreatorReview({ ...staged, remoteArtifacts: { ...staged.remoteArtifacts,
    resultFile: "/workspaces/other/result.json" } }, { config: f.config, transport: f.transport }), /assigned Codespace/);
});

for (const namespaced of process.platform === "win32" ? [false, true] : [false])
test(`review resolution binds the original active task and pushed-head guards (${namespaced ? "extended" : "ordinary"} paths)`, async t => {
  const f = fixture(t), root = path.join(f.workspace, "project"), records = path.join(root, ".runner-receipts");
  const key = "review-submission", taskId = "original-task", token = "fixture-token";
  const hash = createHash("sha256").update(key).digest("hex");
  const contextFile = path.join(records, "creator-contexts", `${taskId}.json`);
  const taskFile = path.join(root, "queues", "in_progress", `${taskId}.json`);
  const metadataFile = path.join(records, `task-${taskId}.json`);
  const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  const pr = { id: "42", sourceCommit: "b".repeat(40), sourceCommitDate: "2026-10-25T01:00:00Z",
    status: "active", branch: "user/test", author: "author@example.invalid" };
  const threads = [{ id: 21, status: "active", comments: [{ id: 1, commentType: "text",
    author: { uniqueName: "reviewer@example.invalid", displayName: "Reviewer" }, content: "Fix cursor.",
    publishedDate: "2026-10-24T00:00:00Z" }] }];
  const runnerConfig = { repositoryProfile: "1js", repository: "1JS", project: "Office", organization: "office",
    authorAccount: pr.author };
  const contract = { submissionId: key, fingerprint: "fingerprint", identifier: taskId, agent: "perf",
    cwd: f.workspace, prId: pr.id, branch: pr.branch, head: "a".repeat(40), responseMode: "pr_thread",
    replyPolicy: "when_needed", replyThreadIds: ["21"], at: "2026-10-25T00:00:00Z",
    resultFile: path.join(records, "results", `${hash}.json`), repositoryConfigFile: path.join(root, "runner.json"),
    findings: reviewFindings(threads, runnerConfig) };
  put(contextFile, { taskId, agent: "perf", sessionId: "original-session", providerToken: token,
    receiptDirectory: namespaced ? path.toNamespacedPath(path.join(records, "native-creators"))
      : path.join(records, "native-creators") });
  put(taskFile, { id: taskId, agent: "perf", session_id: "original-session", provider: { token },
    session_config: { provider: { command: "assigned-provider" } } });
  put(metadataFile, { runner: "pr-updater", key, contract });
  const environment = { BOHEMIA_CREATOR_CONTEXT: namespaced ? path.toNamespacedPath(contextFile) : contextFile, SPOOL_PROVIDER_TOKEN: token,
    REPOSITORY_CODESPACE_SESSION: JSON.stringify({ codespace: f.config.codespace, root: f.config.remoteRoot,
      tools: f.config.remoteTools }) };
  let writes = 0;
  const ado = { getPullRequest: async () => pr, listThreads: async () => threads,
    updateThreadStatus: async (_config, _pr, _thread, status) => { writes++; threads[0].status = status; } };
  const result = { submissionId: key, fingerprint: contract.fingerprint, head: pr.sourceCommit,
    findings: [{ threadId: "21", disposition: "fixed", evidence: "Cursor preserved.",
      verification: { command: "targeted regression", expected: "cursor retained", actual: "cursor retained" } }] };
  const input = { action: "review", pullRequestId: 42, submissionId: key, resolution: "answer", threadIds: ["21"], result };
  const deps = { environment, runnerConfig, ado };
  const refused = await resolveCreatorReview({ ...input, result: { ...result, head: "c".repeat(40) } }, f.config, deps);
  assert.equal(refused.ready, false);
  assert.equal(writes, 0);
  for (const change of [{ submissionId: "other" }, { pullRequestId: 43 }, { threadIds: ["999"] }])
    await assert.rejects(resolveCreatorReview({ ...input, ...change }, f.config, deps), /assignment|active original task/);
  await assert.rejects(resolveCreatorReview(input, f.config, { ...deps, environment: {
    ...environment, SPOOL_PROVIDER_TOKEN: "wrong-provider" } }), /task-bound review context/);
  await assert.rejects(resolveCreatorReview(input, { ...f.config, codespace: "another-vm" }, deps), /active original task/);
  assert.equal(writes, 0);
  const outcome = await resolveCreatorReview(input, f.config, deps);
  assert.equal(outcome.ready, true, outcome.reason);
  assert.deepEqual(outcome.resolved, ["21"]);
  assert.equal(writes, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(contract.resultFile)), result);
});

test("engineering repo_prepare forwards the registered remote root and records actual MCP readiness", async t => {
  const f = fixture(t), result = await f.prepare({ runBuild: false });
  assert.equal(result.structuredContent.repoRoot, f.workspace);
  assert.equal(result.structuredContent.execution.purpose, "engineering");
  assert.equal(result.structuredContent.buildWarmed, false);
  assert.equal(result.structuredContent.nativePreparation.repoRoot, "/workspaces/1JS");
  assert.deepEqual(f.calls.find(call => call[0] === "native"), ["native", "prepare", {
    repoRoot: "/workspaces/1JS", operation: "branch", mode: "create", branch: "user/test/engineering",
    runBuild: false, reset: true, minimumFreeGiB: 12,
  }]);
  assert.equal(f.calls.at(-1)[0], "dispose");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.workspace, "preparation.json"))).ready, true);
});
for (const mode of ["create", "checkout", undefined])
test(`fresh engineering ${mode || "default checkout"} discards leftover edits without a caller reset`, async t => {
  const f = fixture(t), native = f.transport.native;
  f.snapshot.worktreeStatus = "sha256:leftover-tracked-and-untracked-edits";
  f.transport.native = async (operation, input) => {
    if (input.reset) f.snapshot.worktreeStatus = "";
    else throw new Error("Checkout is dirty");
    return native(operation, input);
  };
  const result = await f.adapter.call("prepare", { repoRoot: f.workspace, branch: "user/test/new-task",
    reset: false, ...(mode ? { operation: "branch", mode } : {}) });
  assert.equal(result.structuredContent.ready, true);
  assert.equal(result.structuredContent.worktreeStatus, "");
  assert.equal(f.calls.find(call => call[0] === "native")[2].reset, true);
});
for (const input of [{ mode: "resume" }, { operation: "setup" }, { operation: "master" }])
test(`engineering ${input.operation || input.mode} does not discard existing work`, async t => {
  const f = fixture(t);
  f.snapshot.worktreeStatus = "sha256:unfinished-work";
  const result = await f.prepare({ ...input, reset: false });
  assert.equal(f.calls.find(call => call[0] === "native")[2].reset, false);
  assert.equal(result.structuredContent.worktreeStatus, "sha256:unfinished-work");
});
test("verified warm engineering preparation skips deployment and native setup but records fresh readiness", async t => {
  const f = fixture(t);
  f.transport.reusePreparation = async input => {
    f.calls.push(["reuse", input]);
    return { ready: true, cached: true, buildWarmed: true, repoRoot: f.config.remoteRoot,
      commit: f.snapshot.commit, branch: f.snapshot.branch };
  };
  const response = await f.prepare();
  assert.equal(response.structuredContent.cached, true);
  assert.equal(response.structuredContent.nativePreparation.cached, true);
  assert.deepEqual(f.calls.map(call => call[0]), ["initialize", "reuse", "dispose"]);
  const saved = JSON.parse(fs.readFileSync(path.join(f.workspace, "preparation.json")));
  assert.equal(saved.ready, true);
  assert.equal(saved.worktreeStatus, "");
  assert.equal(saved.execution.codespace, f.config.codespace);
  await verifyEngineeringCodespace(saved, { config: f.config, transport: f.transport });
  f.snapshot.commit = "b".repeat(40);
  await assert.rejects(verifyEngineeringCodespace(saved, { config: f.config, transport: f.transport }),
    /revision changed/);
});
test("cache misses run canonical preparation and malformed cached readiness is refused", async t => {
  const f = fixture(t);
  f.transport.reusePreparation = async () => null;
  await f.prepare();
  assert.ok(f.calls.some(call => call[0] === "native"));
  f.transport.reusePreparation = async () => ({ ready: true, cached: true, buildWarmed: false,
    repoRoot: f.config.remoteRoot, commit: f.snapshot.commit, branch: f.snapshot.branch });
  await assert.rejects(f.prepare(), /Cached Codespace preparation/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.workspace, "preparation.json"))).ready, false);
});
test("a committed conflict repair refreshes stock dependencies once per revision before final checks", async t => {
  const f = fixture(t);
  await f.prepare();
  const file = path.join(f.workspace, "preparation.json"), prepared = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...prepared, merge: { conflicted: true, setupBeforeMerge: true } }));
  f.snapshot.commit = "b".repeat(40);
  let setups = 0, checks = 0, fail = false;
  f.transport.native = async (operation, input) => {
    if (operation === "prepare") {
      setups++;
      assert.equal(input.operation, "setup");
      assert.equal(input.runBuild, false);
      if (fail) throw new Error("Stock dependency refresh failed");
    } else checks++;
    return { ready: true, repoRoot: f.config.remoteRoot, branch: f.snapshot.branch, commit: f.snapshot.commit };
  };
  await f.adapter.call("check", { repoRoot: f.workspace });
  await f.adapter.call("check", { repoRoot: f.workspace });
  assert.equal(setups, 1);
  assert.equal(checks, 2);
  f.snapshot.commit = "c".repeat(40);
  fail = true;
  await assert.rejects(f.adapter.call("check", { repoRoot: f.workspace }), /Stock dependency refresh failed/);
  assert.equal(checks, 2);
  assert.equal(JSON.parse(fs.readFileSync(file)).conflictDependencies.commit, "b".repeat(40));
});

test("a clean automatic merge refreshes dependencies even before another authored commit", async t => {
  const f = fixture(t);
  await f.prepare();
  const file = path.join(f.workspace, "preparation.json"), prepared = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...prepared, merge: { conflicted: false, setupBeforeMerge: true } }));
  f.transport.native = async (operation, input) => {
    f.calls.push(["native", operation, input]);
    return { ready: true, repoRoot: f.config.remoteRoot, branch: f.snapshot.branch, commit: f.snapshot.commit };
  };
  await f.adapter.call("check", { repoRoot: f.workspace });
  assert.deepEqual(f.calls.filter(call => call[0] === "native").map(call => call[1]),
    ["prepare", "prepare", "check"]);
  assert.equal(JSON.parse(fs.readFileSync(file)).conflictDependencies.commit, prepared.commit);
});

test("resuming a conflict after a refused prepare still refreshes committed dependencies before a scoped build", async t => {
  const f = fixture(t);
  await f.prepare();
  f.transport.native = async () => { throw new Error("Interrupted merge requires explicit conflict resume"); };
  await assert.rejects(f.prepare({ mode: "resume" }), /explicit conflict resume/);
  f.transport.native = async () => ({ ready: true, repoRoot: f.config.remoteRoot,
    commit: f.snapshot.commit, branch: f.snapshot.branch, merge: { merged: true, conflicted: true, resumed: true } });
  await f.prepare({ mode: "resume", mergeMaster: true, allowConflicts: true });
  f.snapshot.commit = "b".repeat(40);
  let setups = 0, builds = 0;
  f.transport.native = async (operation, input) => {
    if (operation === "prepare") {
      setups++;
      assert.equal(input.operation, "setup");
      assert.deepEqual(input.packages, ["@1js/library-module-data-pages"]);
    } else builds++;
    return { ready: true, repoRoot: f.config.remoteRoot, commit: f.snapshot.commit, branch: f.snapshot.branch };
  };
  await f.adapter.call("build", { repoRoot: f.workspace, packages: ["@1js/library-module-data-pages"] });
  await f.adapter.call("check", { repoRoot: f.workspace });
  assert.equal(setups, 1);
  assert.equal(builds, 2);
});

test("staged conflict resolution does not refresh stock dependencies before its merge commit exists", async t => {
  const f = fixture(t);
  await f.prepare();
  f.transport.native = async () => ({ ready: true, repoRoot: f.config.remoteRoot,
    commit: f.snapshot.commit, branch: f.snapshot.branch,
    merge: { merged: true, conflicted: false, resumed: true } });
  await f.prepare({ mode: "resume", mergeMaster: true, allowConflicts: true });
  f.transport.native = async (operation, input) => {
    assert.equal(operation, "build", "An uncommitted resumed merge must not run stock setup");
    return { ready: true, repoRoot: f.config.remoteRoot, commit: f.snapshot.commit, branch: f.snapshot.branch };
  };
  await f.adapter.call("build", { repoRoot: f.workspace });
});

test("local operations keep their original input, context and output", async t => {
  const f = fixture(t), input = Object.freeze({ repoRoot: os.tmpdir(), action: "create" }), context = {};
  assert.equal(await f.adapter.call("pr", input, context), "unchanged");
  assert.equal(f.calls[0][2], input);
  assert.equal(f.calls[0][3], context);
});

test("native agent tools default to their assigned source root without exposing host control paths", async t => {
  const f = fixture(t);
  const session = { codespace: f.config.codespace, root: f.config.remoteRoot, tools: f.config.remoteTools };
  const schema = { required: ["repoRoot"], properties: { repoRoot: { type: "string" } } };
  f.local.tools = async () => [{ operation: "check", inputSchema: schema },
    { operation: "prepare", description: "Prepare repository.", inputSchema: schema }];
  const adapter = withCodespaceWorkspaces(f.local, [f.file], {
    readConfig: () => f.config, transport: () => f.transport, session,
  });
  const tools = await adapter.tools();
  assert.deepEqual(tools[0].inputSchema.required, []);
  assert.match(tools[0].inputSchema.properties.repoRoot.description, /\/workspaces\/1JS/);
  assert.deepEqual(schema.required, ["repoRoot"]);
  assert.equal(tools[1].description, "Prepare repository.");
  await f.prepare();
  await adapter.call("check", {});
  await adapter.call("check", { repoRoot: f.config.remoteRoot });
  for (const repoRoot of [f.workspace, "/outside/another-repo"])
    await assert.rejects(adapter.call("check", { repoRoot }), /another workspace/);
  assert.throws(() => withCodespaceWorkspaces(f.local, [f.file], {
    readConfig: () => f.config, session: { ...session, codespace: "another-vm" },
  }), /no matching/);
});

test("normal command identity guards do not scan the entire monorepo while preparation retains its dirty snapshot", async t => {
  const f = fixture(t);
  await f.prepare();
  assert.equal(f.calls.filter(call => call[0] === "ssh" && call[1].includes("worktreeStatus")).length, 1);
  f.calls.length = 0;
  await f.adapter.call("check", { repoRoot: f.workspace });
  assert.equal(f.calls.filter(call => call[0] === "ssh" && call[1].includes("worktreeStatus")).length, 0);
});

test("native reviewers route assigned-root callbacks through the read-only reviewer adapter", async t => {
  const f = fixture(t);
  const review = { ...f.config, purpose: "review", codespace: "review-space",
    remoteTools: "/workspaces/.review-tools" };
  f.local.tools = async () => [{ operation: "prepare", description: "Prepare review.",
    inputSchema: { required: ["repoRoot"], properties: { repoRoot: {} } } }];
  const adapter = withCodespaceWorkspaces(f.local, [], {
    readConfig: () => review, reviewFile: f.file,
    session: { codespace: review.codespace, root: review.remoteRoot, tools: review.remoteTools },
  });
  assert.equal((await adapter.tools())[0].description, "Prepare review.");
  assert.equal(await adapter.call("check", {}), "unchanged");
  assert.equal(f.calls.at(-1)[2].repoRoot, review.workspace);
  await assert.rejects(adapter.call("check", { repoRoot: "/workspaces/other" }), /another workspace/);
  assert.equal(f.calls.filter(call => call[0] === "initialize").length, 0);
});
test("engineering checks support legitimate edits and commits on the prepared branch", async t => {
  const f = fixture(t);
  await f.prepare();
  f.snapshot.commit = "b".repeat(40);
  f.snapshot.worktreeStatus = "M source.ts";
  const result = await f.adapter.call("check", { repoRoot: f.workspace });
  assert.equal(result.structuredContent.commit, "b".repeat(40));
  await assert.rejects(verifyEngineeringCodespace(JSON.parse(fs.readFileSync(path.join(f.workspace, "preparation.json"))),
    { config: f.config, transport: f.transport }), /revision changed/);
  await verifyEngineeringCodespace(JSON.parse(fs.readFileSync(path.join(f.workspace, "preparation.json"))),
    { config: f.config, transport: f.transport, allowWork: true });
});
test("a failed check keeps the branch preparation available for repair and records its error", async t => {
  const f = fixture(t);
  await f.prepare();
  f.transport.native = async () => { throw new Error("Typecheck failed"); };
  await assert.rejects(f.adapter.call("check", { repoRoot: f.workspace }), /Typecheck failed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.workspace, "preparation.json"))).ready, true);
  assert.match(fs.readFileSync(path.join(f.workspace, "check-failure.json"), "utf8"), /Typecheck failed/);
  assert.equal(f.calls.at(-1)[0], "dispose");
});
test("engineering handoffs may preserve authored files but still pin their original commit", async t => {
  const f = fixture(t);
  await f.prepare();
  const prepared = JSON.parse(fs.readFileSync(path.join(f.workspace, "preparation.json")));
  f.snapshot.worktreeStatus = "M authored.ts";
  await verifyEngineeringCodespace(prepared, { config: f.config, transport: f.transport, allowDirty: true });
  await assert.rejects(verifyEngineeringCodespace(prepared, { config: f.config, transport: f.transport }), /revision changed/);
  f.snapshot.commit = "b".repeat(40);
  await assert.rejects(verifyEngineeringCodespace(prepared,
    { config: f.config, transport: f.transport, allowDirty: true }), /revision changed/);
});
test("a failed preparation cannot leave an earlier successful receipt", async t => {
  const f = fixture(t);
  await f.prepare();
  f.transport.native = async () => { throw new Error("CI artifact missing"); };
  await assert.rejects(f.prepare(), /CI artifact missing/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.workspace, "preparation.json"))).ready, false);
});
test("unexpected branches are rejected before checks or publication", async t => {
  const f = fixture(t);
  await f.prepare();
  f.snapshot.branch = "somebody-elses-work";
  const before = f.calls.filter(call => call[0] === "native").length;
  await assert.rejects(f.adapter.call("check", { repoRoot: f.workspace }), /prepared branch/);
  assert.equal(f.calls.filter(call => call[0] === "native").length, before);
});
test("head changes during validation and changing configuration invalidate results", async t => {
  for (const change of ["head", "config"]) {
    const f = fixture(t);
    await f.prepare();
    f.transport.native = async () => {
      if (change === "head") f.snapshot.commit = "b".repeat(40);
      else fs.writeFileSync(f.file, '{"changed":true}');
      return { ready: true, repoRoot: f.config.remoteRoot, commit: "a".repeat(40) };
    };
    await assert.rejects(f.adapter.call("check", { repoRoot: f.workspace }), /changed/);
  }
});
test("writable VMs and control roots cannot alias each other or the reviewer", t => {
  const f = fixture(t);
  assert.throws(() => withCodespaceWorkspaces(f.local, [f.file, f.file], { readConfig: () => f.config }), /unique/);
  assert.throws(() => withCodespaceWorkspaces(f.local, [f.file],
    { readConfig: () => f.config, reviewFile: "review" }), /separate/);
});
test("publication uses the same native gate, stages host images deterministically and notifies on the host", async t => {
  const f = fixture(t);
  const notified = [];
  const adapter = withCodespaceWorkspaces(f.local, [f.file], { readConfig: () => f.config, transport: () => f.transport,
    notify: async input => { notified.push(input); return "sent"; } });
  await f.prepare();
  const image = path.join(f.workspace, "proof.png");
  fs.writeFileSync(image, "fixture-image");
  const input = { repoRoot: f.workspace, action: "create", sourceBranch: f.snapshot.branch,
    category: "fix", title: "Retain selection", problem: "Selection resets.",
    solution: `Preserve selection.\n![proof](${image})`, validation: "Focused checks passed.", uiChange: true };
  f.transport.native = async (operation, request) => {
    f.calls.push(["native", operation, request]);
    assert.equal(operation, "pr");
    assert.match(request.solution, /\/workspaces\/.engineer-tools\/publication-assets\/[a-f0-9]{64}\.png/);
    return { ready: true, repoRoot: f.config.remoteRoot, commit: f.snapshot.commit, pullRequestId: 42, title: "Retain selection",
      url: "https://example.invalid/pr/42", notification: { deferred: true } };
  };
  const first = await adapter.call("pr", input), second = await adapter.call("pr", input);
  assert.equal(first.structuredContent.notification, "sent");
  assert.equal(second.structuredContent.notification, "sent");
  assert.equal(notified.length, 2);
  const requests = f.calls.filter(call => call[0] === "native" && call[1] === "pr");
  assert.equal(requests[0][2].solution, requests[1][2].solution);
});
test("invalid PR prose is rejected before connecting to the Codespace", async t => {
  const f = fixture(t);
  await assert.rejects(f.adapter.call("pr", { repoRoot: f.workspace, category: "fix", title: "Retain selection",
    problem: "Selection resets.", solution: "Preserve selection", validation: "Checks passed.", uiChange: false }),
  /solution must end with a full stop/);
  assert.equal(f.calls.length, 0);
});
test("publication verifies reviewers through owned auth before publishing and returns assigned evidence", async t => {
  const f = fixture(t), events = [], reviewer = { id: "11111111-1111-4111-8111-111111111111", name: "Reviewer" };
  await f.prepare();
  const pr = { pullRequestId: 42, status: "active", sourceRefName: `refs/heads/${f.snapshot.branch}`, reviewers: [] };
  f.transport.reviewAccessToken = async () => "owned-authentication";
  f.transport.native = async operation => {
    events.push(operation);
    return { ready: true, repoRoot: f.config.remoteRoot, commit: f.snapshot.commit, pullRequestId: 42,
      url: "https://example.invalid/pr/42" };
  };
  const adapter = withCodespaceWorkspaces(f.local, [f.file], { readConfig: () => f.config,
    transport: () => f.transport,
    reviewerPolicy: () => ({ organization: "https://dev.azure.com/office", project: "Office",
      repository: "1JS", reviewers: [reviewer] }),
    reviewerRequest: async (url, options) => {
      assert.equal(options.token, "owned-authentication");
      if (url.includes("vssps.dev.azure.com")) {
        events.push("identity");
        return { value: [{ id: reviewer.id, providerDisplayName: reviewer.name, isActive: true }] };
      }
      if (options.method === "PUT") {
        assert.deepEqual(options.body, { id: reviewer.id });
        pr.reviewers.push({ id: reviewer.id, vote: 0 });
      }
      return url.includes("/refs?") ? { value: [{ name: pr.sourceRefName, objectId: f.snapshot.commit }] } : pr;
    } });
  const result = await adapter.call("pr", { repoRoot: f.workspace, pullRequestId: 42, category: "fix",
    title: "Retain selection", problem: "Selection resets.", solution: "Preserve selection.",
    validation: "Focused checks passed.", uiChange: false });
  assert.deepEqual(events, ["identity", "pr", "identity"]);
  assert.equal(result.structuredContent.reviewerSetup.ready, true);
  assert.equal(result.structuredContent.reviewerSetup.identities[0].isActive, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.workspace, "pr.json"))).reviewerSetup.ready, true);
});
test("identity failure prevents publication and post-publication failures retain the existing PR", async t => {
  const f = fixture(t), reviewer = { id: "11111111-1111-4111-8111-111111111111", name: "Reviewer" };
  await f.prepare();
  let published = 0, active = false;
  f.transport.reviewAccessToken = async () => "owned-authentication";
  f.transport.native = async () => {
    published++;
    return { ready: true, repoRoot: f.config.remoteRoot, commit: f.snapshot.commit, pullRequestId: 42,
      url: "https://example.invalid/pr/42" };
  };
  const adapter = withCodespaceWorkspaces(f.local, [f.file], { readConfig: () => f.config,
    transport: () => f.transport, reviewerPolicy: () => ({ organization: "https://dev.azure.com/office",
      project: "Office", repository: "1JS", reviewers: [reviewer] }),
    reviewerRequest: async url => {
      if (url.includes("vssps.dev.azure.com"))
        return { value: [{ id: reviewer.id, providerDisplayName: reviewer.name, isActive: active }] };
      throw new Error("Temporary reviewer readback unavailable");
    } });
  const input = { repoRoot: f.workspace, pullRequestId: 42, category: "fix", title: "Retain selection",
    problem: "Selection resets.", solution: "Preserve selection.", validation: "Focused checks passed.", uiChange: false };
  await assert.rejects(adapter.call("pr", input), error => error.stage === "reviewer_identity");
  assert.equal(published, 0);
  active = true;
  await assert.rejects(adapter.call("pr", input), error => {
    assert.equal(error.stage, "reviewer_setup");
    assert.deepEqual(error.publication, { published: true, pullRequestId: 42,
      url: "https://example.invalid/pr/42", commit: f.snapshot.commit });
    assert.match(error.nextAction, /already published/);
    return true;
  });
  assert.equal(published, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.workspace, "pr.json")));
  assert.equal(receipt.ready, false);
  assert.equal(receipt.pullRequestId, 42);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.workspace, "pr-failure.json"))).publication.published, true);
});
test("retired runtime and admission operations cannot reach the remote transport", async t => {
  const f = fixture(t);
  for (const operation of ["start", "add_packages"])
    await assert.rejects(f.adapter.call(operation, { repoRoot: f.workspace }), /Unsupported repository operation/);
  assert.equal(f.calls.length, 0);
});
test("engineering configuration is explicit and rejects unsupported settings", t => {
  const f = fixture(t), config = { version: 1, purpose: "engineering", codespace: "engineer-space",
    githubAccount: "fixture", connector: process.execPath, nodeExecutable: process.execPath,
    azureCliDirectory: path.dirname(process.execPath), workspace: f.workspace, remoteRoot: "/workspaces/1JS",
    remoteTools: "/workspaces/.tools", minimumFreeGiB: 12,
    nativeProfile: { repoRoot: "/workspaces/1JS", toolchainRoot: "/workspaces/1JS", storageRoot: "/workspaces",
      nodeExecutable: "/usr/bin/node", baseBranch: "main" } };
  fs.writeFileSync(f.file, JSON.stringify(config));
  assert.equal(readCodespaceConfig(f.file).purpose, "engineering");
  for (const nativeProfile of [
    { ...config.nativeProfile, processBudget: "process-group" },
    { ...config.nativeProfile, ciBaseline: true },
  ]) {
    fs.writeFileSync(f.file, JSON.stringify({ ...config, nativeProfile }));
    assert.throws(() => readCodespaceConfig(f.file), /Obsolete local setup/);
  }
  fs.writeFileSync(f.file, JSON.stringify({ ...config, runtime: { kind: "package" } }));
  assert.throws(() => readCodespaceConfig(f.file), /Invalid Codespace reviewer configuration/);
});
