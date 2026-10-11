import assert from "node:assert/strict";
import test from "node:test";
import { assessBuilds, assessQueryError, assignmentPrompt, requiredTimelineIds } from "../lib/detect.mjs";

const config = { stuckMinutes: 90, persistentFailureMinutes: 60, flakyCapacityCooldownHours: 24 };
const now = new Date("2026-07-23T22:00:00Z");
const build = (id, result, queueTime, status = "completed") => ({
  id: String(id),
  number: `build-${id}`,
  definitionId: "8228",
  definitionName: "Office Bohemia CI",
  status,
  result,
  queueTime,
  startTime: queueTime,
  finishTime: queueTime,
  sourceBranch: "refs/heads/master",
  sourceVersion: `revision-${id}`,
  url: `https://example.test/build/${id}`,
});
const timeline = (failure) => [{
  name: "Tests",
  result: "failed",
  issues: [`Your build failed on the following packages => [${failure}]`],
}];

test("keeps a recovered build healthy without waking the agent", () => {
  const assessment = assessBuilds([
    build(2, "succeeded", "2026-07-23T21:30:00Z"),
    build(1, "failed", "2026-07-23T21:00:00Z"),
  ], { 1: timeline("@fluidx/conversa test:e2e") }, now, config);
  assert.equal(assessment.kind, "healthy");
  assert.equal(assessment.actionable, false);
});

test("alerts on rotating visual-test failures as flaky", () => {
  const builds = [
    build(2, "failed", "2026-07-23T21:30:00Z"),
    build(1, "failed", "2026-07-23T21:00:00Z"),
  ];
  const assessment = assessBuilds(builds, {
    2: timeline("@fluidx/notebooks test:storywright"),
    1: timeline("@fluidx/loop test:storywright"),
  }, now, config);
  assert.equal(assessment.kind, "flaky");
  assert.equal(assessment.actionable, true);
  assert.deepEqual(requiredTimelineIds(builds), ["2", "1"]);
});

test("distinguishes rotating Jest failures within the same package", () => {
  const builds = [
    build(2, "failed", "2026-07-23T21:30:00Z"),
    build(1, "failed", "2026-07-23T21:00:00Z"),
  ];
  const assessment = assessBuilds(builds, {
    2: [{ name: "Jest Tests", result: "failed", issues: ["packages => [@ms/package] UserCard.test.ts failed"] }],
    1: [{ name: "Jest Tests", result: "failed", issues: ["packages => [@ms/package] Header.test.ts failed"] }],
  }, now, config);
  assert.equal(assessment.kind, "flaky");
  assert.equal(assessment.actionable, true);
});

test("alerts immediately when FlakyTestAssassin reports excluded tests", () => {
  const records = [
    ...timeline("@fluidx/notebooks test:unit"),
    { name: "List Known Flaky Tests", result: "succeeded", issues: ["Storm detected: 8 tests excluded"] },
  ];
  const assessment = assessBuilds([
    build(2, "failed", "2026-07-23T21:30:00Z"),
    build(1, "succeeded", "2026-07-23T21:00:00Z"),
  ], { 2: records }, now, config);
  assert.equal(assessment.kind, "flaky");
  assert.equal(assessment.actionable, true);
  assert.match(assignmentPrompt(assessment), /Storm detected: 8 tests excluded/);
});

test("deduplicates FlakyTestAssassin capacity exhaustion across rotating packages", () => {
  const capacity = "Flaky test cap exceeded (cache fallback): cache contained 3 tests but cap is 2. Only the first 2 will be skipped. 1 test(s) will NOT be skipped.";
  const first = assessBuilds([
    build(2, "failed", "2026-07-23T21:30:00Z"),
  ], {
    2: [
      ...timeline("@fluidx/conversa test:e2e"),
      { name: "List Known Flaky Tests", result: "succeeded", issues: [capacity] },
    ],
  }, now, config);
  const second = assessBuilds([
    build(3, "failed", "2026-07-23T21:40:00Z"),
  ], {
    3: [
      ...timeline("@fluidx/bing-acf-component test:e2e"),
      { name: "List Known Flaky Tests", result: "succeeded", issues: [capacity] },
    ],
  }, now, config);

  assert.equal(first.kind, "flaky_capacity");
  assert.equal(first.key, "flaky_capacity:8228:cap-2-unskipped-1");
  assert.equal(first.key, second.key);
  assert.equal(first.cooldownHours, 24);
});

test("reopens FlakyTestAssassin capacity incidents when unskipped exposure worsens", () => {
  const records = (unskipped) => [
    ...timeline("@fluidx/conversa test:e2e"),
    {
      name: "List Known Flaky Tests",
      result: "succeeded",
      issues: [`Flaky test cap exceeded (cache fallback): cache contained ${unskipped + 2} tests but cap is 2. Only the first 2 will be skipped. ${unskipped} test(s) will NOT be skipped.`],
    },
  ];
  const first = assessBuilds([build(2, "failed", "2026-07-23T21:30:00Z")], { 2: records(1) }, now, config);
  const worse = assessBuilds([build(3, "failed", "2026-07-23T21:40:00Z")], { 3: records(3) }, now, config);

  assert.notEqual(first.key, worse.key);
  assert.equal(worse.key, "flaky_capacity:8228:cap-2-unskipped-3");
});

