import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerLocations } from "./runner-client";
import { readRunnerLogs } from "./runner-log-reader";

vi.mock("./runner-client", () => ({ runnerLocations: vi.fn() }));
let root: string, runtime: string, executions: string;
const id = "12345678-1234-1234-1234-123456789abc";
const summary = { id, source: "integration", status: "succeeded", createdAt: "2026-10-21T19:20:00Z" };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spool-runner-logs-"));
  const automation = join(root, ".runner", "automation");
  vi.mocked(runnerLocations).mockReturnValue({ config: join(automation, "spool-runners.json"),
    runtime: automation, home: join(root, "no-engine-required") });
  runtime = join(automation, "runners", "livesite", ".runner"); executions = join(runtime, "executions");
  await mkdir(executions, { recursive: true });
  await writeFile(join(automation, "spool-runners.json"), JSON.stringify({ spool_dir: root, livesite: { enabled: false } }));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it("reads real stdout/stderr and saved run output even when a runner is stopped", async () => {
  await writeFile(join(runtime, "runner.log"), "scan complete\n");
  await writeFile(join(runtime, "runner-error.log"), "request failed\n");
  await writeFile(join(executions, `${id}.summary.json`), JSON.stringify(summary));
  await writeFile(join(executions, `${id}.json`), JSON.stringify({ ...summary,
    steps: [{ id: "dispatch", label: "Dispatch", status: "succeeded", startedAt: summary.createdAt, output: { id: "task-42" } }] }));
  const logs = await readRunnerLogs(root, "livesite");
  expect(logs.runs).toEqual([summary]);
  expect(logs.output).toContain("scan complete");
  expect(logs.output).toContain("request failed");
  const run = await readRunnerLogs(root, "livesite", id);
  expect(run.output).toContain("[Dispatch] succeeded");
  expect(run.output).toContain('"id": "task-42"');
  expect(run.output).not.toContain("scan complete");
});
it("uses existing recorded activity for older processes without inventing runs", async () => {
  await writeFile(join(runtime, "activity.jsonl"), '{"event":"scan_completed"}\n');
  const logs = await readRunnerLogs(root, "livesite");
  expect(logs).toEqual({ runs: [], output: '{"event":"scan_completed"}\n', truncated: false });
});
it("bounds large logs, rereads appends and handles truncation without caching stale output", async () => {
  await writeFile(join(runtime, "runner.log"), "old\n".repeat(100000) + "latest\n");
  const logs = await readRunnerLogs(root, "livesite");
  expect(logs.truncated).toBe(true);
  expect(Buffer.byteLength(logs.output)).toBeLessThanOrEqual(256 * 1024);
  expect(logs.output.endsWith("latest\n")).toBe(true);
  await writeFile(join(runtime, "runner.log"), "rotated\n");
  expect((await readRunnerLogs(root, "livesite")).output).toBe("rotated\n");
});
it("rejects unknown runners, path traversal, missing runs and malformed records explicitly", async () => {
  await expect(readRunnerLogs(root, "unknown")).rejects.toMatchObject({ status: 404 });
  await expect(readRunnerLogs(root, "..")).rejects.toMatchObject({ status: 400 });
  await expect(readRunnerLogs(root, "livesite", "../private")).rejects.toMatchObject({ status: 400 });
  await expect(readRunnerLogs(root, "livesite", id)).rejects.toMatchObject({ status: 404 });
  await writeFile(join(executions, `${id}.summary.json`), "{}");
  await expect(readRunnerLogs(root, "livesite")).rejects.toThrow("Invalid runner run record.");
});
