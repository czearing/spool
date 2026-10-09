import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readAgentJobs } from "./agent-jobs";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spool-agent-jobs-"));
  await Promise.all(["incoming", "in_progress", "completed", "failed"].map((queue) => mkdir(join(root, "queues", queue), { recursive: true })));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function record(queue: string, file = "TASK-1", fields: Record<string, unknown> = {}) {
  await mkdir(join(root, "queues", queue), { recursive: true });
  await writeFile(join(root, "queues", queue, `${file}.json`), JSON.stringify({
    id: "TASK-1", title: "Agent job", agent: "engineer", status: "failed", updated_at: "2026-09-29T10:00:00Z",
    prompt: "PRIVATE PROMPT", comments: ["PRIVATE COMMENT"], workspace: "PRIVATE PATH", ...fields,
  }));
}
it("uses queue state for current work, includes queued conversations and excludes other agents", async () => {
  await record("in_progress");
  await record("in_progress", "TASK-2", { id: "TASK-2", agent: "reviewer" });
  await record("incoming", "TASK-3", { id: "TASK-3" });
  expect(await readAgentJobs(root, "engineer")).toEqual({ current: [{
    key: "in_progress:TASK-1.json", id: "TASK-1", title: "Agent job", status: "in_progress", archived: false, updatedAt: "2026-09-29T10:00:00Z",
  }, {
    key: "incoming:TASK-3.json", id: "TASK-3", title: "Agent job", status: "incoming", archived: false, updatedAt: "2026-09-29T10:00:00Z",
  }].sort((a, b) => a.key.localeCompare(b.key)), history: [] });
});
it("combines terminal jobs and distinct archived attempts newest-first without private fields", async () => {
  await record("completed", "TASK-1", { updated_at: "2026-09-29T12:00:00Z" });
  await record(".runner-archive", "TASK-1-attempt-1", { updated_at: "2026-09-28T10:00:00Z" });
  await record(".runner-archive", "TASK-1-attempt-2", { updated_at: "2026-09-29T10:00:00Z" });
  await record("failed", "TASK-2", { id: "TASK-2", updated_at: "2026-09-29T11:00:00Z" });
  const { current, history } = await readAgentJobs(root, "engineer");
  expect(current).toEqual([]);
  expect(history.map(({ key }) => key)).toEqual(["completed:TASK-1.json", "failed:TASK-2.json",
    ".runner-archive:TASK-1-attempt-2.json", ".runner-archive:TASK-1-attempt-1.json"]);
  expect(history[0].status).toBe("completed"); expect(history.filter((job) => job.archived)).toHaveLength(2);
  expect(JSON.stringify(history)).not.toContain("PRIVATE");
});
it("supports multiple concurrent jobs and preserves an archived in-progress snapshot as history", async () => {
  await record("in_progress"); await record("in_progress", "TASK-2", { id: "TASK-2" });
  await record(".runner-archive", "TASK-1-old", { status: "in_progress" });
  const jobs = await readAgentJobs(root, "engineer");
  expect(jobs.current).toHaveLength(2); expect(jobs.history).toHaveLength(1);
});
it("represents absent timestamps explicitly, sorts them last and never invents a run time", async () => {
  await record("completed", "TASK-1", { updated_at: undefined });
  await record("failed", "TASK-2", { id: "TASK-2" });
  const { history } = await readAgentJobs(root, "engineer");
  expect(history.map((job) => job.id)).toEqual(["TASK-2", "TASK-1"]);
  expect(history[1].updatedAt).toBeNull();
});
it("returns empty lists for an agent with no jobs and no archive directory", async () => {
  expect(await readAgentJobs(root, "engineer")).toEqual({ current: [], history: [] });
});
it.each([{ id: "OTHER" }, { title: "" }, { updated_at: "invalid" }])("surfaces malformed selected-agent records: %j", async (fields) => {
  await record("completed", "TASK-1", fields); await expect(readAgentJobs(root, "engineer")).rejects.toThrow("Invalid Spool");
});
it("rejects an unknown archived status rather than labeling it completed", async () => {
  await record(".runner-archive", "TASK-1-old", { status: "unknown" });
  await expect(readAgentJobs(root, "engineer")).rejects.toThrow("Invalid Spool archive status");
});
it("rejects malformed JSON and duplicate live IDs instead of returning partial history", async () => {
  await record("completed"); await record("failed");
  await expect(readAgentJobs(root, "engineer")).rejects.toThrow("multiple queues");
  await writeFile(join(root, "queues", "completed", "TASK-1.json"), "{broken");
  await expect(readAgentJobs(root, "engineer")).rejects.toThrow("Invalid Spool JSON");
});
