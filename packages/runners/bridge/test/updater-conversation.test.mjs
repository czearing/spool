import assert from "node:assert/strict";
import test from "node:test";
import { writeJson } from "../spool-store.mjs";
import { handoff } from "./updater-fixture.mjs";
import { fixture } from "./fixtures.mjs";
import { configure } from "../config.mjs";
import { createUpdater } from "../updater.mjs";

test("native updater initializes without loading an optional WSL transport or acquiring credentials", async t => {
  const f = fixture(t);
  const config = configure({ spool_dir: f.root, pr_updater: { enabled: true, workspace_dir: f.workspace } },
    "pr-updater", f.root).config;
  const scan = await createUpdater({ store: f.store, config, agent: "pr-updater",
    workspace: f.workspace, runtime: config.runtimeDirectory });
  assert.equal(typeof scan, "function");
});

test("PR preparation cannot adopt a task revision that changed while setup was running", async t => {
  let f;
  f = await handoff(t, "perf", { dispatch: false, prepare: args => {
    const task = f.store.task(f.taskId);
    writeJson(task.file, { ...task, updated_at: new Date().toISOString(),
      comments: [...task.comments, { author: "operator", message: "New conversation input completed during preparation",
        created_at: new Date().toISOString() }] });
    return { ready: true, repoRoot: args.repoRoot, branch: args.branch, commit: "b".repeat(40) };
  } });
  const result = await f.scan();
  assert.equal(result.dispatched, 0);
  assert.match(result.lastError, /Task changed after runner preparation/);
  const task = f.store.task(f.taskId);
  assert.equal(task.status, "completed");
  assert.equal(task.prompt, f.brief);
  assert.equal(task.comments.at(-1).message, "New conversation input completed during preparation");
  assert.equal(task.runner_metadata, undefined);
});