test("wakes the agent for a repeated deterministic failure", () => {
  const builds = [
    build(2, "failed", "2026-07-23T21:30:00Z"),
    build(1, "failed", "2026-07-23T21:00:00Z"),
  ];
  const assessment = assessBuilds(builds, {
    2: timeline("@ms/package build"),
    1: timeline("@ms/package build"),
  }, now, config);
  assert.equal(assessment.kind, "regression");
  assert.equal(assessment.actionable, true);
  const prompt = assignmentPrompt(assessment);
  assert.equal(prompt.split("\n").length, 5);
  assert.doesNotMatch(prompt, /poll|watcher|workspace|draft PR/i);
});

test("keeps generated assignments limited to incident evidence", () => {
  const assessment = assessBuilds([
    build(2, "failed", "2026-07-23T20:00:00Z"),
    build(1, "succeeded", "2026-07-23T19:00:00Z"),
  ], {
    2: [{ name: "Agent connection", result: "failed", issues: ["Network timeout contacting service"] }],
  }, now, config);
  const prompt = assignmentPrompt(assessment);
  assert.match(prompt, /^Livesite incident: infrastructure/m);
  assert.match(prompt, /^Evidence: Network timeout contacting service/m);
  assert.doesNotMatch(prompt, /instructions|source code|Discord/i);
});

test("deduplicates the same failure signature across new build ids", () => {
  const first = assessBuilds([
    build(2, "failed", "2026-07-23T21:30:00Z"),
    build(1, "failed", "2026-07-23T21:00:00Z"),
  ], { 2: timeline("@ms/package build"), 1: timeline("@ms/package build") }, now, config);
  const second = assessBuilds([
    build(4, "failed", "2026-07-23T21:50:00Z"),
    build(3, "failed", "2026-07-23T21:40:00Z"),
  ], { 4: timeline("@ms/package build"), 3: timeline("@ms/package build") }, now, config);
  assert.equal(first.key, second.key);
});

test("includes FlakyTestAssassin evidence in actionable assignments", () => {
  const builds = [
    build(2, "failed", "2026-07-23T21:30:00Z"),
    build(1, "failed", "2026-07-23T21:00:00Z"),
  ];
  const records = [
    ...timeline("@ms/package build"),
    { name: "List Known Flaky Tests", result: "succeeded", issues: ["Storm detected: 8 tests excluded"] },
  ];
  const assessment = assessBuilds(builds, { 2: records, 1: records }, now, config);
  assert.match(assignmentPrompt(assessment), /FlakyTestAssassin reported: Storm detected/);
});

test("wakes the agent for a stuck build and authentication outage", () => {
  const stuck = assessBuilds([
    build(3, null, "2026-07-23T19:00:00Z", "inProgress"),
  ], {}, now, config);
  assert.equal(stuck.kind, "stuck");
  assert.equal(assessQueryError(new Error("HTTP 203 Azure DevOps Services | Sign In")).kind, "auth_outage");
});

test("alerts on persistent infrastructure failures and repeated cancellations", () => {
  const persistent = assessBuilds([
    build(2, "failed", "2026-07-23T20:00:00Z"),
    build(1, "succeeded", "2026-07-23T19:00:00Z"),
  ], {
    2: [{ name: "Agent connection", result: "failed", issues: ["Network timeout contacting service"] }],
  }, now, config);
  assert.equal(persistent.kind, "infrastructure");
  assert.equal(persistent.actionable, true);

  const canceled = assessBuilds([
    build(3, "canceled", "2026-07-23T21:30:00Z"),
    build(2, "canceled", "2026-07-23T21:00:00Z"),
    build(1, "canceled", "2026-07-23T20:30:00Z"),
  ], {}, now, config);
  assert.equal(canceled.kind, "manual_action");
  assert.equal(canceled.actionable, true);
  assert.equal(assessQueryError(new Error("Unexpected JSON response")).kind, "monitor_error");
});

test("ignores nonblocking task issues in consecutive partiallySucceeded builds", () => {
  const auxiliaryOnly = (task, message) => [
    { name: "Build, Lint, Knip, ownership, and Tests", result: "succeeded", issues: [] },
    { name: task, result: "succeededWithIssues", issues: [message] },
  ];
  const builds = [
    build(2, "partiallySucceeded", "2026-07-23T21:30:00Z"),
    build(1, "partiallySucceeded", "2026-07-23T21:00:00Z"),
  ];
  const timelines = {
    2: auxiliaryOnly("Update pending Bundle Buddy PR comments", "Script failed with exit code: 1"),
    1: auxiliaryOnly("Update pending Eslint Buddy PR comments", "code: ETIMEDOUT"),
  };
  assert.deepEqual(requiredTimelineIds(builds), ["2", "1"]);
  const assessment = assessBuilds(builds, timelines, now, config);
  assert.equal(assessment.actionable, false);
  assert.equal(assessment.kind, "healthy");
});
