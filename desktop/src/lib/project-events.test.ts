import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { projectEvents } from "./project-events";
import { readRunningProcesses } from "./process-snapshot";
import type { ProjectLive } from "./project-live";
import { closeBoardReadModels } from "./board-read-model";

vi.mock("./process-snapshot", () => ({ readRunningProcesses: vi.fn() }));
let root: string, abort: AbortController;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "project-events-"));
  abort = new AbortController();
  await Promise.all(["agents", "controls", ...["incoming", "in_progress", "completed", "failed"].map(queue => join("queues", queue))]
    .map(directory => mkdir(join(root, directory), { recursive: true })));
  await writeFile(join(root, "agents", "engineer.md"), "# Fixture");
  vi.mocked(readRunningProcesses).mockReset().mockResolvedValue([]);
});
afterEach(async () => { abort.abort(); await closeBoardReadModels(); await rm(root, { recursive: true, force: true }); });
async function replace(file: string, value: unknown) {
  await writeFile(`${file}.tmp`, JSON.stringify(value));
  for (let attempt = 0; ; attempt++) {
    try { await rename(`${file}.tmp`, file); return; }
    catch (error) {
      if (attempt === 9 || !error || typeof error !== "object" || !("code" in error) || !["EPERM", "EBUSY"].includes(String(error.code))) throw error;
      await delay(20);
    }
  }
}
async function nextData(reader: ReadableStreamDefaultReader<Uint8Array>, accept = (_snapshot: ProjectLive) => true): Promise<ProjectLive> {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error("Project stream closed without an update.");
    const text = new TextDecoder().decode(value);
    if (text.startsWith("data: ")) {
      const snapshot: ProjectLive = JSON.parse(text.slice(6));
      if (accept(snapshot)) return snapshot;
    }
    if (text.startsWith("event: unavailable")) throw new Error("Project activity became unavailable.");
  }
}
it("pushes pending, starting, running and completion to both sidebar models without polling", async () => {
  const reader = projectEvents(root, abort.signal, "engineer").body!.getReader();
  expect((await nextData(reader)).jobs?.data).toEqual({ current: [], history: [] });
  const task = { id: "work", agent: "engineer", title: "Shared activity", updated_at: "2026-11-03T00:00:00Z" };
  const incoming = join(root, "queues", "incoming", "work.json"), running = join(root, "queues", "in_progress", "work.json");
  await replace(incoming, task);
  let snapshot = await nextData(reader, value => value.agents[0].pending === 1);
  expect(snapshot.agents[0]).toMatchObject({ active: 0, pending: 1, starting: 0 });
  expect(snapshot.jobs?.data.current[0]).toMatchObject({ id: "work", activity: "pending" });
  await replace(incoming, { ...task, interaction: { phase: "starting" },
    provider: { pid: 123, token: "spool-provider-current" } });
  await rename(incoming, running);
  snapshot = await nextData(reader, value => value.agents[0].starting === 1);
  expect(snapshot.agents[0]).toMatchObject({ active: 0, pending: 0, starting: 1 });
  expect(snapshot.jobs?.data.current[0].activity).toBe("starting");
  expect(readRunningProcesses).not.toHaveBeenCalled();
  vi.mocked(readRunningProcesses).mockResolvedValue([{ pid: 123, command: "copilot --log-dir spool-provider-current" }]);
  await replace(running, { ...task, interaction: { phase: "running" },
    provider: { pid: 123, token: "spool-provider-current" } });
  snapshot = await nextData(reader, value => value.agents[0].active === 1);
  expect(snapshot.agents[0]).toMatchObject({ active: 1, pending: 0, starting: 0 });
  expect(snapshot.jobs?.data.current[0].activity).toBe("running");
  await rename(running, join(root, "queues", "completed", "work.json"));
  await replace(join(root, "queues", "completed", "work.json"), task);
  snapshot = await nextData(reader, value => value.jobs?.data.history[0]?.status === "completed" && value.agents[0].active === 0);
  expect(snapshot.agents[0]).toMatchObject({ active: 0, pending: 0, starting: 0 });
  expect(snapshot.jobs?.data.current).toEqual([]);
  expect(snapshot.jobs?.data.history[0]).toMatchObject({ id: "work", status: "completed" });
});
it("watches newly created preparation directories and deduplicates tasks handed to the queue", async () => {
  const reader = projectEvents(root, abort.signal, "engineer").body!.getReader();
  await nextData(reader);
  const manual = join(root, "controls", "manual");
  await mkdir(manual);
  await replace(join(manual, "request.json"), {
    request: { kind: "create", taskId: "work", title: "Preparing work", agent: "engineer" }, status: "preparing",
  });
  let snapshot = await nextData(reader);
  expect(snapshot.agents[0]).toMatchObject({ active: 0, pending: 1 });
  expect(snapshot.jobs?.data.current[0]).toMatchObject({ id: "work", activity: "pending" });
  await replace(join(root, "queues", "incoming", "work.json"), { id: "work", title: "Preparing work", agent: "engineer" });
  snapshot = await nextData(reader);
  expect(snapshot.agents[0].pending).toBe(1);
  expect(snapshot.jobs?.data.current).toHaveLength(1);
});
