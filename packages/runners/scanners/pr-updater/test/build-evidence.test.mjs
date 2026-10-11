import assert from "node:assert/strict";
import test from "node:test";
import { listBuilds } from "../lib/azure-devops.mjs";
import { classifyFailures, transientPolicies } from "../lib/build-failures.mjs";

const config = { organization: "https://example.invalid", project: "fixture", projectId: "fixture-id" };
const policy = { evaluationId: "evaluation", status: "rejected", context: { buildId: 42 },
  configuration: { settings: { displayName: "Buddy Build" } } };
const build = { id: 42, status: "completed", result: "canceled" };
const records = [{ type: "Job", result: "canceled", startTime: null,
  issues: [{ type: "error", message: "Remote machine provider issue: The agent did not connect within the alloted time of 45 minute(s)." }] }];

function endpoint({ evaluation = policy, metadata = build, timeline = { records }, unavailable = false } = {}) {
  const requests = [];
  return { requests, token: "fixture-token", fetchImpl: async url => {
    requests.push(url);
    const isTimeline = url.includes("/timeline?");
    if (isTimeline && unavailable) return new Response("unavailable", { status: 503 });
    return Response.json(url.includes("/policy/evaluations?") ? { value: [evaluation] }
      : isTimeline ? timeline : metadata);
  } };
}

test("policy rejection retains its failed gate but gains verified infrastructure evidence", async () => {
  const options = endpoint();
  const [row] = await listBuilds(config, 7, options);
  assert.equal(row.result, "failed");
  assert.equal(row.failureKind, "infrastructure");
  assert.match(row.failureReason, /agent did not connect/);
  assert.equal(options.requests.length, 3);
});

test("passing policies and actual code failures do not request canceled-build timelines", async () => {
  const passed = endpoint({ evaluation: { ...policy, status: "approved" } });
  assert.equal((await listBuilds(config, 7, passed))[0].result, "succeeded");
  assert.equal(passed.requests.length, 1);
  const failed = endpoint({ metadata: { ...build, result: "failed" } });
  assert.equal((await listBuilds(config, 7, failed))[0].failureKind, undefined);
  assert.equal(failed.requests.length, 2);
});

test("manual cancellations are not classified as provisioning failures", async () => {
  const options = endpoint({ timeline: { records: [{ type: "Job", result: "canceled", startTime: null }] } });
  assert.equal((await listBuilds(config, 7, options))[0].failureKind, undefined);
});

test("invalid or unavailable build evidence fails explicitly instead of inventing an infrastructure hold", async () => {
  for (const metadata of [{}, { ...build, id: 43 }]) {
    await assert.rejects(listBuilds(config, 7, endpoint({ metadata })), /Invalid build metadata/);
  }
  await assert.rejects(listBuilds(config, 7, endpoint({ timeline: {} })), /Invalid build timeline/);
  await assert.rejects(listBuilds(config, 7, endpoint({ unavailable: true })), /503/);
});

test("a missing historical build stays rejected without aborting the remaining policy reads or fabricating code failures", async () => {
  const options = { token: "fixture", fetchImpl: async url => {
    if (url.includes("/policy/evaluations?")) return Response.json({ value: [policy,
      { ...policy, evaluationId: "other", context: { buildId: 43 } }] });
    if (url.includes("/42?")) return new Response("missing", { status: 404 });
    return Response.json({ id: 43, status: "completed", result: "failed" });
  } };
  const rows = await listBuilds(config, 7, options);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].result, "failed");
  assert.equal(rows[0].failureKind, "unavailable");
  assert.match(rows[0].failureReason, /404/);
  assert.deepEqual(classifyFailures(rows).requeue, []);
  assert.deepEqual(classifyFailures(rows).escalate, [rows[1]]);
  assert.equal(transientPolicies({ one: [rows[0]], two: [rows[1]] }).size, 0);
});

test("missing canceled-build timeline is held without classifying a provisioning failure", async () => {
  const options = endpoint();
  const original = options.fetchImpl;
  options.fetchImpl = url => url.includes("/timeline?") ? Promise.resolve(new Response("missing", { status: 404 })) : original(url);
  assert.equal((await listBuilds(config, 7, options))[0].failureKind, "unavailable");
});
