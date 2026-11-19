import assert from "node:assert/strict";
import test from "node:test";
import { repositoryCall } from "../repository-call.mjs";
import { codespaceReviewer } from "../codespace-reviewer.mjs";
import { withWslAdo } from "../../scanners/lib/wsl-ado.mjs";
import { libraryShellOperation } from "../../packages/bohemia-pr-mcp/src/repository-command-guard.ts";

test("the packaged repository guard preserves MCP-only setup and publishing", () => {
  const profile = { repoRoot: "C:\\agents\\library", wsl: { distribution: "fixture-linux", repoRoot: "/home/dev/library" } };
  assert.equal(libraryShellOperation("yarn build", profile.repoRoot, profile), true);
  assert.equal(libraryShellOperation('wsl -d fixture-linux --exec bash -lc "yarn build"', "C:\\other", profile), true);
  assert.equal(libraryShellOperation("git status", profile.repoRoot, profile), false);
  assert.equal(libraryShellOperation("yarn build", "C:\\other", profile), false);
});

test("Bohemia keeps its existing repository helper and 1JS uses the shared verified MCP", async () => {
  const bohemia = () => {}, calls = [];
  assert.equal(repositoryCall({}, { bohemia }), bohemia);
  const call = repositoryCall({ repositoryProfile: "1js", repositoryMcpConfig: "fixture.json" }, {
    repository: async (...args) => { calls.push(args); return { structuredContent: { ready: true, commit: "a".repeat(40) } }; },
  });
  assert.equal((await call("bohemia_prepare", { operation: "pr" })).ready, true);
  assert.equal(calls[0][0], "prepare");
  assert.equal(calls[0][1], "1js");
  assert.equal(calls[0][3].env.REPOSITORY_MCP_CONFIG, "fixture.json");
  await assert.rejects(call("bohemia_pr", {}), /only request repository preparation/);
  const invalid = repositoryCall({ repositoryProfile: "1js" }, { repository: async () => ({ structuredContent: { ready: false } }) });
  await assert.rejects(invalid("bohemia_prepare", {}), /did not verify/);
});
test("remote review reuses the existing lifecycle without leaving a previous owned session", async () => {
  const actions = [];
  class Session {
    async prepare(input) { actions.push(input.prId); return input; }
    async dispose() { actions.push("release"); }
  }
  const reviewer = codespaceReviewer({ codespaceReviewConfig: "fixture" }, { Session });
  await reviewer.prepare({ prId: 1 });
  await reviewer.prepare({ prId: 2 });
  await reviewer.dispose();
  assert.deepEqual(actions, [1, "release", 2, "release"]);
});
test("WSL authentication is opt-in, coalesced, in-memory and preserves the native client contract", async () => {
  const native = {};
  assert.equal(withWslAdo({}, native), native);
  const requests = [], acquired = [];
  const client = withWslAdo({ adoWslDistribution: "fixture-linux" }, {
    listOwnPullRequests: async (...args) => requests.push(args),
    updateThreadStatus: async (...args) => requests.push(args),
  }, { run: async (...args) => {
    acquired.push(args);
    await new Promise(resolve => setTimeout(resolve, 10));
    return { stdout: JSON.stringify({ accessToken: "fixture-token", expires_on: Math.floor(Date.now() / 1000) + 3600 }) };
  } });
  await Promise.all([client.listOwnPullRequests({}, { allPages: true }), client.updateThreadStatus({}, "42", "7", "fixed", { refresh: true })]);
  assert.equal(acquired.length, 1);
  assert.equal(acquired[0][0], "wsl.exe");
  assert.deepEqual(requests[0][1], { allPages: true, token: "fixture-token" });
  assert.deepEqual(requests[1][4], { refresh: true, token: "fixture-token" });
  const expired = withWslAdo({ adoWslDistribution: "fixture-linux" }, {
    listBuilds: () => assert.fail("must not use an invalid credential"),
  }, { run: async () => ({ stdout: '{"accessToken":"fixture","expires_on":1}' }) });
  await assert.rejects(expired.listBuilds({}, "42"), /current Azure DevOps credential/);
});
