/**
 * Shared fixtures for the pipeline tests.
 *
 * Fake Azure DevOps and harness clients rather than a live clone, so the wiring can be driven
 * exhaustively and deterministically. Kept in one place because the survey and job suites must
 * agree on the shape of a pull request or they would test different systems.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const NOW = "2026-03-01T12:00:00.000Z";

/** A fresh telemetry file per test, so one test's history cannot satisfy another's assertion. */
export function scratch() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "updater-")), "jobs.jsonl");
}

export function baseConfig(telemetryFile) {
  return {
    telemetryFile,
    harnessApiUrl: "http://harness.test",
    harnessProjectId: "office-bohemia-repo-1",
    agentId: "pr-updater",
    repoRoot: "C:\\clone",
    quietMinutes: 10,
    retryMinutes: 120,
    botAccounts: [],
    authorAccount: "caleb@microsoft.com",
  };
}

/**
 * A stand-in for the harness project listing, which is where agent status actually lives.
 *
 * Tests must state what the agent is doing rather than let the gate fall back to its safe answer:
 * an unreachable harness reports busy, so a suite that skipped this would pass while asserting
 * nothing about dispatch.
 */
export function harnessStatus(status = "idle", agentId = "pr-updater") {
  return async () => ({
    ok: true,
    headers: { get: () => "application/json" },
    json: async () => [
      { id: "other-project", agents: [] },
      { id: "office-bohemia-repo-1", agents: [{ id: agentId, status, topic: status === "working" ? "dashboard-message" : null }] },
    ],
  });
}

/** Harness reporting the agent free, which is what most tests mean by "nothing in the way". */
export const idleHarness = { fetchImpl: harnessStatus("idle") };

export function fakeAdo({ prs, threads = {}, builds = {}, requeued = [], closed = [] }) {
  return {
    listOwnPullRequests: async () => prs,
    listThreads: async (config, id) => threads[id] || [],
    listBuilds: async (config, id) => builds[id] || [],
    requeuePolicy: async (config, evaluationId) => {
      requeued.push(evaluationId);
      return true;
    },
    updateThreadStatus: async (config, prId, threadId, status) => {
      closed.push({ prId, threadId, status });
      return true;
    },
  };
}

/** A human comment thread, the only kind that is allowed to wake the agent. */
export function humanThread(publishedDate, id = 1) {
  return {
    id,
    status: "active",
    comments: [{
      commentType: "text",
      content: "rename this",
      publishedDate,
      author: { displayName: "Christian", uniqueName: "chgonz@microsoft.com", id: "h1" },
    }],
  };
}

export const conflicted = {
  id: "5622136",
  title: "Notebook composer",
  branch: "user/caleb/composer",
  mergeStatus: "conflicts",
  sourceCommit: "abc",
  isDraft: false,
  url: "https://example/pr/5622136",
};
