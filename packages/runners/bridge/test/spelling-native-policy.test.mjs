import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./fixtures.mjs";
import { nativeReviewerRules, readReviewerRules } from "../../scanners/spelling/reviewer-policy.mjs";
import { routing } from "../../scanners/spelling/plan.mjs";
import { resolveIdentities } from "../../scanners/spelling/publish.mjs";

const repositoryId = "11111111-1111-4111-8111-111111111111";
const reviewerId = "22222222-2222-4222-8222-222222222222";
const policy = (extra = {}) => ({
  id: 1, isEnabled: true, isBlocking: true,
  type: { id: "fd2167ab-b0be-447a-8ec8-39368250530e" },
  settings: { requiredReviewerIds: [reviewerId], minimumApproverCount: 1,
    scope: [{ repositoryId, refName: "refs/heads/master", matchKind: "Exact" }],
    filenamePatterns: ["/packages/*"], ...extra },
});

test("native path filters cross directory boundaries, ignore case and apply exclusions in order", () => {
  const rules = nativeReviewerRules([policy({ filenamePatterns: [
    "/PACKAGES/*", "!/packages/a/*", "/packages/a/public/*",
  ] })], repositoryId);
  assert.deepEqual(routing("packages/b/src/nested/file.ts", rules).required, [reviewerId]);
  assert.deepEqual(routing("packages/a/private/file.ts", rules).required, []);
  assert.deepEqual(routing("packages/a/public/file.ts", rules).required, [reviewerId]);
});

test("optional native ownership and unfiltered requirements retain their roles", () => {
  const optional = { ...policy(), isBlocking: false };
  assert.deepEqual(routing("packages/a/src/file.ts", nativeReviewerRules([optional], repositoryId)).optional, [reviewerId]);
  assert.deepEqual(routing("change/file.json", nativeReviewerRules([policy({ filenamePatterns: [] })], repositoryId)).required,
    [reviewerId]);
});

for (const [name, settings] of [
  ["another repository", { scope: [{ repositoryId: reviewerId, refName: "refs/heads/master", matchKind: "Exact" }] }],
  ["another branch", { scope: [{ repositoryId, refName: "refs/heads/release", matchKind: "Exact" }] }],
  ["unrepresentable approval counts", { minimumApproverCount: 2 }],
  ["added-file-only ownership", { addedFilesOnly: true }],
  ["missing identities", { requiredReviewerIds: [] }],
  ["malformed path filters", { filenamePatterns: [null] }],
]) test(`native ownership holds ${name} instead of dropping requirements`, () => {
  assert.throws(() => nativeReviewerRules([policy(settings)], repositoryId), /automatic batching held/);
});

test("retired GitOps policy uses only the exact origin repository's complete native policy pages", async t => {
  const f = fixture(t), calls = [], git = (...args) => execFileSync("git", args, {
    cwd: f.workspace, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(path.join(f.workspace, "README.md"), "Fixture\n");
  git("add", "."); git("commit", "-m", "Fixture");
  git("remote", "add", "origin", "https://dev.azure.com/fixture/Project/_git/Repository");
  const request = async address => {
    const url = new URL(address); calls.push(url);
    if (url.pathname.endsWith("/repositories/Repository")) return { id: repositoryId };
    assert.equal(url.searchParams.get("repositoryId"), repositoryId);
    assert.equal(url.searchParams.get("refName"), "refs/heads/master");
    const start = Number(url.searchParams.get("continuationToken"));
    return { value: start ? [{ ...policy(), id: 1001 }] :
      Array.from({ length: 1000 }, (_, i) => ({ ...policy(), id: i + 1 })) };
  };
  assert.equal((await readReviewerRules(f.workspace, git("rev-parse", "HEAD"), { request })).length, 1001);
  assert.equal(calls.length, 3);
  await assert.rejects(readReviewerRules(f.workspace, "HEAD", {
    request: async url => url.includes("/repositories/") ? { id: repositoryId } : { value: [] },
  }), /No authoritative reviewer ownership/);
});

test("native reviewer UUIDs resolve by exact identity, never as fabricated email aliases", async () => {
  const identities = await resolveIdentities(nativeReviewerRules([policy()], repositoryId), {
    organization: "https://dev.azure.com/fixture",
    transport: { request: async url => {
      assert.equal(new URL(url).searchParams.get("identityIds"), reviewerId);
      assert.equal(new URL(url).searchParams.has("filterValue"), false);
      return { value: [{ id: reviewerId, isContainer: true, providerDisplayName: "Fixture team" }] };
    } },
  });
  assert.equal(identities.get(reviewerId).group, true);
});
