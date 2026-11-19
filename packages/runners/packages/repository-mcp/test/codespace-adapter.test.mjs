import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { withCodespaceReviewer } from "../src/codespaces/adapter.mjs";

function fixture(t, overrides = {}) {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "codespace-adapter-")));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const commit = "a".repeat(40), calls = [];
  const prepared = { ready: true, status: "ready", commit, leaseToken: "a".repeat(36),
    comparison: { files: ["midgard/packages/review-target/src/index.ts"] } };
  fs.writeFileSync(path.join(workspace, "preparation.json"), JSON.stringify(prepared));
  const local = { id: "1js", tools: async () => [{ operation: "check" }],
    call: async (...args) => { calls.push(["local", ...args]); return "original-result"; } };
  const transport = { environment: async () => calls.push(["environment"]),
    native: async (...args) => { calls.push(["native", ...args]); return { ready: true, commit }; } };
  const adapter = withCodespaceReviewer(local, "fixture", {
    readConfig: () => ({ workspace, remoteRoot: "/workspaces/1JS", remoteTools: "/workspaces/.tools" }),
    verify: async value => { assert.equal(value.commit, commit); calls.push(["verify"]); },
    transport, ...overrides,
  });
  return { adapter, calls, workspace, transport, prepared };
}

test("remote MCP build/check use the native scoped adapter and verify both sides of execution", async t => {
  const f = fixture(t);
  for (const operation of ["build", "check"]) {
    const result = await f.adapter.call(operation, { repoRoot: f.workspace });
    assert.equal(result.structuredContent.commit, f.prepared.commit);
  }
  assert.deepEqual(f.calls.map(call => call[0]), [
    "verify", "environment", "native", "verify", "verify", "environment", "native", "verify",
  ]);
  assert.deepEqual(f.calls.filter(call => call[0] === "native").map(call => call.slice(1)), [
    ["build", { repoRoot: "/workspaces/1JS" }, f.prepared.comparison.files],
    ["check", { repoRoot: "/workspaces/1JS" }, f.prepared.comparison.files],
  ]);
  assert.equal(f.transport.azureAuthFile, "/workspaces/.tools/azure-auth.json");
  assert.equal(f.transport.leaseToken, f.prepared.leaseToken);
});
test("registered reviewer workspaces accept Windows path casing changes", {
  skip: process.platform !== "win32",
}, async t => {
  const f = fixture(t);
  const result = await f.adapter.call("check", { repoRoot: f.workspace.toLowerCase() });
  assert.equal(result.structuredContent.ready, true);
  assert.deepEqual(f.calls.map(([kind]) => kind), ["verify", "environment", "native", "verify"]);
});

test("local Library operations retain their original input, context and result", async t => {
  const f = fixture(t), input = { repoRoot: os.tmpdir(), action: "create" }, context = { progressToken: "fixture" };
  assert.equal(await f.adapter.call("pr", input, context), "original-result");
  assert.equal(f.calls[0][2], input);
  assert.equal(f.calls[0][3], context);
});
test("remote reviewer cannot expand scope, replace runtime or publish", async t => {
  const f = fixture(t);
  for (const operation of ["pr"])
    await assert.rejects(f.adapter.call(operation, { repoRoot: f.workspace }), /runner owns/);
  assert.deepEqual(f.calls, []);
});
test("reviewer preparation refuses unsupported operations before creating a session", async t => {
  const f = fixture(t, { Session: class { constructor() { assert.fail("No session should be created"); } } });
  await assert.rejects(f.adapter.call("prepare", { repoRoot: f.workspace, operation: "application" }),
    /Invalid operation/);
  assert.deepEqual(f.calls, []);
  await f.adapter.dispose();
});
test("reviewer repo_prepare uses the exact queued PR and retains its owned lifecycle until disposal", async t => {
  const calls = [];
  class Session {
    async prepare(input) { calls.push(input); return { ready: true, commit: "a".repeat(40) }; }
    async dispose() { calls.push("dispose"); }
  }
  const f = fixture(t, { Session });
  const input = { repoRoot: f.workspace, operation: "branch", mode: "checkout", reviewPullRequestId: 42,
    sourceCommit: "a".repeat(40), branch: "review/pr-42-aaaaaaaaaaaa", reset: false, mergeMaster: false };
  await assert.rejects(f.adapter.call("prepare", input), /owned MCP lifecycle/);
  const result = await f.adapter.call("prepare", input, { codespaceLifecycle: true });
  assert.equal(result.structuredContent.ready, true);
  assert.deepEqual(calls, [{ prId: 42, sourceCommit: "a".repeat(40), repoRoot: f.workspace }]);
  await assert.rejects(f.adapter.call("prepare", input, { codespaceLifecycle: true }), /already owns/);
  await f.adapter.dispose();
  assert.equal(calls.at(-1), "dispose");
});
test("reviewer preparation cannot skip setup/build, reset source or substitute a branch", async t => {
  const f = fixture(t, { Session: class { constructor() { assert.fail("Invalid prepare cannot start a session"); } } });
  const input = { repoRoot: f.workspace, operation: "branch", mode: "checkout", reviewPullRequestId: 42,
    sourceCommit: "a".repeat(40), branch: "review/pr-42-aaaaaaaaaaaa" };
  for (const override of [{ reset: true }, { runBuild: false }, { runSetup: false },
    { mergeMaster: true }, { mode: "create" }, { branch: "another-branch" }, { reviewPullRequestId: -1 }])
    await assert.rejects(f.adapter.call("prepare", { ...input, ...override }, { codespaceLifecycle: true }));
});

test("reviewer lifecycle reports unexpected owned exits but not intentional disposal", async t => {
  const child = new EventEmitter(), failures = [];
  class Session {
    transport = { children: new Set([child]) };
    async prepare() { return { ready: true, commit: "a".repeat(40) }; }
    async dispose() { child.emit("exit", 0); }
  }
  const f = fixture(t, { Session });
  await f.adapter.call("prepare", { repoRoot: f.workspace, operation: "branch", mode: "checkout",
    reviewPullRequestId: 42, sourceCommit: "a".repeat(40), branch: "review/pr-42-aaaaaaaaaaaa" },
  { codespaceLifecycle: true, onLifecycleFailure: message => failures.push(message) });
  child.emit("exit", 1);
  assert.deepEqual(failures, ["Owned Codespace connection/runtime exited"]);
  await f.adapter.dispose();
  assert.equal(failures.length, 1);
});
test("unverified remote state cannot run commands", async t => {
  const f = fixture(t, { verify: async () => { throw new Error("Owner is gone"); } });
  await assert.rejects(f.adapter.call("check", { repoRoot: f.workspace }), /Owner is gone/);
  assert.deepEqual(f.calls, []);
});
test("failed checks remain failures without discarding ownership or preventing setup repair", async t => {
  for (const mismatch of [false, true]) {
    const f = fixture(t);
    f.transport.native = async () => {
      if (!mismatch) throw new Error("Scoped check failed");
      return { ready: true, commit: "b".repeat(40) };
    };
    await assert.rejects(f.adapter.call("check", { repoRoot: f.workspace }));
    const saved = JSON.parse(fs.readFileSync(path.join(f.workspace, "preparation.json"), "utf8"));
    assert.equal(saved.ready, true);
    assert.equal(saved.status, "ready");
    f.transport.native = async () => ({ ready: true, commit: f.prepared.commit });
    const repaired = await f.adapter.call("prepare", { repoRoot: f.workspace, operation: "setup" });
    assert.equal(repaired.structuredContent.ready, true);
  }
});
