import assert from "node:assert/strict";
import test from "node:test";
import { queryScopeReport, scanAssignedPullRequests } from "../lib/azure-devops.mjs";

const scope = { organization: "https://dev.azure.com/example", project: "OC", repository: "bohemia" };
const email = "reviewer@example.invalid", now = new Date("2026-11-18T12:00:00Z");
const user = { id: "user", memberOf: ["direct-group", "nested-group"],
  properties: { Account: { $value: email } } };
const groups = [
  { id: "maintainers", descriptor: "direct-group", isContainer: true, providerDisplayName: "Repo maintainers" },
  { id: "nested", descriptor: "nested-group", isContainer: true, providerDisplayName: "Nested team" },
  { id: "outsiders", descriptor: "unrelated-group", isContainer: true, providerDisplayName: "Unrelated team" },
];
const team = (id = "maintainers", vote = 0) => ({ id, vote, isContainer: true });
const direct = (vote = 0) => ({ id: user.id, vote });
const pr = (id, reviewers = [team()]) => ({
  pullRequestId: id, title: `Review ${id}`, status: "active", isDraft: false,
  createdBy: { id: "someone-else", uniqueName: "someone@example.invalid" },
  creationDate: "2026-11-17T12:00:00Z", repository: { name: scope.repository },
  reviewers, lastMergeSourceCommit: { commitId: "a".repeat(40) }, lastMergeTargetCommit: { commitId: "b".repeat(40) },
});
function api(pullRequests, { identity = user, groupIdentities = groups, page } = {}) {
  const calls = [];
  return { calls, getJson: async (value, _token, _fetch, _refresh, policy) => {
    const url = new URL(value); calls.push({ url, policy });
    if (url.pathname.endsWith("/_apis/identities")) {
      const ids = url.searchParams.get("identityIds")?.split(",");
      return { value: ids ? groupIdentities.filter(group => ids.includes(group.id)) : [identity] };
    }
    if (/\/pullrequests\/[0-9]+$/.test(url.pathname)) {
      return pullRequests.find(item => String(item.pullRequestId) === url.pathname.split("/").at(-1));
    }
    const skip = Number(url.searchParams.get("$skip"));
    return { value: page ? page(skip) : pullRequests.slice(skip, skip + 1000) };
  } };
}
const report = options => queryScopeReport(scope, email, options, 30, now);

test("1JS requires individual assignment even when the reviewer belongs to an assigned group", async () => {
  const library = { ...scope, repository: "1JS" };
  const inventory = [pr(1), pr(2, [direct()])].map(item => ({ ...item, repository: { name: "1JS" } }));
  const result = await queryScopeReport(library, email, api(inventory), 30, now);
  assert.deepEqual(result.eligible.map(item => item.id), ["2"]);
  assert.ok(result.detected.find(item => item.id === "1").reasons.includes("not explicitly assigned to the reviewer"));
});

test("includes direct and expanded-group assignments once, without mistaking another member's group vote for ours", async () => {
  const inventory = [
    pr(1), pr(2, [team("nested", 10)]), pr(3, [team("outsiders")]),
    pr(4, [direct(), team(), team("nested")]), { ...pr(5), createdBy: { id: user.id } },
    pr(6, [direct(10), team()]), pr(7, [direct(-10), team()]),
    pr(8, [{ ...direct(), hasDeclined: true }, team()]), { ...pr(9), isDraft: true },
    { ...pr(10), status: "completed" }, { ...pr(11), creationDate: "2025-01-01T00:00:00Z" },
    { ...pr(12), title: "Touchdown resources" }, { ...pr(13), createdBy: { isBot: true } },
    { ...pr(14), lastMergeSourceCommit: {} },
  ];
  const result = await report(api(inventory));
  assert.deepEqual(result.eligible.map(item => item.id), ["1", "2", "4", "13"]);
  assert.equal(result.detected.some(item => item.id === "3"), false);
  assert.equal(result.detected.find(item => item.id === "5").selfAuthored, true);
  assert.equal(result.detected.find(item => item.id === "6").reviewerVote, 10);
  assert.deepEqual(result.detected.find(item => item.id === "8").reasons, ["reviewer declined"]);
  assert.equal(result.eligible.find(item => item.id === "2").discovery, "group");
  assert.deepEqual(result.eligible.find(item => item.id === "4").reviewerGroups.map(group => group.id),
    ["maintainers", "nested"]);
});

test("reads assignments beyond the first 1000 PRs and bounds all inventory requests to the configured repository", async () => {
  const inventory = Array.from({ length: 1001 }, (_, index) => pr(index + 1));
  const options = api(inventory);
  const result = await report(options);
  assert.equal(result.eligible.length, 1001);
  assert.equal(new Set(result.eligible.map(item => item.id)).size, 1001);
  const pages = options.calls.filter(call => call.url.pathname.endsWith("/pullrequests"));
  assert.deepEqual(pages.map(call => call.url.searchParams.get("$skip")), ["0", "999"]);
  assert.ok(pages.every(call => call.url.pathname === "/example/OC/_apis/git/repositories/bohemia/pullrequests"));
  assert.ok(pages.every(call => call.url.searchParams.get("searchCriteria.maxTime") === now.toISOString()));
  assert.ok(pages.every(call => call.policy.cacheMs === 0), "snapshot URLs must not accumulate on-disk cache entries");
});

test("fails rather than treating a shifted or incomplete later page as removed reviewer assignments", async () => {
  const first = Array.from({ length: 1000 }, (_, index) => pr(index + 1));
  for (const second of [[pr(1001)], undefined, [first.at(-1), pr(1)]]) {
    const options = api([], { page: skip => skip ? second : first });
    await assert.rejects(report(options), /shifted|invalid pull request list|inconsistent pull request pages/);
  }
});

test("fresh dispatch validation checks one current PR and current memberships, not another full repository inventory", async () => {
  const current = pr(42), options = api([current]);
  const config = { scopes: [scope, { ...scope, repository: "another-repository" }], reviewer: email, maxAgeDays: 30 };
  const result = await scanAssignedPullRequests(config, { ...options, fresh: true,
    pullRequest: { id: "42", ...scope } }, now);
  assert.deepEqual(result.eligible.map(item => item.id), ["42"]);
  const requests = options.calls.filter(call => call.url.pathname.includes("/pullrequests"));
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.pathname.endsWith("/repositories/bohemia/pullrequests/42"));
  assert.ok(options.calls.every(call => call.policy.cacheMs === 0));
  assert.deepEqual((await report(api([current], { identity: { ...user, memberOf: [] } }))).eligible, []);
});

test("does not erase assignments on incomplete expanded memberships or unresolved group identities", async () => {
  const { memberOf: _membership, ...incomplete } = user;
  await assert.rejects(report(api([pr(1)], { identity: incomplete })), /incomplete expanded reviewer memberships/);
  await assert.rejects(report(api([pr(1)], { groupIdentities: [] })), /groups did not resolve completely/);
  await assert.rejects(report(api([{ ...pr(1), reviewers: undefined }])), /incomplete pull request reviewers/);
});

test("resolves only groups actually assigned in this repository rather than listing PRs for every membership", async () => {
  const options = api([pr(1)], { identity: { ...user, memberOf: [...user.memberOf,
    ...Array.from({ length: 300 }, (_, index) => `unrelated-${index}`)] } });
  await report(options);
  assert.equal(options.calls.length, 3);
  assert.equal(options.calls.at(-1).url.searchParams.get("identityIds"), "maintainers");
});
