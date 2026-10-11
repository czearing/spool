import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createAdoTransport } from "../../lib/ado-transport.mjs";
import { queryBuilds, queryTimeline } from "../lib/azure-devops.mjs";
import { assessBuilds, requiredTimelineIds } from "../lib/detect.mjs";

const config = {
  organization: "https://dev.azure.com/example/",
  project: "My Project",
  maxBuilds: 10,
  stuckMinutes: 90,
  persistentFailureMinutes: 60,
};
const definition = { id: 123, name: "CI" };
const build = (id, result = "failed") => ({
  id, buildNumber: `build-${id}`, status: "completed", result,
  queueTime: `2026-09-10T0${id}:00:00Z`,
  finishTime: `2026-09-10T0${id}:30:00Z`,
});
const records = [{
  name: "Build", type: "Task", state: "completed", result: "failed",
  issues: [{ message: "Connection lost" }, {}],
}];
const json = (body) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" },
});

test("repeated scans reuse build and completed failure timeline reads without CLI", async (t) => {
  const urls = [];
  const directory = fileURLToPath(new URL(`./.ado-cache-${randomUUID()}/`, import.meta.url));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = new Date("2026-09-10T05:00:00Z").getTime();
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
      assert.ok(init.signal instanceof AbortSignal);
      return json(url.includes("/timeline") ? { records } : {
        value: [build(3), build(2), build(1)],
      });
    },
  };
  for (let scan = 0; scan < 2; scan++) {
    const builds = await queryBuilds(config, definition, options);
    assert.deepEqual(requiredTimelineIds(builds), ["3", "2"]);
    const timelines = {};
    for (const id of requiredTimelineIds(builds)) {
      timelines[id] = await queryTimeline(config, id, { ...options, completed: true });
    }
    const assessment = assessBuilds(builds, timelines, new Date("2026-09-10T05:00:00Z"), config);
    assert.equal(assessment.kind, "infrastructure");
    assert.equal(assessment.actionable, true);
  }
  assert.equal(urls.length, 3, "one build list and only two failure timelines across repeated scans");
  assert.equal(urls[0].pathname, "/example/My%20Project/_apis/build/builds");
  assert.equal(urls[0].searchParams.get("definitions"), "123");
  assert.equal(urls[0].searchParams.get("$top"), "10");
  assert.equal(urls[0].searchParams.get("api-version"), "7.1");
  assert.deepEqual(urls.slice(1).map(({ pathname }) => pathname), [
    "/example/My%20Project/_apis/build/builds/3/timeline",
    "/example/My%20Project/_apis/build/builds/2/timeline",
  ]);
  clock += 300_000;
  const builds = await queryBuilds(config, definition, options);
  for (const id of requiredTimelineIds(builds)) {
    await queryTimeline(config, id, { ...options, completed: true });
  }
  assert.equal(urls.length, 4, "next five-minute scan only refreshes the build list");
  clock += 86_400_000;
  await queryTimeline(config, "3", { ...options, completed: true });
  assert.equal(urls.length, 5, "completed timeline cache expires after one day");
});

test("unfinished timelines are never cached", async () => {
  let calls = 0;
  const options = {
    token: "fixture-token",
    fetchImpl: async () => { calls++; return json({ records }); },
  };
  await queryTimeline(config, 7, options);
  await queryTimeline(config, 7, options);
  assert.equal(calls, 2);
});

test("preserves legacy injected execute fixtures and build/timeline normalization", async () => {
  const builds = await queryBuilds(config, definition, async (args) => {
    assert.ok(args.includes("definitions=123"));
    assert.ok(args.includes("$top=10"));
    return JSON.stringify({ value: [build(1)] });
  });
  assert.equal(builds[0].id, "1");
  assert.equal(builds[0].definitionId, "123");
  assert.equal(builds[0].number, "build-1");
  const timeline = await queryTimeline(config, "1", () => JSON.stringify({ records }));
  assert.deepEqual(timeline, [{ name: "Build", type: "Task", state: "completed",
    result: "failed", issues: ["Connection lost"] }]);
});

for (const [name, query] of [
  ["build", (options) => queryBuilds(config, definition, options)],
  ["timeline", (options) => queryTimeline(config, 1, { ...options, completed: true })],
]) {
  test(`${name} query propagates async timeout errors`, async () => {
    const timeout = Object.assign(new Error("HTTP deadline expired"), { name: "TimeoutError" });
    await assert.rejects(query({
      token: "fixture-token",
      fetchImpl: async () => { throw timeout; },
    }), (error) => error === timeout);
  });

  test(`${name} query preserves throttle status and Retry-After`, async () => {
    let calls = 0;
    await assert.rejects(query({
      token: "fixture-token",
      fetchImpl: async () => {
        calls++;
        return new Response(null, { status: 429, headers: { "retry-after": "90" } });
      },
    }), (error) => error.status === 429 && error.retryAfterMs === 90_000);
    assert.equal(calls, 1);
  });
}
