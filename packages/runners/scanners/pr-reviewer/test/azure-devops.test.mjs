import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createAdoTransport } from "../../lib/ado-transport.mjs";
import { queryScopeReport, scanAssignedPullRequests, reportPullRequests } from "../lib/azure-devops.mjs";

const scope = { organization: "https://example.visualstudio.com", project: "OC" };
const reviewer = "calebzearing@microsoft.com";
const now = new Date("2026-08-22T00:00:00.000Z");

function pullRequest(id, author, { vote = 0 } = {}) {
  return {
    pullRequestId: id,
    title: `PR ${id}`,
    status: "active",
    isDraft: false,
    createdBy: { uniqueName: author, displayName: author },
    reviewers: [{ uniqueName: reviewer, vote }],
    creationDate: "2026-08-21T00:00:00.000Z",
    repository: { name: "office-bohemia" },
    lastMergeSourceCommit: { commitId: "a".repeat(40) },
    lastMergeTargetCommit: { commitId: "b".repeat(40) },
  };
}

function report(pullRequests) {
  return queryScopeReport(scope, reviewer, () => JSON.stringify(pullRequests), 30, now);
}

test("skips pull requests authored by the reviewer", async () => {
  const { detected, eligible } = await report([pullRequest(1, reviewer)]);
  assert.equal(detected[0].selfAuthored, true);
  assert.equal(detected[0].eligible, false);
  assert.deepEqual(detected[0].reasons, ["authored by the reviewer"]);
  assert.deepEqual(eligible, []);
});

test("keeps pull requests authored by someone else", async () => {
  const { detected, eligible } = await report([pullRequest(2, "other@microsoft.com")]);
  assert.equal(detected[0].selfAuthored, false);
  assert.equal(detected[0].eligible, true);
  assert.deepEqual(eligible.map(({ id }) => id), ["2"]);
  assert.equal(detected[0].targetCommit, "b".repeat(40));
  assert.equal(eligible[0].targetCommit, detected[0].targetCommit);
});

test("explicit 1JS scope never admits other repositories in the same ADO project", async () => {
  const library = pullRequest(20, "other@microsoft.com");
  library.repository.name = "1JS";
  const result = await queryScopeReport({ ...scope, repository: "1JS" }, reviewer,
    () => JSON.stringify([library, pullRequest(21, "other@microsoft.com")]), 30, now);
  assert.deepEqual(result.detected.map(pr => pr.id), ["20"]);
  assert.deepEqual(result.eligible.map(pr => pr.id), ["20"]);
});

test("1JS requires the configured reviewer's explicit assignment even for previously path-discovered PRs", () => {
  const pr = { ...pullRequest(22, "other@microsoft.com"), repository: { name: "1JS" } };
  for (const reviewers of [[], [{ uniqueName: "someone-else@microsoft.com", vote: 0 }]]) {
    pr.reviewers = reviewers;
    for (const pathMatches of [new Set(), new Set(["22"])]) {
      const result = reportPullRequests([pr], scope, reviewer, 30, now, pathMatches);
      assert.deepEqual(result.eligible, []);
      assert.ok(result.detected[0].reasons.includes("not explicitly assigned to the reviewer"));
    }
  }
  pr.reviewers = [{ uniqueName: reviewer.toUpperCase(), vote: 0 }];
  assert.equal(reportPullRequests([pr], scope, reviewer, 30, now, new Set(["22"])).eligible.length, 1);
});

test("matches authorship regardless of casing", async () => {
  const { detected } = await report([pullRequest(3, "CalebZearing@Microsoft.com")]);
  assert.equal(detected[0].selfAuthored, true);
});

test("treats a missing author as someone else", async () => {
  const pr = pullRequest(4, "other@microsoft.com");
  delete pr.createdBy;
  const { detected } = await report([pr]);
  assert.equal(detected[0].selfAuthored, false);
  assert.equal(detected[0].eligible, true);
});

test("automatic path discovery skips bots while explicit review assignments remain unchanged", () => {
  for (const author of [
    { uniqueName: "WiKiBoT@Microsoft.com", descriptor: "aad.fixture" },
    { uniqueName: "service@example.invalid", descriptor: "s2s.fixture" },
    { uniqueName: "service@example.invalid", descriptor: "SVC.fixture" },
    { uniqueName: "service@example.invalid", isBot: true },
    { uniqueName: "group@example.invalid", isContainer: true },
  ]) {
    const pr = { ...pullRequest(6, "other@microsoft.com"), createdBy: author, reviewers: [] };
    const pathMatches = new Set(["6"]);
    const skipped = reportPullRequests([pr], scope, reviewer, 30, now, pathMatches);
    assert.deepEqual(skipped.eligible, []);
    assert.deepEqual(skipped.detected[0].reasons, ["bot-authored; not explicitly assigned to the reviewer"]);
    pr.reviewers = [{ uniqueName: reviewer.toUpperCase(), vote: 0 }];
    assert.equal(reportPullRequests([pr], scope, reviewer, 30, now, pathMatches).eligible.length, 1);
    assert.equal(reportPullRequests([pr], scope, reviewer, 30, now).eligible.length, 1);
    pr.isDraft = true;
    assert.deepEqual(reportPullRequests([pr], scope, reviewer, 30, now, pathMatches).detected[0].reasons, ["draft"]);
  }
});

