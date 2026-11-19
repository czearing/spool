import test from "node:test";
import assert from "node:assert/strict";
import { createBacklogClient, workItem, sameArtifact } from "../backlog-ado.mjs";
import { requestJson, createAdoTransport } from "../../scanners/lib/ado-transport.mjs";
import { backlogFixture, reviewers } from "./backlog-fixture.mjs";

const raw = (id, changes = {}) => ({ id, rev: 7, fields: { "System.TeamProject": "OC",
  "System.Title": `Item ${id}`, "System.WorkItemType": "Task", "System.State": "New",
  "System.AssignedTo": { uniqueName: "owner@example.test" }, "System.CreatedDate": "2026-01-01T00:00:00Z",
  "Microsoft.VSTS.Common.Priority": 1, ...changes },
  relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://dev.azure.com/office/OC/_apis/wit/workItems/12284752" }] });
const states = { value: [{ name: "New", category: "Proposed" }, { name: "Closed", category: "Completed" },
  { name: "Cut", category: "Removed" }] };
test("work-item normalization preserves ownership, actual parents, and missing priorities", () => {
  const value = workItem(raw(1, { "Microsoft.VSTS.Common.Priority": undefined }));
  assert.equal(value.priority, null);
  assert.equal(value.assignedTo, "owner@example.test");
  assert.equal(value.parentId, 12284752);
  assert.throws(() => workItem(raw(1, { "Microsoft.VSTS.Common.Priority": "1" })), /priority/);
  assert.throws(() => workItem(raw(1, { "System.CreatedDate": "invalid" })), /response/);
});
test("actual parent membership, assigned identity, and state categories filter unordered batch results", async t => {
  const f = backlogFixture(t), calls = [];
  const client = createBacklogClient(f.config, { credential: null, request: async (url, options) => {
    calls.push({ url, options });
    if (url.includes("/states?")) return states;
    if (url.includes("/workitemsbatch?")) {
      assert.equal(options.body.$expand, undefined);
      return { value: [raw(4, { "System.AssignedTo": { uniqueName: "other" } }),
        raw(2, { "Microsoft.VSTS.Common.Priority": undefined }), raw(3, { "System.State": "Cut" }), raw(1)] };
    }
    return { id: 12284752, fields: { "System.TeamProject": "OC" }, relations: [1, 2, 3, 4].map(id =>
      ({ rel: "System.LinkTypes.Hierarchy-Forward", url: `https://dev.azure.com/office/OC/_apis/wit/workItems/${id}` })) };
  } });
  assert.deepEqual((await client.list()).map(item => item.id), [1, 2]);
  assert.ok(calls.every(call => call.url.includes("/office/OC/")));
  assert.equal(client.itemUrl(1), "https://office.visualstudio.com/OC/_workitems/edit/1");
});
test("incomplete batches and unrecognized workflow states are explicit errors", async t => {
  const f = backlogFixture(t);
  const client = createBacklogClient(f.config, { credential: null, request: async url =>
    url.includes("/workitemsbatch?") ? { value: [] } : { id: 12284752, fields: { "System.TeamProject": "OC" },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/1" }] } });
  await assert.rejects(client.list(), /Incomplete/);
  const unknown = createBacklogClient(f.config, { credential: null, request: async () => states });
  await assert.rejects(unknown.isOpen(workItem(raw(1, { "System.State": "Unknown" }))), /Unknown/);
});
test("artifact linking and closing use revision-tested JSON Patch and fresh readback", async t => {
  const f = backlogFixture(t), value = raw(1), writes = [];
  const artifact = "vstfs:///Git/PullRequestId/project%2Frepo%2F8";
  const client = createBacklogClient(f.config, { credential: null, request: async (url, options) => {
    if (url.includes("/states?")) return states;
    if (options.method === "PATCH") {
      writes.push(options);
      assert.deepEqual(options.body[0], { op: "test", path: "/rev", value: value.rev });
      assert.equal(options.contentType, "application/json-patch+json");
      const change = options.body[1];
      if (change.path === "/relations/-") value.relations.push(change.value);
      else value.fields["System.State"] = change.value;
      value.rev++;
      return value;
    }
    return structuredClone(value);
  } });
  const linked = await client.link(workItem(value), artifact);
  assert.equal(linked.rev, 8);
  const closed = await client.close(linked);
  assert.equal(closed.state, "Closed");
  assert.equal(closed.rev, 9);
  assert.equal(writes.length, 2);
  assert.equal(await client.isCompleted(closed), true);
  assert.ok(sameArtifact(artifact, artifact.replaceAll("%2F", "/")));
});
test("reviewer verification requires the configured exact active human IDs, not a first display-name match", async t => {
  const f = backlogFixture(t);
  let identities = reviewers.map(reviewer => ({ id: reviewer.id, providerDisplayName: reviewer.name, isActive: true }));
  const client = createBacklogClient(f.config, { credential: null, request: async () => ({ value: identities }) });
  await client.verifyReviewers();
  identities = identities.map((value, index) => index ? value : { ...value, id: "different-same-name" });
  await assert.rejects(client.verifyReviewers(), /Nate Tan/);
});
test("reviewer assignment only adds missing identities, preserves existing votes, and verifies the roster", async t => {
  const f = backlogFixture(t), roster = [{ ...reviewers[0], vote: 10 }, { id: "existing", vote: -5 }], writes = [];
  const pr = { pullRequestId: 8, reviewers: roster };
  const client = createBacklogClient(f.config, { credential: null, request: async (_url, options) => {
    if (options.method === "PUT") { writes.push(options.body); roster.push({ ...options.body, vote: 0 }); }
    return pr;
  } });
  await client.reviewers(pr);
  assert.deepEqual(writes, reviewers.slice(1).map(({ id }) => ({ id })));
  assert.equal(roster[0].vote, 10);
  assert.equal(roster[1].vote, -5);
});
test("PR lookup is exact-branch and creator-scoped across all statuses; ambiguous matches fail", async t => {
  const f = backlogFixture(t); let matches = [];
  const client = createBacklogClient(f.config, { credential: null, request: async url => {
    const query = new URL(url).searchParams;
    assert.equal(query.get("searchCriteria.creatorId"), f.config.ado.creatorId);
    assert.equal(query.get("searchCriteria.status"), "all");
    assert.equal(query.get("searchCriteria.sourceRefName"), "refs/heads/user/calebzearing/library-backlog-1");
    return { value: matches };
  } });
  assert.equal(await client.findPr("user/calebzearing/library-backlog-1"), null);
  matches = [{ pullRequestId: 1 }, { pullRequestId: 2 }];
  await assert.rejects(client.findPr("user/calebzearing/library-backlog-1"), /Ambiguous/);
});
test("both injected and coordinated ADO transports preserve explicit JSON Patch media type", async t => {
  const f = backlogFixture(t);
  const fetchImpl = async (_url, options) => {
    assert.equal(options.headers["content-type"], "application/json-patch+json");
    assert.equal(options.headers.Authorization, "Bearer fixture");
    return new Response("{}", { headers: { "content-type": "application/json" } });
  };
  const options = { token: "fixture", method: "PATCH", contentType: "application/json-patch+json", body: [] };
  await requestJson("https://dev.azure.com/fixture/OC/_apis/wit/workitems/1", { ...options, fetchImpl });
  const transport = createAdoTransport({ directory: f.runtime, fetchImpl });
  await transport.request("https://dev.azure.com/fixture/OC/_apis/wit/workitems/1", options);
});
test("rejected credentials are cleared and writes are never automatically replayed", async t => {
  const f = backlogFixture(t); let cleared = 0, requests = 0;
  const client = createBacklogClient(f.config, { credential: { token: async () => "fixture", clear: () => { cleared++; } },
    request: async (_url, options) => {
      requests++; assert.equal(options.token, "fixture");
      throw Object.assign(new Error("Token rejected"), { tokenRejected: true });
    } });
  await assert.rejects(client.link(workItem(raw(1)), "artifact"), /Token rejected/);
  assert.equal(requests, 1);
  assert.equal(cleared, 1);
});
