import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanDirectoryPullRequests, scanDirectoryPullRequest } from "../lib/directory-discovery.mjs";

const sourceCommit = "a".repeat(40), targetCommit = "b".repeat(40), commonCommit = "c".repeat(40);
const now = new Date("2026-11-03T12:00:00Z");

async function fixture(t, { bases = [], comparison = {}, other = false, count = 1, allMissing = false, draft = false,
  title = "Fixture", assigned = true } = {}) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "review-discovery-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const repositoryId = "11111111-1111-4111-8111-111111111111";
  const config = {
    reviewer: "reviewer@example.invalid", maxAgeDays: 30, codespaceReviewConfig: "fixture",
    scopes: [{ organization: "https://example.visualstudio.com", project: "Fixture", repository: "1JS" }],
    directoryDiscovery: { mode: "poll", stateDirectory, repositoryId,
      projectId: "22222222-2222-4222-8222-222222222222",
      scopes: [{ id: "library", directories: ["/library"] }] },
  };
  const pr = {
    pullRequestId: 1, title, status: "active", isDraft: draft,
    creationDate: "2026-11-02T12:00:00Z", createdBy: { uniqueName: "author@example.invalid" },
    repository: { id: repositoryId, name: "1JS" },
    reviewers: assigned ? [{ uniqueName: config.reviewer, vote: 0 }] : [],
    sourceRefName: "refs/heads/fixture", targetRefName: "refs/heads/main",
    lastMergeSourceCommit: { commitId: sourceCommit }, lastMergeTargetCommit: { commitId: targetCommit },
  };
  const pullRequests = [pr, ...Array.from({ length: (other ? 2 : count) - 1 }, (_, index) => ({
    ...pr, pullRequestId: index + 2,
    lastMergeSourceCommit: { commitId: (index + 2).toString(16).padStart(40, "0") },
  }))];
  const baseLookups = [];
  let comparisons = 0, mergeBaseRequests = 0;
  const options = {
    token: "fixture-token", bootstrap: true,
    feed: { remote: {
      config: { nativeProfile: { nodeExecutable: "/usr/bin/node" }, remoteRoot: "/repo" },
      ssh: async (_command, _timeout, _signal, input) => {
        mergeBaseRequests++;
        return { stdout: JSON.stringify(JSON.parse(input).map(pair => ({ ...pair, commonCommit: null }))) };
      },
    } },
    scanAssigned: async () => ({ detected: [], eligible: [] }),
    requestJson: async (url, input) => {
      const request = new URL(url);
      if (request.pathname.endsWith("/pullrequests")) return { value: pullRequests.filter(pr => {
        const created = Date.parse(pr.creationDate);
        return created >= Date.parse(request.searchParams.get("searchCriteria.minTime")) &&
          created <= Date.parse(request.searchParams.get("searchCriteria.maxTime"));
      }) };
      if (request.pathname.endsWith("/pushes")) return { value: [] };
      if (/\/pullrequests\/\d+$/.test(request.pathname))
        return pullRequests.find(pr => String(pr.pullRequestId) === request.pathname.split("/").at(-1));
      if (request.pathname.endsWith("/mergebases")) {
        baseLookups.push(request.pathname);
        return { value: (!allMissing && !request.pathname.includes(sourceCommit)
          ? [commonCommit] : bases).map(commitId => ({ commitId })) };
      }
      if (request.pathname.endsWith("/diffs/commits")) {
        comparisons++;
        assert.equal(request.searchParams.get("baseVersion"), targetCommit);
        assert.equal(request.searchParams.get("targetVersion"), sourceCommit);
        assert.equal(request.searchParams.get("$top"), "0");
        return { baseCommit: targetCommit, targetCommit: sourceCommit, commonCommit, changes: [], ...comparison };
      }
      if (request.pathname.endsWith("/itemsbatch")) return {
        value: input.body.itemDescriptors.map(item => [{
          path: item.path, commitId: item.version, isFolder: true, gitObjectType: "tree",
          objectId: (item.version === commonCommit ? "e" : "d").repeat(40),
        }]),
      };
      assert.fail(`Unexpected request: ${request.pathname}`);
    },
  };
  return { scan: () => scanDirectoryPullRequests(config, { ...options, bootstrap: false }, now),
    bootstrap: () => scanDirectoryPullRequests(config, options, now),
    verify: () => scanDirectoryPullRequest(config, { id: "1", discovery: "path", sourceCommit, targetCommit }, options, now),
    pr,
    comparisons: () => comparisons, mergeBaseRequests: () => mergeBaseRequests, baseLookups };
}

