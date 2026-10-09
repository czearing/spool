import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { countActiveSessions, readAgentActivity } from "./agent-activity";
import { readRunningProcesses } from "./process-snapshot";

vi.mock("./process-snapshot", () => ({ readRunningProcesses: vi.fn() }));
let root: string;
beforeEach(async () => {
  vi.mocked(readRunningProcesses).mockReset();
  root = await mkdtemp(join(tmpdir(), "spool-activity-"));
  await mkdir(join(root, "queues", "in_progress"), { recursive: true });
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
it("reads live queue records and never counts a stale task without a live process", async () => {
  await writeFile(join(root, "queues", "in_progress", "TASK-1.json"), JSON.stringify({ id: "TASK-1", agent: "engineer", session_id: "s1" }));
  vi.mocked(readRunningProcesses).mockResolvedValue([]);
  expect(await readAgentActivity(root)).toEqual({});
  vi.mocked(readRunningProcesses).mockResolvedValue([{ pid: 123, command: "copilot --session-id s1" }]);
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
