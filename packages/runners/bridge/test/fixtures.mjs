import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SpoolStore, writeJson } from "../spool-store.mjs";
import { nativeControls } from "./native-controls-fixture.mjs";

export function fixture(t, { nativeMessages = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "spool-runners-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "agents"));
  for (const agent of ["pr-reviewer", "pr-updater", "perf", "tech-writer", "software-engineer"]) {
    writeFileSync(path.join(root, "agents", `${agent}.md`), "Fixture agent. Never executed.");
  }
  for (const status of ["incoming", "in_progress", "completed", "failed"]) mkdirSync(path.join(root, "queues", status), { recursive: true });
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const store = new SpoolStore(root, { processes: () => [] });
  const submit = store.submit.bind(store);
  let refreshControls;
  store.submit = async input => {
    if (input.resumeId && nativeMessages) {
      refreshControls ||= nativeControls(t, root);
      refreshControls();
    }
    return submit(input);
  };
  const put = (task, state = "incoming") => writeJson(path.join(root, "queues", state, `${task.id}.json`), {
    agent: "pr-updater", title: "Fixture", prompt: "Fixture work", workspace,
    created_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:00Z",
    comments: [], cost: {}, turns: 0, status: state, ...task,
  });
  const preparation = { ready: true, repoRoot: workspace, branch: "fixture", commit: "a".repeat(40) };
  return { root, store, workspace, put, preparation };
}
