/**
 * The three defects behind 62 identical prepare failures on one pull request.
 *
 * The build was never broken. lage was scoped by workspace path instead of package name, which
 * exits 1 with "no targets found"; the failure detail was truncated at the first newline in both
 * sinks, so the message that said so was never recorded; and nothing stopped the job retrying
 * every cycle.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listOwnPullRequests } from "../lib/azure-devops.mjs";
import { recentlyFailed, RETRY_COOLDOWN_MS } from "../lib/dispatch-guards.mjs";
import { jobFailed, jobQueued, readJobs } from "../lib/telemetry.mjs";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "updater-prepare-"));
}

test("a failure keeps the tool output that explains it", () => {
  const file = path.join(tempDir(), "jobs.jsonl");
  const error = new Error("Bundle build failed for apps/new-office (exit 1).\nlage: no targets found.");
  jobFailed(file, { jobId: "j1", at: "2026-08-26T17:00:00.000Z", phase: "prepare", error });

  const [row] = readJobs(file, 10);
  // The summary line stays short for the dashboard cell.
  assert.equal(row.error, "Error: Bundle build failed for apps/new-office (exit 1).");
  // The cause is what was missing for 62 failures.
  assert.match(row.detail, /no targets found/);
});

test("a job that just failed to prepare is not retried until the cooldown expires", () => {
  const config = { telemetryFile: path.join(tempDir(), "jobs.jsonl") };
  const jobId = "office-bohemia-repo-1:pr-updater:5626012:build-abc:0";
  jobFailed(config.telemetryFile, {
    jobId,
    at: "2026-08-26T17:00:00.000Z",
    phase: "prepare",
    error: new Error("Bundle build failed"),
  });

  const soon = new Date(Date.parse("2026-08-26T17:05:00.000Z")).toISOString();
  assert.equal(recentlyFailed(config, jobId, soon), true, "five minutes later is still cooling down");

  const later = new Date(Date.parse("2026-08-26T17:00:00.000Z") + RETRY_COOLDOWN_MS + 1000).toISOString();
  assert.equal(recentlyFailed(config, jobId, later), false, "past the cooldown it may be attempted again");

  // The cooldown is per job, so an unrelated pull request is never held back by it.
  assert.equal(recentlyFailed(config, "another-job", soon), false);
});

test("a job that never failed is not held back", () => {
  const config = { telemetryFile: path.join(tempDir(), "jobs.jsonl") };
  jobQueued(config.telemetryFile, {
    jobId: "fresh",
    prId: "1",
    trigger: "agency",
    reason: "1 finding",
    at: "2026-08-26T17:00:00.000Z",
  });

  assert.equal(recentlyFailed(config, "fresh", "2026-08-26T17:01:00.000Z"), false);
});

test("capacity failures retry when actual headroom recovers without weakening the guard", t => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { telemetryFile: path.join(root, "jobs.jsonl"), repoRoot: root, creatorMinimumFreeGiB: 1e12 };
  const jobId = "spool-creator:pr-updater:123:conflict-abc:0";
  jobFailed(config.telemetryFile, { jobId, at: "2026-09-15T23:00:00Z", phase: "prepare",
    error: new Error("Checkout preparation held: 18 GiB available at fixture; 20 GiB required. Feedback remains pending and will be retried after capacity recovers.") });
  assert.equal(recentlyFailed(config, jobId, "2026-09-15T23:01:00Z"), true);
  config.creatorMinimumFreeGiB = 0.001;
  assert.equal(recentlyFailed(config, jobId, "2026-09-15T23:01:00Z"), false);
});

test("an expired token costs one retry, not the whole poll cycle", async () => {
  const config = { organization: "https://dev.azure.com/office", project: "OC", repository: "office-bohemia" };
  const calls = [];
  // The live failure: a sign-in page arrives as HTML with a 200, so the first attempt is rejected.
  const fetchImpl = async (url, init) => {
    calls.push(init.headers.Authorization);
    if (calls.length === 1) {
      return { ok: true, status: 200, headers: { get: () => "text/html; charset=utf-8" } };
    }
    return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ value: [] }) };
  };

  const prs = await listOwnPullRequests(config, {
    token: "stale",
    fetchImpl,
    refresh: async () => "fresh",
  });

  assert.deepEqual(prs, [], "the cycle completes instead of dying on an HTML body");
  assert.equal(calls.length, 2, "exactly one retry");
  assert.match(calls[1], /fresh/, "the retry presents the newly minted token");
});

test("a rejected token is retried once and then reported", async () => {
  const config = { organization: "https://dev.azure.com/office", project: "OC", repository: "office-bohemia" };
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return { ok: true, status: 200, headers: { get: () => "text/html" } };
  };

  await assert.rejects(
    listOwnPullRequests(config, { token: "stale", fetchImpl, refresh: async () => "also-bad" }),
    /token was not accepted/,
    "a credential that is genuinely revoked still fails loudly",
  );
  assert.equal(attempts, 2, "it does not hammer the service");
});
