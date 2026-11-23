import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureApplication } from "./application-paths";
import { readRunnerLogs } from "./runner-log-reader";

const reads = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  reads.open.mockImplementation(actual.open);
  return { ...actual, open: reads.open };
});
let root: string, runtime: string, executions: string;
const id = "12345678-1234-1234-1234-123456789abc";
const summary = { id, source: "integration", status: "succeeded", createdAt: "2026-10-21T19:20:00Z" };
beforeEach(async () => {
  reads.open.mockClear();
  root = await mkdtemp(join(tmpdir(), "spool-runner-logs-"));
  configureApplication({ data: root, resources: join(root, "no-engine-required") });
  const automation = join(root, ".runner", "automation");
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
it("reuses unchanged summaries but detects edits, retention and invalid new content", async () => {
  const file = join(executions, `${id}.summary.json`);
  await writeFile(file, JSON.stringify(summary));
  await readRunnerLogs(root, "livesite"); await readRunnerLogs(root, "livesite");
  reads.open.mockClear();
  expect((await readRunnerLogs(root, "livesite")).runs).toEqual([summary]);
  expect(reads.open.mock.calls.filter(([name]) => name === file)).toHaveLength(0);
  await writeFile(file, JSON.stringify({ ...summary, status: "failed", error: "Failed" }));
  expect((await readRunnerLogs(root, "livesite")).runs[0]).toMatchObject({ status: "failed", error: "Failed" });
  await unlink(file);
  expect((await readRunnerLogs(root, "livesite")).runs).toEqual([]);
  await writeFile(file, "{}");
  await expect(readRunnerLogs(root, "livesite")).rejects.toThrow("Invalid runner run record.");
});
it("does not bypass the record-size limit after caching a smaller valid summary", async () => {
  const file = join(executions, `${id}.summary.json`);
  await writeFile(file, JSON.stringify(summary));
  await readRunnerLogs(root, "livesite");
  await writeFile(file, JSON.stringify({ ...summary, error: "x".repeat(65536) }));
  await expect(readRunnerLogs(root, "livesite")).rejects.toThrow("exceeds the supported size");
});
