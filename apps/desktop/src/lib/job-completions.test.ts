import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { completionEvents, readSpoolCompletions } from "./spool-completions";
import type { JobCompletion } from "./job-completions";
import { createCompletionTracker } from "./job-completions";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "spool-completions-")); await mkdir(join(root, "queues", "completed"), { recursive: true }); });
afterEach(() => rm(root, { recursive: true, force: true }));
async function put(id: string, fields: object = {}) {
  await writeFile(join(root, "queues", "completed", `${id}.json`), JSON.stringify({
    id, title: `Finished ${id}`, agent: "engineer", turns: 1, session_id: `session-${id}`, prompt: "PRIVATE", ...fields,
  }));
}
it("baselines existing history, deduplicates refreshes and only notifies new settled executions", async () => {
  const tracker = createCompletionTracker();
  await put("old");
  expect(tracker(await readSpoolCompletions(root))).toEqual([]);
  await put("new", { provider: { pid: 123, token: "live" } });
  expect(tracker(await readSpoolCompletions(root))).toEqual([]);
  await put("new", { provider: null });
  expect(tracker(await readSpoolCompletions(root)).map(({ id }) => id)).toEqual(["new"]);
  expect(tracker(await readSpoolCompletions(root))).toEqual([]);
  await put("new", { title: "Edited title", updated_at: "2026-10-01" });
  expect(tracker(await readSpoolCompletions(root))).toEqual([]);
  await put("new", { turns: 2 });
  expect(tracker(await readSpoolCompletions(root)).map(({ id }) => id)).toEqual(["new"]);
  expect(JSON.stringify(await readSpoolCompletions(root))).not.toMatch(/PRIVATE|session-new|prompt/);
});
it("ignores failed outcomes and does not replay history after project remounts or restoration", async () => {
  await put("bad", { error: "Failure" }); expect(await readSpoolCompletions(root)).toEqual([]);
  await put("good");
  const snapshot = await readSpoolCompletions(root), tracker = createCompletionTracker();
  expect(tracker(snapshot)).toEqual([]); expect(tracker([])).toEqual([]); expect(tracker(snapshot)).toEqual([]);
  expect(createCompletionTracker()(snapshot)).toEqual([]);
});
it("consumes the open agent's completions without hiding other agents or replaying them after navigation", () => {
  const tracker = createCompletionTracker(), own = { key: "own", id: "one", title: "Chat response", agent: "engineer" };
  const other = { key: "other", id: "two", title: "Background review", agent: "reviewer" };
  expect(tracker([], "engineer")).toEqual([]);
  expect(tracker([own, other], "engineer")).toEqual([other]);
  expect(tracker([own, other])).toEqual([]);
  expect(tracker([own, other, { ...own, key: "next" }], "reviewer")).toEqual([{ ...own, key: "next" }]);
});
it("pushes queue moves and in-place native settlement without waiting for the reconciliation timer", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const abort = new AbortController();
  const reader = completionEvents(root, AbortSignal.any([abort.signal, AbortSignal.timeout(2000)])).body!.getReader();
  async function next() {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Completion stream ended.");
      const text = new TextDecoder().decode(value);
      if (text.startsWith("data: ")) return JSON.parse(text.slice(6)) as JobCompletion[];
    }
  }
  try {
    expect(await next()).toEqual([]);
    await mkdir(join(root, "queues", "incoming"));
    const incoming = join(root, "queues", "incoming", "moved.json");
    await writeFile(incoming, JSON.stringify({ id: "moved", title: "Moved work", agent: "engineer" }));
    await rename(incoming, join(root, "queues", "completed", "moved.json"));
    expect(await next()).toMatchObject([{ id: "moved" }]);
    await put("settling", { provider: { pid: 123, token: "settling" } });
    expect((await readSpoolCompletions(root)).map(item => item.id)).toEqual(["moved"]);
    await put("settling", { provider: null });
    expect((await next()).map(item => item.id)).toEqual(["moved", "settling"]);
  } finally { abort.abort(); vi.useRealTimers(); }
});
