import assert from "node:assert/strict";
import test from "node:test";

import { createQueue, queueCredentials, reviewerIsBusy } from "../lib/queue.mjs";

const COMPLETE = {
  PAPERCLIP_API_URL: "http://127.0.0.1:3400",
  PAPERCLIP_API_KEY: "key",
  PAPERCLIP_COMPANY_ID: "company",
  PAPERCLIP_RUN_ID: "run",
};

test("complete credentials are read from the environment", () => {
  const credentials = queueCredentials(COMPLETE);
  assert.deepEqual(credentials.missing, []);
  assert.equal(credentials.baseUrl, "http://127.0.0.1:3400");
  assert.equal(credentials.runId, "run");
});

test("a missing credential is named rather than discovered at the first write", () => {
  const credentials = queueCredentials({ PAPERCLIP_API_URL: "http://127.0.0.1:3400" }, {}, null);
  assert.deepEqual(credentials.missing, ["PAPERCLIP_COMPANY_ID"]);
});

test("a runner without credentials refuses to start rather than polling silently", () => {
  assert.throws(
    () => createQueue({}, { PAPERCLIP_API_URL: "http://127.0.0.1:3400" }, null),
    /the queue is unreachable without PAPERCLIP_COMPANY_ID/,
  );
});

test("a runner with credentials gets a usable queue", () => {
  const queue = createQueue({}, COMPLETE);
  for (const method of ["createIssue", "getIssue", "listIssues", "updateIssue", "cancelIssue"]) {
    assert.equal(typeof queue[method], "function", `queue is missing ${method}`);
  }
});

test("reviewer live-run gate is agent scoped and includes queued continuations", async () => {
  const credentials = { baseUrl: "http://fixture/api/", companyId: "company", apiKey: "fixture", missing: [] };
  for (const status of ["queued", "running"]) {
    assert.equal(await reviewerIsBusy({ agentId: "reviewer" }, async (url, options) => {
      assert.equal(url, "http://fixture/api/companies/company/live-runs");
      assert.equal(options.headers.Authorization, "Bearer fixture");
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(JSON.stringify([{ agentId: "reviewer", status }]));
    }, credentials), true);
  }
  assert.equal(await reviewerIsBusy({ agentId: "reviewer" }, async () => (
    new Response(JSON.stringify([{ agentId: "other", status: "running" }]))
  ), credentials), false);
});

test("live-run outages and malformed responses cannot look like an idle reviewer", async () => {
  const credentials = { baseUrl: "http://fixture", companyId: "company", missing: [] };
  await assert.rejects(reviewerIsBusy({}, async () => new Response("", { status: 503 }), credentials), /HTTP 503/);
  await assert.rejects(reviewerIsBusy({}, async () => new Response("{}"), credentials), /Invalid Paperclip/);
});
