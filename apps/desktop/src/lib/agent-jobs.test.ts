import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readAgentJobs, selectAgentJobs } from "./agent-jobs";
import { closeBoardReadModels } from "./board-read-model";
import { settleFailureBackfill } from "../../../../packages/runners/bridge/task-failure.mjs";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spool-agent-jobs-"));
  await Promise.all(["incoming", "in_progress", "completed", "failed"].map((queue) => mkdir(join(root, "queues", queue), { recursive: true })));
});
afterEach(async () => { await closeBoardReadModels(); await settleFailureBackfill(); await rm(root, { recursive: true, force: true }); });
it("does not allocate display projections for another agent's thousand historical jobs", () => {
  let projected = 0;
  const other = { id: "other", agent: "reviewer", status: "completed" as const,
    get title() { projected++; return "Other agent"; } };
  const selected = { id: "selected", agent: "engineer", title: "Selected", status: "completed" as const };
  const jobs = selectAgentJobs({ items: [...Array(1000).fill(other), selected], archived: [] }, "engineer");
  expect(jobs.history.map(job => job.id)).toEqual(["selected"]);
  expect(projected).toBe(0);
});
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
it("keeps history readable and reconciles source edits when the disposable cache cannot be created", async () => {
  await writeFile(join(root, ".spool-cache"), "not a directory");
  await record("completed");
  expect((await readAgentJobs(root, "engineer")).history[0].title).toBe("Agent job");
  await record("completed", "TASK-1", { title: "Edited without a writable cache" });
  expect((await readAgentJobs(root, "engineer")).history[0].title).toBe("Edited without a writable cache");
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
it("pages indexed history with stable ties, agent-scoped search and selected deep links", async () => {
  for (let index = 0; index < 125; index++) await record("completed", `JOB-${String(index).padStart(3, "0")}`, {
    id: `JOB-${String(index).padStart(3, "0")}`, title: index === 120 ? "An older needle" : `Conversation ${index}`,
  });
  await record("completed", "OTHER", { id: "OTHER", agent: "reviewer", title: "Other needle" });
  const first = await readAgentJobs(root, "engineer", {});
  expect(first.history).toHaveLength(60); expect(first.nextCursor).toBeTruthy();
  const second = await readAgentJobs(root, "engineer", { cursor: first.nextCursor! });
  const third = await readAgentJobs(root, "engineer", { cursor: second.nextCursor! });
  expect(second.history).toHaveLength(60); expect(third.history).toHaveLength(5); expect(third.nextCursor).toBeUndefined();
  expect(new Set([...first.history, ...second.history, ...third.history].map(job => job.key)).size).toBe(125);
  expect((await readAgentJobs(root, "engineer", { search: "needle" })).history.map(job => job.id)).toEqual(["JOB-120"]);
  const selected = await readAgentJobs(root, "engineer", { selected: "JOB-120" });
  expect(selected.history).toHaveLength(61);
  expect(selected.history.at(-1)?.id).toBe("JOB-120");
  for (const page of [{ cursor: "bad" }, { limit: 0 }, { limit: 101 }, { search: "x".repeat(201) }])
    await expect(readAgentJobs(root, "engineer", page)).rejects.toThrow(RangeError);
});
it("persists only summaries and reconciles edits, queue moves, removal and cache loss", async () => {
  execFileSync("git", ["init", "--quiet", root]);
  await record("completed");
  expect((await readAgentJobs(root, "engineer")).history[0].title).toBe("Agent job");
  execFileSync("git", ["-C", root, "check-ignore", "--quiet", ".spool-cache/board-v1.sqlite"]);
  await closeBoardReadModels();
  expect((await readAgentJobs(root, "engineer")).history[0].title).toBe("Agent job");
  await record("completed", "TASK-1", { title: "Edited" });
  expect((await readAgentJobs(root, "engineer")).history[0].title).toBe("Edited");
  await rename(join(root, "queues", "completed", "TASK-1.json"), join(root, "queues", "in_progress", "TASK-1.json"));
  expect((await readAgentJobs(root, "engineer")).current[0].status).toBe("in_progress");
  await rm(join(root, "queues", "in_progress", "TASK-1.json"));
  expect((await readAgentJobs(root, "engineer")).current).toEqual([]);
  await closeBoardReadModels();
  const cache = join(root, ".spool-cache", "board-v1.sqlite");
  expect((await readFile(cache)).includes(Buffer.from("PRIVATE"))).toBe(false);
  await writeFile(cache, "corrupt disposable index");
  expect(await readAgentJobs(root, "engineer")).toEqual({ current: [], history: [] });
});
it("preserves Unicode case-insensitive title search in the indexed query", async () => {
  await record("completed", "TASK-1", { title: "\u00c9quipe review" });
  expect((await readAgentJobs(root, "engineer", { search: "\u00e9QUIPE" })).history.map(job => job.id)).toEqual(["TASK-1"]);
});
