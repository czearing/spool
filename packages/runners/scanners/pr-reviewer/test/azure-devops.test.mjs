import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createAdoTransport } from "../../lib/ado-transport.mjs";
import { queryScopeReport, scanAssignedPullRequests } from "../lib/azure-devops.mjs";

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
  properties: { Account: { $value: reviewer } },
};
const json = (body) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" },
});

test("resolves email via identities and caches one server-filtered list per scope without CLI", async (t) => {
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
  assert.equal(urls.length, 2, "repeat scan should read the identity and PR caches");
  assert.equal(urls[0].origin, "https://vssps.dev.azure.com");
  assert.equal(urls[0].pathname, "/example/_apis/identities");
  assert.equal(urls[0].searchParams.get("searchFilter"), "General");
  assert.equal(urls[0].searchParams.get("filterValue"), reviewer);
  assert.equal(urls[1].pathname, "/OC/_apis/git/pullrequests");
  assert.equal(urls[1].searchParams.get("searchCriteria.reviewerId"), identity.id);
  assert.equal(urls[1].searchParams.get("searchCriteria.status"), "active");
  assert.equal(urls[1].searchParams.get("$top"), "1000");
  assert.deepEqual(first.eligible.map(({ id }) => id), ["5"]);
  clock += 60_000;
  await scanAssignedPullRequests(config, options, now);
  assert.equal(urls.length, 3, "next poll refreshes only the PR list, not the identity");
  clock += 86_400_000;
  await scanAssignedPullRequests(config, options, now);
  assert.equal(urls.length, 5, "identity cache is bounded to one day");
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