for (const title of ["Touchdown Build - Localized Resource Files", "[DO NOT MERGE] Preview", "[TEST ONLY] Preview"])
test(`excluded title "${title}" does not trigger directory comparisons or remote Git work`, async t => {
  const f = await fixture(t, { title });
  const report = await f.bootstrap();
  assert.deepEqual(report.eligible, []);
  assert.equal(f.mergeBaseRequests(), 0);
  assert.deepEqual(f.baseLookups, []);
  assert.equal(f.comparisons(), 0);
});

test("unassigned 1JS PRs do not trigger directory comparisons or remote Git work", async t => {
  const f = await fixture(t, { assigned: false });
  assert.deepEqual((await f.bootstrap()).eligible, []);
  assert.equal(f.mergeBaseRequests(), 0);
  assert.deepEqual(f.baseLookups, []);
  assert.equal(f.comparisons(), 0);
});

test("fresh handoff checks reject a renamed or unassigned previously discovered PR", async t => {
  const f = await fixture(t, { bases: [commonCommit] });
  assert.deepEqual((await f.bootstrap()).eligible.map(pr => pr.id), ["1"]);
  f.pr.title = "[TEST ONLY - DO NOT MERGE] Preview";
  assert.deepEqual((await f.verify()).eligible, []);
  f.pr.title = "Fixture";
  f.pr.reviewers = [];
  assert.deepEqual((await f.verify()).eligible, []);
});

test("one PR without comparison history cannot block other directory reviews", async t => {
  const f = await fixture(t, { other: true });
  const report = await f.bootstrap();
  assert.deepEqual(report.eligible.map(pr => pr.id), ["2"]);
  const deferred = report.detected.find(pr => pr.id === "1");
  assert.equal(deferred.comparisonDeferred, true);
  assert.match(deferred.reasons.join(", "), /authoritative comparison base/);
  assert.equal(f.comparisons(), 0);
});

test("bounded recovery rotates unresolved comparisons across scans without starving later PRs", async t => {
  const f = await fixture(t, { count: 51, allMissing: true });
  const initial = await f.bootstrap();
  assert.equal(initial.discovery.deferredPullRequests, 51);
  f.baseLookups.length = 0;
  assert.equal((await f.scan()).discovery.deferredPullRequests, 51);
  assert.equal(f.baseLookups.length, 50);
  assert.equal((await f.scan()).discovery.deferredPullRequests, 51);
  assert.equal(f.baseLookups.length, 100);
  assert.equal(new Set(f.baseLookups).size, 51);
});

test("comparison uncertainty cannot hide a confirmed draft or preserve an ineligible review", async t => {
  const f = await fixture(t, { draft: true });
  const report = await f.bootstrap();
  assert.equal(report.eligible.length, 0);
  assert.equal(report.detected[0].comparisonDeferred, false);
  assert.ok(report.detected[0].reasons.includes("draft"));
});

test("directory discovery can resolve multiple merge bases only with pinned authoritative metadata", async t => {
  const f = await fixture(t, { bases: [commonCommit, "d".repeat(40)] });
  assert.deepEqual((await f.bootstrap()).eligible.map(pr => pr.id), ["1"]);
  assert.equal(f.comparisons(), 1);
});

test("directory discovery preserves the unique merge-base fast path", async t => {
  const f = await fixture(t, { bases: [commonCommit] });
  assert.deepEqual((await f.bootstrap()).eligible.map(pr => pr.id), ["1"]);
  assert.equal(f.comparisons(), 0);
});

test("directory discovery rejects conflicting authoritative merge-base results", async t => {
  const f = await fixture(t, { bases: ["d".repeat(40), "e".repeat(40)] });
  await assert.rejects(f.bootstrap(), /authoritative comparison base/);
});

for (const [name, comparison] of [
  ["wrong base", { baseCommit: "d".repeat(40) }],
  ["wrong source", { targetCommit: "d".repeat(40) }],
  ["missing base identity", { baseCommit: undefined }],
  ["invalid common commit", { commonCommit: "main" }],
  ["unexpected changes", { changes: [{ item: { path: "/library/file.ts" } }] }],
  ["malformed changes", { changes: {} }],
]) {
  test(`directory discovery rejects ${name} instead of admitting an unverified review`, async t => {
    const f = await fixture(t, { bases: [commonCommit, "d".repeat(40)], comparison });
    await assert.rejects(f.bootstrap(), /authoritative comparison base/);
  });
}
