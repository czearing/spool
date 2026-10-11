/**
 * The dashboard's rendering contract.
 *
 * Asserted rather than eyeballed because the page is read while something is broken, and the two
 * failure modes that matter are silent: a run whose transcript never appears, and untrusted text
 * from a branch name or a reviewer comment reaching the page unescaped.
 */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { readActions } from "../lib/activity.mjs";
import { owners } from "../lib/ownership.mjs";
import { createFleetDashboardLoader, loadFleetDashboardData, renderDashboard, renderHistory, renderJobDetail, renderSummary, renderAdoMetrics } from "../lib/dashboard.mjs";
import { createDashboardHandler } from "../lib/dashboard-handler.mjs";
import { readAdoMetrics } from "../../lib/ado-transport.mjs";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

function fixture(prefix) {
  const dir = path.resolve("test-runtime", `${prefix}-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const summary = { total: 2, queued: 0, running: 1, done: 1, failed: 0, stalled: 0, medianSetupMs: 2000 };

test("preparation holds and verification waits are not agent executions", () => {
  assert.equal(owners([
    { jobId: "held", prId: "1", state: "blocked", at: "2026-09-18T00:00:00Z" },
    { jobId: "checking", prId: "2", state: "verifying", at: "2026-09-18T00:00:00Z" },
  ]).size, 0);
  assert.equal(owners([{ jobId: "live", prId: "3", state: "dispatched", at: "2026-09-21T00:00:00Z" }]).get("3").actor, "agent");
});

const status = {
  open: 2,
  actionable: 1,
  lastScan: "2026-03-01T12:00:00.000Z",
  pullRequests: [
    {
      id: "5626012",
      title: "Composer",
      url: "https://example/pr/5626012",
      branch: "user/caleb/composer",
      mergeStatus: "succeeded",
      build: { state: "failed", label: "failing: Compliance", failing: ["Compliance"] },
      ready: false,
      trigger: "build",
      reason: "Compliance failed twice",
    },
    {
      id: "5634985",
      title: "Command bar",
      url: "https://example/pr/5634985",
      branch: "user/caleb/command-bar",
      mergeStatus: "succeeded",
      build: { state: "passed", label: "4/4 passed" },
      ready: true,
      trigger: null,
      reason: "nothing outstanding",
    },
  ],
};

const jobs = [
  {
    jobId: "j1",
    state: "done",
    prId: "5622136",
    prUrl: "https://example/pr/5622136",
    trigger: "conflict",
    reason: "merge conflict",
    queuedAt: "2026-03-01T11:00:00.000Z",
    at: "2026-03-01T11:20:00.000Z",
    doneAt: "2026-03-01T11:20:00.000Z",
    setupMs: 58_000,
    agentMs: 900_000,
    steps: { totalMs: 58_000, merge: 40_000, checkout: 18_000 },
    outcome: "completed",
    conversation: "rebased and pushed <script>alert(1)</script>",
  },
  {
    jobId: "j2",
    state: "dispatched",
    prId: "5626012",
    trigger: "build",
    reason: "Compliance failed twice",
    queuedAt: "2026-03-01T11:55:00.000Z",
    at: "2026-03-01T11:56:00.000Z",
  },
];

const page = renderDashboard({
  lazy: false,
  status,
  jobs,
  actions: [{ at: "2026-03-01T11:44:00.000Z", event: "build_requeued", prId: "5626012", detail: "requeued Compliance 54073183", failed: false }],
  summary,
  now: Date.parse("2026-03-01T12:00:00.000Z"),
});

test("the queued column is gone from the watch table", () => {
  const header = page.slice(page.indexOf("Watched pull requests"), page.indexOf("Activity"));
  assert.ok(!header.includes("<th>Queued</th>"), "watch table must not carry a queued column");
  assert.ok(header.includes("<th>Build</th>"));
});

test("build health is shown per pull request", () => {
  assert.ok(page.includes("failing: Compliance"));
  assert.ok(page.includes("4/4 passed"));
});

test("a mergeable pull request is highlighted", () => {
  assert.ok(page.includes('class="ready"'));
  assert.ok(page.includes("ready to merge"));
});

test("prior runs expose timings and the transcript", () => {
  assert.ok(page.includes("<details class=\"ev\">"), "history is an accordion");
  assert.ok(page.includes("repo setup"));
  assert.ok(page.includes("agent work"));
  assert.ok(page.includes("15m 0s"), "agent time is rendered");
  assert.ok(page.includes("merge 40.0s"), "per-step breakdown is rendered");
  assert.ok(page.includes("rebased and pushed"));
});

test("the transcript is escaped", () => {
  assert.ok(!page.includes("<script>alert(1)</script>"));
  assert.ok(page.includes("&lt;script&gt;"));
});

test("a dispatched job marks its pull request as held by the agent", () => {
  const watch = page.slice(page.indexOf("Watched pull requests"), page.indexOf("Activity"));
  assert.ok(watch.includes("held held-agent"), "the row carries the agent highlight");
  assert.ok(watch.includes("agent working"), "ownership is stated in words, not colour alone");
  assert.ok(!watch.includes("held-script"), "a dispatched job is not script-held");
});

test("a job still being prepared marks its pull request as held by the script", () => {
  const preparing = renderDashboard({
    status,
    jobs: [{ jobId: "j3", state: "preparing", prId: "5626012", queuedAt: "2026-03-01T11:58:00.000Z", at: "2026-03-01T11:58:00.000Z" }],
    actions: [],
    summary,
    now: Date.parse("2026-03-01T12:00:00.000Z"),
  });
  assert.ok(preparing.includes("held held-script"), "the row carries the script highlight");
  assert.ok(preparing.includes("script preparing"), "the script's phase is named");
  assert.ok(preparing.includes("2m 0s"), "the elapsed time is shown so a stuck job is visible");
});

test("an in-flight job is not listed as a past event", () => {
  const log = page.slice(page.indexOf("<h2>Activity"));
  assert.ok(!log.includes("Compliance failed twice"), "the dispatched job's own row is absent");
  assert.ok(log.includes("5622136"), "a finished run is a past event");
});

test("runs and script actions share one newest-first list", () => {
  const log = page.slice(page.indexOf("<h2>Activity"));
  assert.equal(page.indexOf("Prior runs"), -1, "the separate history section is gone");
  assert.equal(page.indexOf("Script actions"), -1, "the separate actions section is gone");
  assert.ok(log.indexOf("requeued Compliance") < log.indexOf("5622136"), "11:44 outranks 11:20, newest first");
  assert.ok(log.includes("who-agent") && log.includes("who-script"), "each row names its actor");
});

test("script actions are listed", () => {
  assert.ok(page.includes("requeued Compliance 54073183"));
});

test("a repeated cycle failure collapses to one classified row", () => {
  const file = path.join(fixture("collapse"), "activity.jsonl");
  const stack = "Azure DevOps returned text/html rather than JSON, which means the token was not accepted\n  at requestJson\n  at survey";
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ timestamp: "2026-03-01T11:00:00.000Z", event: "cycle_failed", error: stack }),
      JSON.stringify({ timestamp: "2026-03-01T11:05:00.000Z", event: "cycle_failed", error: stack }),
      JSON.stringify({ timestamp: "2026-03-01T11:10:00.000Z", event: "cycle_failed", error: stack }),
    ].join("\n"),
  );
  const actions = readActions(file);
  assert.equal(actions.length, 1, "three identical failures are one row");
  assert.equal(actions[0].count, 3);
  assert.ok(!actions[0].detail.includes("at requestJson"), "the stack trace is not rendered");
  assert.ok(actions[0].detail.includes("authentication has expired"), "the outage is named instead");
  const html = renderDashboard({ status, jobs: [], actions, summary, now: Date.parse("2026-03-01T12:00:00.000Z") });
  assert.ok(html.includes("&times;3"), "the repeat count is shown");
});

test("the activity log folds into readable actions, newest first", () => {
  const file = path.join(fixture("activity"), "activity.jsonl");
  fs.writeFileSync(
    file,
    [
      '{"timestamp":"2026-03-01T11:00:00.000Z","event":"survey","open":2}',
      '{"timestamp":"2026-03-01T11:01:00.000Z","event":"build_requeued","pr":"5626012","build":1,"name":"Compliance"}',
      "not json",
      '{"timestamp":"2026-03-01T11:02:00.000Z","event":"build_requeue_failed","pr":"5626012","build":2,"name":"CI","error":"403"}',
    ].join("\n"),
  );
  const actions = readActions(file);
  assert.equal(actions.length, 2, "survey noise and unparseable lines are dropped");
  assert.equal(actions[0].event, "build_requeue_failed");
  assert.equal(actions[0].failed, true);
  assert.ok(actions[1].detail.includes("Compliance"));
});

test("loadFleetDashboardData aggregates multiple runners into one status and history", () => {
  const tmpRoot = fixture("fleet");
  const r1Dir = path.join(tmpRoot, "pr-updater");
  const r2Dir = path.join(tmpRoot, "pr-updater-2");
  fs.mkdirSync(path.join(r1Dir, ".runner"), { recursive: true });
  fs.mkdirSync(path.join(r2Dir, ".runner"), { recursive: true });

  fs.writeFileSync(
    path.join(r1Dir, ".runner", "status.json"),
    JSON.stringify({
      agent: "pr-updater-1",
      pid: 1001,
      lastScan: "2026-03-01T12:00:00.000Z",
      holding: "working on 5626012",
      pullRequests: [{ id: "5626012", title: "Even PR", trigger: "build", ready: false }],
    }),
  );
  fs.writeFileSync(
    path.join(r2Dir, ".runner", "status.json"),
    JSON.stringify({
      agent: "pr-updater-2",
      pid: 1002,
      lastScan: "2026-03-01T12:01:00.000Z",
      holding: null,
      pullRequests: [{ id: "5634985", title: "Odd PR", trigger: null, ready: true }],
    }),
  );

  fs.writeFileSync(
    path.join(r1Dir, ".runner", "jobs.jsonl"),
    JSON.stringify({ jobId: "j-r1", state: "done", prId: "5626012", at: "2026-03-01T11:50:00.000Z" }) + "\n",
  );
  fs.writeFileSync(
    path.join(r2Dir, ".runner", "jobs.jsonl"),
    JSON.stringify({ jobId: "j-r2", state: "done", prId: "5634985", at: "2026-03-01T11:55:00.000Z" }) + "\n",
  );

  const fleet = loadFleetDashboardData(r1Dir);
  assert.equal(fleet.status.open, 2, "both pull requests are present");
  assert.equal(fleet.status.actionable, 1, "actionable count is calculated");
  assert.equal(fleet.status.pullRequests.length, 2);
  assert.equal(fleet.status.lastScan, "2026-03-01T12:00:00.000Z", "oldest scan cannot be hidden by a fresh sibling");
  assert.equal(fleet.status.latestScan, "2026-03-01T12:01:00.000Z");
  assert.ok(fleet.status.holding.includes("pr-updater-1: working on 5626012"));
  assert.equal(fleet.jobs.length, 2, "both jobs are merged");
  assert.equal(fleet.jobs[0].jobId, "j-r2", "jobs sorted newest first");

  const rendered = renderDashboard(fleet);
  assert.ok(rendered.includes("5626012"));
  assert.ok(rendered.includes("5634985"));
  assert.ok(rendered.includes("pr-updater-1, pr-updater-2"));
});

function runnerFixture() {
  const directory = path.join(fixture("dashboard"), "pr-updater");
  const runtime = path.join(directory, ".runner");
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, "status.json"), JSON.stringify(status));
  fs.writeFileSync(path.join(runtime, "jobs.jsonl"), jobs.map((job) => JSON.stringify(job)).join("\n") + "\n");
  fs.writeFileSync(path.join(runtime, "activity.jsonl"), "");
  return { directory, runtime, load: createFleetDashboardLoader() };
}

test("actionable counts use the owning lane even when a newer sibling still detects the trigger", () => {
  const { directory, runtime, load } = runnerFixture();
  fs.writeFileSync(path.join(runtime, "status.json"), JSON.stringify({
    lastScan: "2026-09-14T12:00:00Z",
    pullRequests: [
      { id: "7", trigger: "build", reason: "Current build failed", dispatchOwner: true, actionable: false, dispatchHold: "Feedback update completed; awaiting new feedback" },
      { id: "8", trigger: "review", dispatchOwner: false, actionable: false },
    ],
  }));
  const sibling = path.join(path.dirname(directory), "pr-updater-2", ".runner");
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, "status.json"), JSON.stringify({
    lastScan: "2026-09-14T12:01:00Z",
    pullRequests: [
      { id: "7", trigger: "review", reason: "Outdated feedback", dispatchOwner: false, actionable: true },
      { id: "8", trigger: "review", dispatchOwner: true, actionable: true },
    ],
  }));
  const fleet = load(directory);
  assert.equal(fleet.status.actionable, 1);
  assert.equal(fleet.status.pullRequests.find((pr) => pr.id === "7").actionable, false);
  assert.equal(fleet.status.pullRequests.find((pr) => pr.id === "7").trigger, "build");
  assert.equal(fleet.status.pullRequests.find((pr) => pr.id === "7").reason, "Current build failed");
  assert.match(renderSummary(fleet), /recorded history:/);
});

function request(handler, url, method = "GET") {
  const result = {};
  result.completed = handler({ url, method }, {
    writeHead(code, headers) { result.code = code; result.headers = headers; },
    end(body) { result.body = body; },
  });
  return result;
}

test("new PR heads never inherit an older owning-lane dispatch decision", () => {
  const { directory, runtime, load } = runnerFixture();
  fs.writeFileSync(path.join(runtime, "status.json"), JSON.stringify({
    lastScan: "2026-09-21T12:00:00Z",
    pullRequests: [{ id: "7", sourceCommit: "old", dispatchOwner: true, trigger: "build", actionable: true }],
  }));
  const sibling = path.join(path.dirname(directory), "pr-updater-2", ".runner");
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, "status.json"), JSON.stringify({
    lastScan: "2026-09-21T12:01:00Z",
    pullRequests: [{ id: "7", sourceCommit: "new", dispatchOwner: false, trigger: null, actionable: false }],
  }));
  const row = load(directory).status.pullRequests[0];
  assert.equal(row.sourceCommit, "new");
  assert.equal(row.trigger, null);
  assert.equal(row.actionable, false);
  assert.match(row.dispatchHold, /Awaiting owning lane survey/);
});

test("unchanged requests reuse parses and aggregation; only changed files are parsed", () => {
  const { directory, runtime, load } = runnerFixture();
  const initial = load(directory);
  assert.equal(load.stats.fileReads, 3);
  assert.equal(load.stats.aggregations, 1);
  const repeat = load(directory);
  assert.strictEqual(repeat.jobs, initial.jobs);
  assert.equal(load.stats.fileReads, 3);
  assert.equal(load.stats.aggregations, 1);
  fs.appendFileSync(path.join(runtime, "jobs.jsonl"), JSON.stringify({ jobId: "j2", state: "done", at: "2026-03-01T13:00:00Z" }) + "\n");
  assert.equal(load(directory).jobs[0].state, "done");
  assert.equal(load.stats.fileReads, 4, "the unchanged status and activity files are not read again");
  fs.appendFileSync(path.join(runtime, "activity.jsonl"), JSON.stringify({ event: "runner_started", timestamp: "2026-03-01T13:01:00Z" }) + "\n");
  assert.equal(load(directory).actions.length, 1);
  assert.equal(load.stats.fileReads, 5);
});

test("truncation, same-length replacement, deletion and partial-write recovery invalidate cached files", () => {
  const { directory, runtime, load } = runnerFixture();
  const file = path.join(runtime, "jobs.jsonl");
  load(directory);
  fs.writeFileSync(file, '{"jobId":"new","state":"queued"}\n');
  assert.deepEqual(load(directory).jobs.map((job) => job.jobId), ["new"]);
  const replacement = path.join(runtime, "replacement.jsonl");
  const stat = fs.statSync(file);
  fs.writeFileSync(replacement, '{"jobId":"old","state":"queued"}\n');
  fs.utimesSync(replacement, stat.atime, stat.mtime);
  fs.renameSync(replacement, file);
  assert.deepEqual(load(directory).jobs.map((job) => job.jobId), ["old"]);
  fs.appendFileSync(file, '{"jobId":"recovered","state":');
  assert.equal(load(directory).jobs.length, 1);
  fs.appendFileSync(file, '"done"}\n');
  assert.equal(load(directory).jobs.length, 2);
  fs.unlinkSync(file);
  assert.equal(load(directory).jobs.length, 0);
  fs.writeFileSync(file, '{"jobId":"restored","state":"done"}\n');
  assert.equal(load(directory).jobs[0].jobId, "restored");
});

test("old active jobs survive more than 150 newer completions and history is paginated lazily", () => {
  const { directory, runtime, load } = runnerFixture();
  const active = { jobId: "old-active", prId: "absent-from-watch", state: "dispatched", at: "2020-01-01T00:00:00Z" };
  const finished = Array.from({ length: 180 }, (_, index) => ({
    jobId: `finished-${index}`, prId: `finished-pr-${index}`, state: "failed",
    at: new Date(Date.UTC(2026, 2, 1, 0, index)).toISOString(),
    error: "FULL-ERROR-" + "x".repeat(4000), detail: "FULL-DETAIL", conversation: "<script>evil()</script>",
  }));
  fs.writeFileSync(path.join(runtime, "jobs.jsonl"), [active, ...finished].map((job) => JSON.stringify(job)).join("\n"));
  const fleet = load(directory);
  assert.equal(fleet.jobs.length, 181);
  assert.equal(fleet.summary.total, 181);
  assert.ok(fleet.jobs.some((job) => job.jobId === "old-active"), "active telemetry remains retained for ownership and diagnostics");
  const html = renderDashboard(fleet);
  assert.doesNotMatch(html, /Active jobs|No active jobs recorded|absent-from-watch|old-active/);
  assert.doesNotMatch(html, /FULL-ERROR|FULL-DETAIL|evil\(\)/);
  assert.equal(html.split('data-job-url=').length - 1, 20);
  assert.match(html, /Older history/);
  assert.doesNotMatch(html, /http-equiv="refresh"/);
  assert.match(renderHistory(fleet, 160), /finished-0/);
  assert.ok(Buffer.byteLength(html) < 40_000);
  assert.ok(Buffer.byteLength(renderSummary(fleet)) < 8_000);
  const details = renderJobDetail(finished[0]);
  assert.match(details, /FULL-ERROR/);
  assert.match(details, /FULL-DETAIL/);
  assert.match(details, /&lt;script&gt;evil\(\)&lt;\/script&gt;/);
  assert.ok(details.includes(finished[0].error), "full recorded errors are not truncated");
});

test("exact routing, unsupported methods, health and favicon do no telemetry work", () => {
  let loads = 0;
  const handler = createDashboardHandler("unused", { load() { loads++; return { status, jobs, actions: [], summary }; } });
  for (const url of ["/unknown", "/jobs.json.evil", "/jobs.json/extra", "/favicon.ico/extra", "/summary.json-extra"]) {
    assert.equal(request(handler, url).code, 404);
  }
  assert.equal(request(handler, "/health").code, 200);
  assert.match(request(handler, "/health").body, /not runner health/);
  assert.equal(request(handler, "/favicon.ico").code, 204);
  assert.equal(request(handler, "/", "POST").code, 405);
  assert.equal(request(handler, "/job").code, 400);
  assert.equal(request(handler, "/history?offset=-1").code, 400);
  assert.equal(request(handler, "/history?offset=NaN").code, 400);
  assert.equal(request(handler, "/", "HEAD").body, "");
  assert.equal(loads, 0);
  assert.equal(request(handler, "/?refresh=yes").code, 200);
  assert.equal(loads, 1);
});

test("summary is small, details are escaped and raw export retains full evidence", () => {
  const { directory, load } = runnerFixture();
  const handler = createDashboardHandler(directory, { load });
  const home = request(handler, "/");
  assert.equal(home.code, 200);
  assert.doesNotMatch(home.body, /rebased and pushed/);
  assert.match(home.body, /data-job-url/);
  const refreshed = request(handler, "/summary.json");
  assert.equal(refreshed.code, 200);
  assert.ok(!("jobs" in JSON.parse(refreshed.body)));
  assert.doesNotMatch(refreshed.body, /rebased and pushed/);
  const detail = request(handler, "/job?id=j1&fragment=1");
  assert.equal(detail.code, 200);
  assert.match(detail.body, /rebased and pushed &lt;script&gt;/);
  assert.equal(request(handler, "/job?id=missing").code, 404);
  assert.equal(request(handler, "/job?id=..%2Fstatus.json").code, 404);
  assert.equal(request(handler, "/history?offset=0").code, 200);
  const raw = JSON.parse(request(handler, "/jobs.json?download=1").body);
  assert.equal(raw.jobs.find((job) => job.jobId === "j1").conversation, jobs[0].conversation);
  assert.equal(load.stats.fileReads, 3);
  assert.equal(load.stats.aggregations, 1);
});

test("detail links and PR URLs do not allow active HTML or javascript URLs", () => {
  const malicious = { ...jobs[0], jobId: '"><script>bad()</script>', prUrl: "javascript:bad()", outcome: "<img src=x onerror=bad()>" };
  const html = renderDashboard({ status: { ...status, pullRequests: [{ id: 1, url: "javascript:bad()", title: "<img>" }] },
    jobs: [malicious], summary, lazy: true });
  assert.doesNotMatch(html, /href="javascript:|<img|<script>bad/);
  assert.match(html, /%3Cscript%3E/);
  assert.match(html, /&lt;img/);
});

test("missing, invalid and repaired status never fabricates a scan or healthy fleet", () => {
  const { directory, runtime, load } = runnerFixture();
  const file = path.join(runtime, "status.json");
  fs.unlinkSync(file);
  let fleet = load(directory);
  assert.equal(fleet.status.lastScan, null);
  assert.equal(fleet.status.runners[0].health, "unknown");
  assert.notEqual(fleet.status.health, "healthy");
  assert.match(renderDashboard({ ...fleet, lazy: true }), /status.json unavailable/);
  fs.writeFileSync(file, '{"pullRequests":{}}');
  fleet = load(directory);
  assert.equal(fleet.status.lastScan, null);
  assert.match(fleet.status.runners[0].statusError, /invalid status/);
  fs.writeFileSync(file, JSON.stringify(status));
  assert.equal(load(directory, { now: Date.parse(status.lastScan) }).status.runners[0].health, "healthy");
});

test("cached status and jobs still age into stale and stalled without file changes", () => {
  const { directory, load } = runnerFixture();
  const now = Date.parse(status.lastScan);
  const fresh = load(directory, { now });
  assert.equal(fresh.status.runners[0].health, "healthy");
  assert.equal(fresh.summary.stalled, 0);
  const stale = load(directory, { now: now + 4 * 60 * 60_000 });
  assert.equal(stale.status.runners[0].health, "stale");
  assert.equal(stale.summary.stalled, 1);
  assert.equal(load.stats.fileReads, 3);
  assert.equal(load.stats.aggregations, 1);
});

test("ADO endpoint reads fresh local files without fleet aggregation or network calls", async (t) => {
  const root = fixture("ado-metrics");
  const scope = path.join(root, "shared-scope");
  fs.mkdirSync(scope);
  const file = path.join(scope, "metrics.json");
  const counters = { networkRequests: 23, cacheHits: 23, cacheMisses: 23, errors: 1, throttles: 0,
    authRefreshes: 1, responseBytes: 4096, durationMs: 1000, endpoints: { pullRequests: { statuses: { 200: 23 } } },
    lastRateLimit: { "x-ratelimit-remaining": "99" }, updatedAt: "2026-09-10T20:00:00Z" };
  fs.writeFileSync(file, JSON.stringify(counters));
  fs.writeFileSync(path.join(scope, "control.json"), '{"notBefore":1234}');
  t.mock.method(globalThis, "fetch", () => assert.fail("metrics must not contact ADO"));
  let reads = 0;
  const handler = createDashboardHandler("unused", {
    load() { assert.fail("metrics must not aggregate job logs"); },
    metrics() { reads++; return readAdoMetrics(root); },
  });
  assert.equal(request(handler, "/ado.json-extra").code, 404);
  assert.equal(request(handler, "/ado.json", "HEAD").code, 200);
  assert.equal(request(handler, "/ado.json", "POST").code, 405);
  assert.equal(reads, 0);
  const first = request(handler, "/ado.json");
  await first.completed;
  assert.equal(first.code, 200);
  const data = JSON.parse(first.body);
  assert.equal(data.available, true);
  assert.equal(data.scopes.length, 1);
  assert.equal(data.scopes[0].networkRequests, 23);
  assert.equal(data.scopes[0].notBefore, 1234);
  assert.deepEqual(data.scopes[0].lastRateLimit, counters.lastRateLimit);
  assert.deepEqual(data.scopes[0].endpoints, counters.endpoints);
  assert.match(data.html, /Cache hits \/ misses/);
  fs.writeFileSync(file, JSON.stringify({ ...counters, cacheHits: 24 }));
  const next = request(handler, "/ado.json");
  await next.completed;
  assert.equal(JSON.parse(next.body).scopes[0].cacheHits, 24);
  assert.equal(reads, 2, "metrics are fresh rather than the previous status snapshot");
  fs.unlinkSync(file);
  const missing = request(handler, "/ado.json");
  await missing.completed;
  assert.equal(JSON.parse(missing.body).available, false);
  assert.match(JSON.parse(missing.body).html, /metrics unavailable/);
});

test("ADO missing counters and read failures are explicit; metrics text is escaped", async () => {
  const handler = createDashboardHandler("unused", { metrics: async () => { throw new Error("private path"); } });
  const response = request(handler, "/ado.json");
  await response.completed;
  assert.equal(response.code, 503);
  assert.equal(JSON.parse(response.body).available, false);
  assert.doesNotMatch(response.body, /private path/);
  assert.match(renderAdoMetrics([]), /unavailable/);
  const html = renderAdoMetrics([{ scope: '"><script>bad()</script>', networkRequests: 1 }]);
  assert.match(html, /unknown/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("fleet ADO snapshot selects the latest runner, without double counting shared scopes", () => {
  const { directory, runtime, load } = runnerFixture();
  const sibling = path.join(path.dirname(directory), "pr-updater-2", ".runner");
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(runtime, "status.json"), JSON.stringify({ ...status,
    ado: [{ scope: "shared", networkRequests: 11, cacheHits: 5 }] }));
  fs.writeFileSync(path.join(sibling, "status.json"), JSON.stringify({ ...status,
    lastScan: "2026-03-01T12:01:00Z", ado: [{ scope: "shared", networkRequests: 23, cacheHits: 7 }] }));
  const fleet = load(directory);
  assert.deepEqual(fleet.status.ado, [{ scope: "shared", networkRequests: 23, cacheHits: 7 }]);
  const html = renderDashboard(fleet);
  assert.doesNotMatch(html, /id="ado-usage"|ADO usage|\/ado.json|refreshAdo|Active jobs/);
  assert.match(html, /fetch\("\/summary.json"/);
  assert.match(renderAdoMetrics(fleet.status.ado), /not summed across runners/);
});
