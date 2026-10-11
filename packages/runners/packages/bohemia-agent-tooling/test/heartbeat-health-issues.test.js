import test from "node:test";
import assert from "node:assert/strict";

import { createIssuesSource } from "../tools/heartbeat-health/issues-source.js";

const list = [
  { id: "1", identifier: "OFF-60", status: "blocked" },
  { id: "2", identifier: "OFF-62", status: "in_progress" },
  { id: "3", identifier: "OFF-51", status: "blocked" },
];

function fakeFetch(seen) {
  return async (url) => {
    seen.push(url);
    if (url.includes("/issues?")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ issues: list }) };
    }
    const id = url.split("/").pop();
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          issue: { id, blockedBy: id === "3" ? [{ id: "9" }] : [], blockedTransitionAt: "2026-09-01T23:13:33Z" },
        }),
    };
  };
}

test("only the blocked issues are read a second time for their blocker relation", async () => {
  const seen = [];
  const source = createIssuesSource({
    baseUrl: "https://example.test/",
    apiKey: "key",
    companyId: "co",
    fetchImpl: fakeFetch(seen),
  });
  const blocked = await source.readBlockedIssues({ limit: 50 });
  assert.equal(blocked.length, 2);
  assert.equal(seen[0], "https://example.test/api/companies/co/issues?limit=50");
  assert.deepEqual(seen.slice(1), [
    "https://example.test/api/issues/1",
    "https://example.test/api/issues/3",
  ]);
  assert.deepEqual(blocked[0].blockedBy, []);
  assert.equal(blocked[1].blockedBy.length, 1);
});

test("an issue payload with no blocker relation reads as no blockers rather than as unknown", async () => {
  const source = createIssuesSource({
    baseUrl: "https://example.test",
    apiKey: "key",
    companyId: "co",
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        url.includes("/issues?")
          ? JSON.stringify({ issues: [{ id: "1", status: "blocked" }] })
          : JSON.stringify({ id: "1" }),
    }),
  });
  const blocked = await source.readBlockedIssues();
  assert.deepEqual(blocked[0].blockedBy, []);
  assert.deepEqual(blocked[0].blocks, []);
  assert.equal(blocked[0].monitorNextCheckAt, null);
  assert.equal(blocked[0].unblockDescriptor, null);
  assert.equal(blocked[0].status, "blocked", "the list status survives a detail payload without one");
});

test("the fields the wake path walk reads come back off the detail payload", async () => {
  const descriptor = { owner: { agentId: "agent-1" }, action: "raise the cap and unblock" };
  const source = createIssuesSource({
    baseUrl: "https://example.test",
    apiKey: "key",
    companyId: "co",
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        url.includes("/issues?")
          ? JSON.stringify({ issues: [{ id: "1", identifier: "OFF-68", status: "blocked" }] })
          : JSON.stringify({
              id: "1",
              status: "blocked",
              blockedBy: [],
              blocks: [{ id: "2", identifier: "OFF-44", status: "blocked" }],
              monitorNextCheckAt: null,
              unblockDescriptor: descriptor,
            }),
    }),
  });
  const [issue] = await source.readBlockedIssues();
  assert.deepEqual(issue.blocks, [{ id: "2", identifier: "OFF-44", status: "blocked" }]);
  assert.deepEqual(issue.unblockDescriptor, descriptor);
  assert.equal(issue.monitorNextCheckAt, null);
});

test("a failed read throws rather than reporting an empty board", async () => {
  const source = createIssuesSource({
    baseUrl: "https://example.test",
    apiKey: "key",
    companyId: "co",
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => "down" }),
  });
  await assert.rejects(() => source.readBlockedIssues(), /issues read failed with 503/);
  assert.throws(() => createIssuesSource({ apiKey: "k", companyId: "c" }), /base url/);
  assert.throws(() => createIssuesSource({ baseUrl: "u", companyId: "c" }), /api key/);
  assert.throws(() => createIssuesSource({ baseUrl: "u", apiKey: "k" }), /company id/);
});

test("a payload that is not an array of issues throws rather than scoring zero", async () => {
  const source = createIssuesSource({
    baseUrl: "https://example.test",
    apiKey: "key",
    companyId: "co",
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ nope: 1 }) }),
  });
  await assert.rejects(() => source.readBlockedIssues(), /no array of issues/);
});
