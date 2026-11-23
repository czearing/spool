import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readProjectLive, invalidateActivity, watchActivity } from "./project-live";
import { readAgentActivity } from "./agent-activity";
import { closeBoardReadModels } from "./board-read-model";

vi.mock("./agent-activity", () => ({ readAgentActivity: vi.fn() }));
let root: string;
afterEach(async () => { await closeBoardReadModels(); await rm(root, { recursive: true, force: true }); });
it("returns saved conversations while health is hung, preserves last-known counts and recovers after failure", async () => {
  root = await mkdtemp(join(tmpdir(), "project-live-isolation-"));
  for (const directory of ["agents", "incoming", "in_progress", "completed", "failed"]) {
    await mkdir(directory === "agents" ? join(root, directory) : join(root, "queues", directory), { recursive: true });
  }
  await writeFile(join(root, "agents", "perf.md"), "# Perf");
  await writeFile(join(root, "queues", "completed", "old.json"), JSON.stringify({
    id: "old", title: "Saved history", agent: "perf", updated_at: "2026-11-01T00:00:00Z",
  }));
  let resolve!: (value: Awaited<ReturnType<typeof readAgentActivity>>) => void;
  vi.mocked(readAgentActivity).mockImplementationOnce(() => new Promise(ready => { resolve = ready; }));
  const first = await readProjectLive(root, "perf");
  expect(first.jobs?.data.history[0].title).toBe("Saved history");
  expect(first.activityError).toContain("Checking");
  invalidateActivity(root);
  const changed = () => new Promise<void>(ready => { const stop = watchActivity(root, () => { stop(); ready(); }); });
  let update = changed();
  resolve({ active: { perf: 1 }, work: [] });
  await update;
  vi.mocked(readAgentActivity).mockResolvedValueOnce({ active: { perf: 1 }, work: [] });
  update = changed();
  expect((await readProjectLive(root, "perf")).agents[0].active).toBe(1);
  await update;
  invalidateActivity(root);
  vi.mocked(readAgentActivity).mockRejectedValueOnce(new Error("Windows CIM timed out"));
  update = changed();
  expect((await readProjectLive(root, "perf")).jobs?.data.history).toHaveLength(1);
  await update;
  const failed = await readProjectLive(root, "perf");
  expect(failed.agents[0].active).toBe(1);
  expect(failed.activityError).toContain("unavailable");
  invalidateActivity(root);
  vi.mocked(readAgentActivity).mockResolvedValueOnce({ active: {}, work: [] });
  update = changed();
  await readProjectLive(root, "perf"); await update;
  expect((await readProjectLive(root, "perf")).activityError).toBeUndefined();
});
