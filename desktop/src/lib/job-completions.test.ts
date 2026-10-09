import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readSpoolCompletions } from "./spool-completions";
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
