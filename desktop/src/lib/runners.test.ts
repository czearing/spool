import { expect, it } from "vitest";
import { isRunnerSnapshot, repositoryActivity, runnerActivity, runnerConnection, type Runner } from "./runners";

const runner: Runner = { id: "livesite", enabled: true, running: true, connected: true, healthy: true,
  stopping: false, phase: "ready", lastRunAt: "2026-10-02T10:00:00Z", lastSuccessAt: "2026-10-02T10:00:00Z", lastRunFailed: false,
  script: "runners\\livesite\\run.mjs", intervalSeconds: 300, activeIntervalSeconds: 300, error: null,
  repository: { mode: "on-demand", state: "unknown", lastUpdatedAt: null, lastAttemptAt: null, error: null } };
const snapshot = { checkedAt: "2026-10-02T10:01:00Z", configured: true, runners: [runner] };
it("distinguishes connection from activity, errors and configured-only runners", () => {
  expect(runnerConnection(runner)).toBe("Connected");
  expect(runnerActivity(runner)).toBe("Idle");
  expect(runnerActivity({ ...runner, phase: "scanning" })).toBe("Running");
  expect(runnerActivity({ ...runner, phase: "degraded", healthy: false })).toBe("Error");
  expect(runnerConnection({ ...runner, connected: false })).toBe("Unconfirmed");
  expect(runnerActivity({ ...runner, connected: false })).toBe("Unknown");
  expect(runnerConnection({ ...runner, connected: false, running: false })).toBe("Offline");
  expect(runnerActivity({ ...runner, running: false, enabled: false })).toBe("Disabled");
  expect(runnerActivity({ ...runner, stopping: true, healthy: false })).toBe("Stopping");
});
it("rejects inconsistent, duplicate, invalid-date and unscoped status payloads", () => {
  expect(isRunnerSnapshot(snapshot)).toBe(true);
  for (const patch of [{ connected: true, running: false }, { healthy: true, connected: false },
    { stopping: true, healthy: true }, { lastRunAt: "2027-01-01T00:00:00Z" }, { lastRunAt: "invalid" },
    { phase: "unexpected" }, { running: "yes" }, { intervalSeconds: 0 }, { script: "arbitrary command" },
    { repository: { ...runner.repository, state: "succeeded" } },
    { repository: { ...runner.repository, mode: ["on-demand"] } },
    { repository: { ...runner.repository, lastUpdatedAt: "2027-01-01T00:00:00Z" } }]) {
    expect(isRunnerSnapshot({ ...snapshot, runners: [{ ...runner, ...patch }] })).toBe(false);
  }
  expect(isRunnerSnapshot({ ...snapshot, configured: false })).toBe(false);
  expect(isRunnerSnapshot({ ...snapshot, runners: [runner, runner] })).toBe(false);
  expect(isRunnerSnapshot({ ...snapshot, runners: [null] })).toBe(false);
  expect(isRunnerSnapshot({ ...snapshot, runners: [{ ...runner, lastRunAt: null, lastSuccessAt: null }] })).toBe(true);
});
it("describes custom repository updates as workflow actions, not before-handoff preparation", () => {
  const custom: Runner = { ...runner, repository: { ...runner.repository, mode: "workflow" } };
  expect(isRunnerSnapshot({ ...snapshot, runners: [custom] })).toBe(true);
  expect(repositoryActivity(custom)).toBe("Workflow action");
});