test("bot assignment override does not bypass closed, self-authored, voted or invalid-source exclusions", () => {
  for (const change of [
    { status: "completed" },
    { status: "abandoned" },
    { createdBy: { uniqueName: reviewer, descriptor: "svc.fixture" } },
    { reviewers: [{ uniqueName: reviewer, vote: 10 }] },
    { lastMergeSourceCommit: { commitId: "invalid" } },
  ]) {
    const pr = { ...pullRequest(7, "service@example.invalid"),
      createdBy: { uniqueName: "service@example.invalid", descriptor: "s2s.fixture" }, ...change };
    assert.deepEqual(reportPullRequests([pr], scope, reviewer, 30, now, new Set(["7"])).eligible, []);
  }
});

test("human authors are not excluded by bot words, automation titles or Copilot branch names", () => {
  const pr = { ...pullRequest(8, "robertbot@example.invalid"), reviewers: [],
    createdBy: { uniqueName: "robertbot@example.invalid", displayName: "Robert Bot", descriptor: "aad.fixture" },
    title: "AUTO-MERGE: fix bot settings", sourceRefName: "refs/heads/copilot/human-request" };
  assert.equal(reportPullRequests([pr], scope, reviewer, 30, now, new Set(["8"])).eligible.length, 1);
});

test("Touchdown titles are excluded for explicit assignments and automatic path discovery", () => {
  for (const title of ["Touchdown Build - Localized Resource Files", "TOUCHDOWN build", "touchdown build"]) {
    for (const assigned of [true, false]) {
      const pr = { ...pullRequest(8, "other@microsoft.com"), title,
        reviewers: assigned ? [{ uniqueName: reviewer, vote: 0 }] : [] };
      const result = reportPullRequests([pr], scope, reviewer, 30, now, new Set(["8"]));
      assert.deepEqual(result.eligible, []);
      assert.deepEqual(result.detected[0].reasons, ["Touchdown PRs are excluded"]);
    }
  }
  const pr = { ...pullRequest(9, "other@microsoft.com"), title: "Fix localized resource loading" };
  assert.equal(reportPullRequests([pr], scope, reviewer, 30, now).eligible.length, 1);
});

test("do-not-merge and test-only title markers exclude assigned and path-discovered reviews", () => {
  for (const title of [
    "[DO NOT MERGE] Compare navigation", "Combined test build (do not merge)",
    "[do-not-merge] Preview", "[DO_NOT_MERGE] Preview", "Don't merge this preview",
    "DON\u2019T MERGE this preview", "[DNM] Preview",
    "[TEST ONLY - DO NOT MERGE] Automated review fixture", "TEST ONLY, renderer experiment",
    "Stabilize visual tests (test-only)", "[TEST_ONLY] Preview", "Testing only - preview",
  ]) {
    for (const assigned of [true, false]) {
      const pr = { ...pullRequest(23, "other@microsoft.com"), title,
        reviewers: assigned ? [{ uniqueName: reviewer, vote: 0 }] : [] };
      const result = reportPullRequests([pr], scope, reviewer, 30, now, new Set(["23"]));
      assert.deepEqual(result.eligible, [], title);
      assert.deepEqual(result.detected[0].reasons, ["PR title marks this as do-not-merge or test-only"], title);
    }
  }
  for (const title of ["Add regression tests", "Fix test runner", "Merge test coverage",
    "Support testability", "Test onlyWhenReady option", "Handle DNMSettings correctly"]) {
    assert.equal(reportPullRequests([{ ...pullRequest(24, "other@microsoft.com"), title }],
      scope, reviewer, 30, now).eligible.length, 1, title);
  }
});

test("missing or invalid source revision is not eligible for a speculative review", async () => {
  const pr = pullRequest(5, "other@microsoft.com");
  delete pr.lastMergeSourceCommit;
  const { detected, eligible } = await report([pr]);
  assert.equal(eligible.length, 0);
  assert.ok(detected[0].reasons.includes("source commit is missing or invalid"));
});

test("malformed PR list cannot be mistaken for removed assignments", async () => {
  await assert.rejects(queryScopeReport(scope, reviewer, () => "{}", 30, now), /invalid pull request list/);
});

