/**
 * The outage that went unnoticed for an hour.
 *
 * Every runner on the machine lost its Azure DevOps credential at once. The updater stayed up,
 * failed a cycle every five minutes, and overwrote its status file with an error string, which
 * emptied the dashboard's table. A dead monitor therefore looked exactly like a quiet one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { blockedStatus, classifyOutage } from "../lib/outage.mjs";
import { createFleetDashboardLoader, renderDashboard } from "../lib/dashboard.mjs";
import { summarize } from "../lib/telemetry.mjs";

const AUTH = new Error(
  "Azure DevOps returned text/html rather than JSON for https://dev.azure.com/office/OC/_apis/git/repositories/office-bohemia/pullRequests, which means the token was not accepted",
);

test("an expired credential is named, and the command that fixes it is given", () => {
  const outage = classifyOutage(AUTH);
  assert.equal(outage.kind, "auth");
  assert.match(outage.headline, /nothing is being monitored/);
  assert.match(outage.remedy, /^az login --scope /);

  // The other runners phrase the same failure differently, so the marker list must cover them.
  assert.equal(classifyOutage(new Error("ERROR: The requested resource requires user authentication")).kind, "auth");
  assert.equal(classifyOutage(new Error("Azure DevOps rejected the token: 401")).kind, "auth");
});

test("an unrelated failure is not mislabelled as an auth problem", () => {
  const outage = classifyOutage(new Error("getaddrinfo ENOTFOUND dev.azure.com"));
  assert.equal(outage.kind, "error");
  assert.equal(outage.remedy, "", "no command is offered for a fault the operator cannot fix that way");
});

test("a failing cycle keeps the pull requests it was watching", () => {
  const previous = {
    lastScan: "2026-08-26T18:34:01.000Z",
    open: 4,
    pullRequests: [{ id: "5626012", title: "Notebook hero heading" }],
    summary: { total: 3 },
  };

  const status = blockedStatus(previous, AUTH, { pid: 42 });

  // The regression that caused the complaint: this used to be wiped to a bare error string.
  assert.deepEqual(status.pullRequests, previous.pullRequests, "the watch list survives the outage");
  assert.equal(status.open, 4);
  assert.equal(status.blocked.kind, "auth");
  assert.equal(status.blocked.cycles, 1);
  assert.equal(status.staleSince, previous.lastScan);
});

test("consecutive failures accumulate rather than resetting the clock", () => {
  let status = blockedStatus({ lastScan: "2026-08-26T18:34:01.000Z" }, AUTH);
  const first = status.blocked.since;
  status = blockedStatus(status, AUTH);
  status = blockedStatus(status, AUTH);
  assert.equal(status.blocked.cycles, 3, "the operator sees how long it has been down");
  assert.equal(status.blocked.since, first, "since is when it broke, not when it was last retried");
});

test("the dashboard shouts when the runner is up but blind", () => {
  const status = blockedStatus(
    { lastScan: "2026-08-26T18:34:01.000Z", open: 4, actionable: 1, pullRequests: [] },
    AUTH,
  );
  const html = renderDashboard({ status, jobs: [], actions: [], summary: summarize([]) });

  assert.match(html, /MONITORING DOWN/);
  assert.match(html, /az login --scope/);
  assert.match(html, /class="outage"/);
});

test("a healthy runner shows no alarm", () => {
  const status = { lastScan: "2026-08-26T18:34:01.000Z", open: 4, actionable: 1, pullRequests: [] };
  const html = renderDashboard({ status, jobs: [], actions: [], summary: summarize([]) });
  assert.doesNotMatch(html, /MONITORING DOWN/);
});

test("a recovered cycle clears the alarm, because the status is rebuilt from scratch", () => {
  // cycle() writes a fresh object with no `blocked` key, so recovery needs no extra bookkeeping.
  const recovered = { lastScan: "2026-08-26T19:00:00.000Z", open: 4, actionable: 0, pullRequests: [] };
  assert.equal(recovered.blocked, undefined);
  const html = renderDashboard({ status: recovered, jobs: [], actions: [], summary: summarize([]) });
  assert.doesNotMatch(html, /MONITORING DOWN/);
});

test("fleet aggregation preserves a blocked sibling and selects newest PR evidence, not ready or trigger flags", (t) => {
  const root = path.resolve("test-runtime", `outage-${randomUUID()}`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directories = ["pr-updater", "pr-updater-2"].map((name) => path.join(root, name));
  for (const directory of directories) fs.mkdirSync(path.join(directory, ".runner"), { recursive: true });
  const old = blockedStatus({
    agent: "old-runner", lastScan: "2026-08-26T18:00:00.000Z",
    pullRequests: [
      { id: "1", title: "old ready", ready: true, trigger: "build" },
      { id: "2", title: "only seen before outage", trigger: "build" },
    ],
  }, AUTH);
  const fresh = {
    agent: "fresh-runner", lastScan: "2026-08-26T19:00:00.000Z",
    pullRequests: [{ id: "1", title: "new not ready", ready: false, trigger: null }],
  };
  const write = (index, status) => fs.writeFileSync(path.join(directories[index], ".runner", "status.json"), JSON.stringify(status));
  write(0, old);
  write(1, fresh);
  const load = createFleetDashboardLoader();
  const fleet = load(directories[0], { now: Date.parse(fresh.lastScan) });
  assert.deepEqual(fleet.status.runners[0].blocked, old.blocked);
  assert.equal(fleet.status.runners[0].staleSince, old.staleSince);
  assert.equal(fleet.status.runners[0].health, "blocked");
  assert.equal(fleet.status.lastScan, old.lastScan);
  assert.equal(fleet.status.latestScan, fresh.lastScan);
  assert.equal(fleet.status.staleSince, old.staleSince);
  assert.notEqual(fleet.status.health, "healthy");
  assert.equal(fleet.status.blocked.runners[0], "old-runner");
  assert.equal(fleet.status.pullRequests.find((pr) => pr.id === "1").title, "new not ready");
  assert.equal(fleet.status.pullRequests.find((pr) => pr.id === "1").ready, false);
  assert.equal(fleet.status.pullRequests.find((pr) => pr.id === "1").trigger, null);
  assert.equal(fleet.status.pullRequests.length, 2, "outage does not empty the old watch list");
  const html = renderDashboard({ ...fleet, lazy: true });
  assert.match(html, /MONITORING DOWN/);
  assert.match(html, /old-runner/);
  assert.match(html, /az login --scope/);
  assert.match(html, /Stale since/);
  const reversed = load(directories[0], { runnerDirs: directories.toReversed(), now: Date.parse(fresh.lastScan) });
  assert.deepEqual(reversed.status.pullRequests, fleet.status.pullRequests, "discovery order does not affect evidence choice");
  write(0, { ...fresh, agent: "old-runner" });
  const recovered = load(directories[0], { now: Date.parse(fresh.lastScan) });
  assert.equal(recovered.status.blocked, null);
  assert.equal(recovered.status.staleSince, null);
  assert.doesNotMatch(renderDashboard({ ...recovered, lazy: true }), /MONITORING DOWN/);
});

test("a fresh runner cannot hide an undiscovered status or stale sibling", (t) => {
  const root = path.resolve("test-runtime", `freshness-${randomUUID()}`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directories = ["pr-updater", "pr-updater-2", "pr-updater-missing"].map((name) => path.join(root, name));
  for (const directory of directories) fs.mkdirSync(path.join(directory, ".runner"), { recursive: true });
  for (const [index, lastScan] of ["2026-08-26T18:00:00Z", "2026-08-26T19:00:00Z"].entries()) {
    fs.writeFileSync(path.join(directories[index], ".runner", "status.json"), JSON.stringify({ lastScan, pullRequests: [] }));
  }
  const load = createFleetDashboardLoader();
  const fleet = load(directories[0], { now: Date.parse("2026-08-26T19:00:00Z") });
  assert.equal(fleet.status.runners.length, 3);
  assert.equal(fleet.status.runners[0].health, "stale");
  assert.equal(fleet.status.runners[2].health, "unknown");
  assert.equal(fleet.status.lastScan, null);
  assert.notEqual(fleet.status.health, "healthy");
  assert.match(renderDashboard({ ...fleet, lazy: true }), /pr-updater-missing: unknown/);
});
