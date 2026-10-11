import test from "node:test";
import assert from "node:assert/strict";
import { formatAgentBranch, slugifyBranchTopic, setupAgentBranch } from "../src/branch-setup.js";

test("branch formatting preserves the established user namespace", () => {
  assert.equal(slugifyBranchTopic("Doc Cleanup: New Office!"), "doc-cleanup-new-office");
  assert.equal(formatAgentBranch("custom-fix", "testuser"), "user/testuser/custom-fix");
  assert.equal(formatAgentBranch("user/calebzearing/existing"), "user/calebzearing/existing");
});

test("automatic branch preparation calls the shared MCP once with setup enabled", async () => {
  const calls = [];
  const result = await setupAgentBranch({
    repoRoot: "C:\\fixture", branch: "docs-cleanup",
    call: async (name, args) => {
      calls.push({ name, args });
      return { ready: true, branch: args.branch, commit: "a".repeat(40), repoRoot: args.repoRoot };
    },
  });
  assert.equal(result.branch, "user/calebzearing/docs-cleanup");
  assert.deepEqual(calls, [{ name: "bohemia_prepare", args: {
    repoRoot: "C:\\fixture", operation: "branch", branch: result.branch, baseBranch: "master",
    mode: "create", reset: false, runSetup: true, runBuild: true,
  } }]);
});

test("MCP preparation failure and missing readiness fail closed", async () => {
  await assert.rejects(setupAgentBranch({ repoRoot: "C:\\fixture", branch: "x", call: async () => { throw new Error("install failed"); } }), /install failed/);
  await assert.rejects(setupAgentBranch({ repoRoot: "C:\\fixture", branch: "x", call: async () => ({}) }), /did not confirm/);
});

test("evidence-bound preparation pins the source through canonical exact-revision checkout", async () => {
  const sourceCommit = "a".repeat(40);
  const call = async (name, args) => {
    assert.equal(name, "bohemia_prepare");
    assert.equal(args.sourceCommit, sourceCommit);
    assert.equal(args.mode, "checkout");
    assert.equal(args.mergeMaster, false);
    assert.equal(args.reset, false);
    assert.equal(args.runSetup, true);
    return { ready: true, branch: args.branch, commit: sourceCommit, repoRoot: args.repoRoot };
  };
  const result = await setupAgentBranch({ repoRoot: "C:\\fixture", branch: "perf-proof", sourceCommit, call });
  assert.equal(result.commit, sourceCommit);
  await assert.rejects(setupAgentBranch({ repoRoot: "C:\\fixture", branch: "perf-proof", sourceCommit,
    call: async (name, args) => ({ ...await call(name, args), commit: "b".repeat(40) }) }),
  /requested source revision/);
});