const identity = {
  id: "81fa6389-0872-6fdd-a451-7ba7880f566a",
  isActive: true,
  memberOf: [],
  properties: { Account: { $value: reviewer } },
};
const json = (body) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" },
});

test("caches expanded identities while reading complete current assignments without CLI", async (t) => {
  const urls = [];
  const directory = fileURLToPath(new URL(`./.ado-cache-${randomUUID()}/`, import.meta.url));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = now.getTime();
  const transport = createAdoTransport({ directory, now: () => clock });
  const options = {
    token: "fixture-token",
    getJson: (url, token, fetchImpl, refresh, policy) => (
      transport.request(url, { token, fetchImpl, refresh, ...policy })
    ),
    refresh: () => assert.fail("credentials must not be acquired"),
    fetchImpl: async (url, init) => {
      urls.push(new URL(url));
      assert.equal(init.method, "GET");
      assert.equal(init.headers.Authorization, "Bearer fixture-token");
      assert.ok(init.signal instanceof AbortSignal);
      return json(url.includes("/_apis/identities")
        ? { value: [identity] }
        : { value: [pullRequest(5, "other@microsoft.com")] });
    },
  };
  const config = { scopes: [scope], reviewer, maxAgeDays: 30 };
  const first = await scanAssignedPullRequests(config, options, now);
  const second = await scanAssignedPullRequests(config, options, now);
  assert.deepEqual(second, first);
  assert.equal(urls.length, 3, "repeat scan reuses identity membership, not a stale inventory snapshot");
  assert.equal(urls[0].origin, "https://vssps.dev.azure.com");
  assert.equal(urls[0].pathname, "/example/_apis/identities");
  assert.equal(urls[0].searchParams.get("searchFilter"), "General");
  assert.equal(urls[0].searchParams.get("filterValue"), reviewer);
  assert.equal(urls[1].pathname, "/OC/_apis/git/pullrequests");
  assert.equal(urls[0].searchParams.get("queryMembership"), "Expanded");
  assert.equal(urls[1].searchParams.get("searchCriteria.reviewerId"), null);
  assert.equal(urls[1].searchParams.get("searchCriteria.status"), "active");
  assert.equal(urls[1].searchParams.get("$top"), "1000");
  assert.deepEqual(first.eligible.map(({ id }) => id), ["5"]);
  clock += 60_000;
  await scanAssignedPullRequests(config, options, now);
  assert.equal(urls.length, 4, "next poll refreshes only the PR list, not membership");
  clock += 300_000;
  await scanAssignedPullRequests(config, options, now);
  assert.equal(urls.length, 6, "expanded membership refreshes within five minutes");
});

test("modern organization URLs and project names are encoded without changing scope", async () => {
  const urls = [];
  await queryScopeReport({ organization: "https://dev.azure.com/example/", project: "My Project" },
    reviewer, {
      token: "fixture-token",
      fetchImpl: async (url) => {
        urls.push(new URL(url));
        return json({ value: url.includes("/_apis/identities") ? [identity] : [] });
      },
    }, 30, now);
  assert.equal(urls[0].pathname, "/example/_apis/identities");
  assert.equal(urls[1].pathname, "/example/My%20Project/_apis/git/pullrequests");
});

for (const [name, identities] of [
  ["missing", []],
  ["ambiguous", [identity, { ...identity, id: "another-id" }]],
  ["non-exact", [{ ...identity, properties: { Account: { $value: `other-${reviewer}` } } }]],
]) {
  test(`fails closed on ${name} reviewer identity, without an unfiltered PR request`, async () => {
    let calls = 0;
    await assert.rejects(queryScopeReport(scope, reviewer, {
      token: "fixture-token",
      fetchImpl: async () => { calls++; return json({ value: identities }); },
    }), /must resolve uniquely/);
    assert.equal(calls, 1);
  });
}

test("async scan preserves timeout rejection for the runner failure handler", async () => {
  const timeout = Object.assign(new Error("HTTP timed out"), { name: "TimeoutError" });
  await assert.rejects(scanAssignedPullRequests({ scopes: [scope], reviewer }, {
    token: "fixture-token",
    fetchImpl: async () => { throw timeout; },
  }), (error) => error === timeout);
});

test("async scan preserves throttle status and Retry-After instead of falling back to CLI", async () => {
  let calls = 0;
  await assert.rejects(scanAssignedPullRequests({ scopes: [scope], reviewer }, {
    token: "fixture-token",
    fetchImpl: async () => {
      calls++;
      return new Response(null, { status: 429, headers: { "retry-after": "120" } });
    },
  }), (error) => error.status === 429 && error.retryAfterMs === 120_000);
  assert.equal(calls, 1);
});
