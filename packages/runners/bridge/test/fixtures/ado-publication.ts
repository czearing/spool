import assert from "node:assert/strict";
import { promisify } from "node:util";
import { mock } from "bun:test";

mock.module("node:child_process", () => ({
  execFile: Object.assign(() => { throw new Error("Unexpected subprocess"); }, {
    [promisify.custom]: async () => ({ stdout: JSON.stringify({ accessToken: "fixture-only" }), stderr: "" }),
  }),
}));
process.env.BOHEMIA_ADO_ORG = "https://example.invalid";
process.env.BOHEMIA_ADO_PROJECT = "fixture";
let response = new Response("{}");
globalThis.fetch = async (input, init) => {
  assert.equal(new URL(String(input)).origin, "https://example.invalid");
  assert.equal(init?.redirect, "manual");
  return response;
};
const { branchTip, createPullRequest, getPullRequest } = await import("../../../packages/bohemia-pr-mcp/src/ado.ts");
const input = { repository: "fixture", sourceBranch: "user/topic", targetBranch: "master", title: "Fixture", description: "Fixture" };
for (const status of [400, 408, 429, 500, 503]) {
  for (const body of [
    '{"typeKey":"GitPullRequestCannotBeActivated","message":"TF401398: missing branch"}',
    '{"typeKey":"UnknownFailure"}', "null", "not JSON",
  ]) {
    response = new Response(body, { status });
    await assert.rejects(createPullRequest(input), error => {
      assert.ok(error instanceof Error && error.message.startsWith(`Azure DevOps ${status}:`));
      assert.equal(error.status, status);
      assert.equal(error.creationRejected, status === 400 && body.includes("GitPullRequestCannotBeActivated"));
      return true;
    });
  }
}
response = new Response('{"typeKey":"GitPullRequestCannotBeActivated"}', { status: 400 });
await assert.rejects(getPullRequest("fixture", 123), error => {
  assert.equal(error.creationRejected, false);
  return true;
});
for (const status of [200, 203, 302, 401, 403]) {
  response = new Response("<html>Sign in</html>", { status, headers: { "content-type": "text/html" } });
  await assert.rejects(createPullRequest(input), error => {
    assert.match(error.message, /Azure DevOps authentication was rejected/);
    assert.equal(error.tokenRejected, true);
    assert.equal(error.creationRejected, false, "Authentication errors never authorize another POST");
    return true;
  });
}
response = Response.json({ value: [
  { name: "refs/heads/user/topic-other", objectId: "a".repeat(40) },
  { name: "refs/heads/user/topic", objectId: "b".repeat(40) },
] });
assert.equal(await branchTip("fixture", "user/topic"), "b".repeat(40));
response = Response.json({ value: [{ name: "refs/heads/user/topic-other", objectId: "a".repeat(40) }] });
assert.equal(await branchTip("fixture", "user/topic"), undefined);
response = Response.json({});
await assert.rejects(branchTip("fixture", "user/topic"), /Invalid branch lookup response/);
console.log("Actual ADO transport preserves uncertain errors and matches exact source refs.");
