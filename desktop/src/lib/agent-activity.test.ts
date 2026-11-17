import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { countActiveSessions, readAgentActivity as readActivity } from "./agent-activity";
import { readRunningProcesses } from "./process-snapshot";

const reads = vi.hoisted(() => ({ readFile: vi.fn(), readdir: vi.fn(), stat: vi.fn() }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  reads.readFile.mockImplementation(actual.readFile);
  reads.readdir.mockImplementation(actual.readdir);
  reads.stat.mockImplementation(actual.stat);
  return { ...actual, readFile: reads.readFile, readdir: reads.readdir, stat: reads.stat };
});
vi.mock("./process-snapshot", () => ({ readRunningProcesses: vi.fn() }));
let root: string;
const readAgentActivity = async (directory: string) => (await readActivity(directory)).active;
beforeEach(async () => {
  vi.mocked(readRunningProcesses).mockReset();
  reads.readFile.mockClear();
  reads.readdir.mockClear();
  reads.stat.mockClear();
  root = await mkdtemp(join(tmpdir(), "spool-activity-"));
  await Promise.all(["incoming", "in_progress", "completed", "failed"].map(queue =>
    mkdir(join(root, "queues", queue), { recursive: true })));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const session = (agent: string, id: string) => ({ agent, session: id, provider: null });
it("counts separate live sessions and deduplicates parent/wrapper processes", () => {
  expect(countActiveSessions([session("prompt-engineer", "one"), session("prompt-engineer", "two"), session("reviewer", "old")], [
    { pid: 1, command: 'cmd /c copilot --session-id "one" --model model' },
    { pid: 2, command: "node copilot.js --session-id one" },
    { pid: 3, command: "copilot --resume two" },
  ])).toEqual({ "prompt-engineer": 2 });
});
it("matches complete session arguments, not historical references or prefix collisions", () => {
  expect(countActiveSessions([session("engineer", "abc")], [
    { pid: 1, command: "copilot --session-id abc-other" },
    { pid: 2, command: "copilot --log-dir abc" },
    { pid: 3, command: "copilot --not--session-id abc" },
  ])).toEqual({});
});
it("requires both the provider PID and launch token to avoid counting reused PIDs", () => {
  const execution = { agent: "reviewer", session: "old", provider: { pid: 5, token: "spool-provider-current" } };
  expect(countActiveSessions([execution], [{ pid: 5, command: "node --log-dir spool-provider-old" }])).toEqual({});
  expect(countActiveSessions([execution], [{ pid: 6, command: "node --log-dir spool-provider-current" }])).toEqual({});
  expect(countActiveSessions([execution], [{ pid: 5, command: "node --log-dir old-spool-provider-current" }])).toEqual({});
  expect(countActiveSessions([execution], [{ pid: 5, command: 'copilot --acp --log-dir "C:\\logs\\spool-provider-current"' }])).toEqual({ reviewer: 1 });
});
it("does not count an unspawned provider using its previous session ID", () => {
  expect(countActiveSessions([{ agent: "reviewer", session: "old", provider: { pid: null, token: "new-launch" } }],
    [{ pid: 5, command: "copilot --resume old" }])).toEqual({});
});
it("does not spawn a process inspector when no sessions are starting or running", async () => {
  expect(await readAgentActivity(root)).toEqual({});
  expect(readRunningProcesses).not.toHaveBeenCalled();
});
it("does not enumerate or stat historical queues when checking active sessions", async () => {
  for (const queue of ["completed", "failed"])
    await writeFile(join(root, "queues", queue, "TASK-OLD.json"), "{not an active record}");
  const file = join(root, "queues", "in_progress", "TASK-1.json");
  await writeFile(file, JSON.stringify({ id: "TASK-1", agent: "engineer", session_id: null }));
  expect(await readAgentActivity(root)).toEqual({});
  expect(reads.readdir.mock.calls.every(([directory]) =>
    ["incoming", "in_progress"].some(queue => directory === join(root, "queues", queue)))).toBe(true);
  expect(reads.stat.mock.calls.every(([path]) => path === file)).toBe(true);
});
it("reads live queue records and never counts a stale task without a live process", async () => {
  await writeFile(join(root, "queues", "in_progress", "TASK-1.json"), JSON.stringify({ id: "TASK-1", agent: "engineer", session_id: "s1" }));
  vi.mocked(readRunningProcesses).mockResolvedValue([]);
  expect(await readAgentActivity(root)).toEqual({});
  vi.mocked(readRunningProcesses).mockResolvedValue([{ pid: 123, command: "copilot --session-id s1" }]);
  expect(await readAgentActivity(root)).toEqual({ engineer: 1 });
});
it.each(["failed", "completed", "incoming"])("does not report a %s task as working just because its provider is alive", async queue => {
  await writeFile(join(root, "queues", queue, "TASK-1.json"), JSON.stringify({
    id: "TASK-1", agent: "perf", session_id: "saved", provider: { pid: 123, token: "spool-provider-current" },
  }));
  await writeFile(join(root, "queues", queue, "TASK-2.json"), JSON.stringify({
    id: "TASK-2", agent: "perf", session_id: "dormant",
  }));
  vi.mocked(readRunningProcesses).mockResolvedValue([{ pid: 123, command: "node --log-dir spool-provider-current" }]);
  expect(await readAgentActivity(root)).toEqual({});
  expect(readRunningProcesses).not.toHaveBeenCalled();
});
it.each(["paused", "ended"])("does not report a %s execution as working, but counts it when it resumes", async phase => {
  const file = join(root, "queues", "in_progress", "TASK-1.json");
  const task = { id: "TASK-1", agent: "engineer", session_id: "saved",
    provider: { pid: 123, token: "spool-provider-current" } };
  vi.mocked(readRunningProcesses).mockResolvedValue([{ pid: 123, command: "node --log-dir spool-provider-current" }]);
  await writeFile(file, JSON.stringify({ ...task, interaction: { phase } }));
  expect(await readAgentActivity(root)).toEqual({});
  await writeFile(file, JSON.stringify({ ...task, interaction: { phase: "running" } }));
  expect(await readAgentActivity(root)).toEqual({ engineer: 1 });
});
it("surfaces unreadable process state and malformed active tasks instead of reporting zero", async () => {
  const file = join(root, "queues", "in_progress", "TASK-1.json");
  await writeFile(file, JSON.stringify({ id: "TASK-1", agent: "engineer", session_id: "s1" }));
  vi.mocked(readRunningProcesses).mockRejectedValue(new Error("Inspection failed"));
  await expect(readAgentActivity(root)).rejects.toThrow("Inspection failed");
  await writeFile(file, '{"id":"WRONG","agent":"engineer"}');
  await expect(readAgentActivity(root)).rejects.toThrow("Invalid active task");
});
it("reuses unchanged task parsing while still inspecting current process liveness", async () => {
  const file = join(root, "queues", "in_progress", "TASK-1.json");
  await writeFile(file, JSON.stringify({ id: "TASK-1", agent: "engineer", session_id: "s1", prompt: "x".repeat(100000) }));
  vi.mocked(readRunningProcesses).mockResolvedValue([{ pid: 123, command: "copilot --session-id s1" }]);
  await readAgentActivity(root);
  await readAgentActivity(root);
  reads.readFile.mockClear();
  vi.mocked(readRunningProcesses).mockResolvedValue([]);
  expect(await readAgentActivity(root)).toEqual({});
  expect(reads.readFile).not.toHaveBeenCalled();
  await writeFile(file, JSON.stringify({ id: "TASK-1", agent: "engineer", session_id: "s2" }));
  vi.mocked(readRunningProcesses).mockResolvedValue([{ pid: 123, command: "copilot --session-id s2" }]);
  expect(await readAgentActivity(root)).toEqual({ engineer: 1 });
  expect(reads.readFile).toHaveBeenCalledOnce();
});
it("reports pending and starting tasks without claiming a running process", async () => {
  await writeFile(join(root, "queues", "incoming", "queued.json"), JSON.stringify({
    id: "queued", agent: "engineer", interaction: { phase: "ended" },
  }));
  const file = join(root, "queues", "in_progress", "starting.json");
  await writeFile(file, JSON.stringify({ id: "starting", agent: "engineer", interaction: { phase: "starting" },
    provider: { pid: 123, token: "new-launch" } }));
  expect(await readActivity(root)).toEqual({ active: {}, work: [
    { id: "starting", agent: "engineer", state: "starting" },
    { id: "queued", agent: "engineer", state: "pending" },
  ] });
  expect(readRunningProcesses).not.toHaveBeenCalled();
  vi.mocked(readRunningProcesses).mockResolvedValue([{ pid: 123, command: "copilot --log-dir new-launch" }]);
  await writeFile(file, JSON.stringify({ id: "starting", agent: "engineer", interaction: { phase: "running" },
    provider: { pid: 123, token: "new-launch" } }));
  const snapshot = await readActivity(root);
  expect(snapshot.active).toEqual({ engineer: 1 });
  expect(snapshot.work).toContainEqual({ id: "starting", agent: "engineer", state: "running" });
});
