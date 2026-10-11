import assert from "node:assert/strict";
import test from "node:test";
import { prepareReviewWorkspace, reviewBranchName } from "../lib/workspace.mjs";

const commit = "98b79d216af33923607780a99f704e7ce44e4035";
test("review branch naming requires an exact revision", () => {
  assert.equal(reviewBranchName(5633200, commit), "review/pr-5633200-98b79d2");
  assert.equal(reviewBranchName("5633200", commit), "review/pr-5633200-98b79d2");
  for (const invalid of ["", "1.2", "1e3", "../123", "9007199254740993"]) {
    assert.throws(() => reviewBranchName(invalid, commit), /valid PR id/);
  }
  assert.throws(() => reviewBranchName(1, "short"), /exact/);
});

test("reviewer uses shared preparation pinned to the PR SHA without reset or merge", async () => {
  const calls = [];
  const result = await prepareReviewWorkspace({
    repoRoot: "C:\\fixture", prId: 1, sourceCommit: commit,
    call: async (name, args) => {
      calls.push({ name, args });
      return { ready: true, repoRoot: args.repoRoot, branch: args.branch, commit };
    },
  });
  assert.equal(result.sourceCommit, commit);
  assert.deepEqual(calls, [{ name: "bohemia_prepare", args: {
    repoRoot: "C:\\fixture", operation: "branch", mode: "checkout", branch: "review/pr-1-98b79d2",
    sourceCommit: commit, reset: false, mergeMaster: false, runSetup: true, runBuild: false,
  } }]);
});

test("preparation failures, missing readiness and wrong SHA never pass review admission", async () => {
  for (const message of ["dirty workspace", "LFS authentication failed", "dependency installation failed"]) {
    await assert.rejects(prepareReviewWorkspace({
      repoRoot: "C:\\fixture", prId: 1, sourceCommit: commit,
      call: async () => { throw new Error(message); },
    }), new RegExp(message));
  }
  await assert.rejects(prepareReviewWorkspace({
    repoRoot: "C:\\fixture", prId: 1, sourceCommit: commit,
    call: async () => ({ ready: true, branch: "review/pr-1-98b79d2", commit: "a".repeat(40) }),
  }), /exact requested revision/);
});
test("dependency-blocked retries rebuild only the changed package graph through the canonical tool", async () => {
  const calls = [], packages = ["@fluidx/anchored-nudges"];
  const result = await prepareReviewWorkspace({
    repoRoot: "C:\\fixture", prId: 1, sourceCommit: commit, repairDependencies: true,
    selectPackages: () => packages, call: async (name, args) => {
      calls.push({ name, args });
      return { ready: true, repoRoot: args.repoRoot, branch: "review/pr-1-98b79d2", commit };
    },
  });
  assert.equal(calls[0].args.runBuild, false, "ordinary checkout preparation remains lightweight");
  assert.deepEqual(calls[1], { name: "bohemia_build", args: { repoRoot: "C:\\fixture", packages, prepareTests: true } });
  assert.deepEqual(result.dependencyRepair, { packages });
});
test("failed or mismatched repair cannot release a review continuation", async () => {
  for (const mode of ["failure", "wrong-revision"]) {
    await assert.rejects(prepareReviewWorkspace({
      repoRoot: "C:\\fixture", prId: 1, sourceCommit: commit, repairDependencies: true, selectPackages: () => ["fixture"],
      call: async (name, args) => {
        if (name === "bohemia_build" && mode === "failure") throw new Error("build failed");
        return { ready: true, repoRoot: args.repoRoot, branch: "review/pr-1-98b79d2",
          commit: name === "bohemia_build" ? "b".repeat(40) : commit };
      },
    }), mode === "failure" ? /build failed/ : /exact requested revision/);
  }
});
