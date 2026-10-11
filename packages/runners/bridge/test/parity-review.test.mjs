import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { renameSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { configure } from "../config.mjs";
import { engine, profile } from "../sources.mjs";
import { createUpdater } from "../updater.mjs";
import { resolveSpoolCreator } from "../creator-routing.mjs";
import { SpoolStore, writeJson, readJson, digest } from "../spool-store.mjs";
import { workload } from "../workload.mjs";
import { fixture } from "./fixtures.mjs";
import { PREPARATION_BLOCKED } from "../../packages/bohemia-pr-mcp/src/resume-state.mjs";
import { finishTask, legacyInterrupted } from "./continuation-fixtures.mjs";
import { nativeControls } from "./native-controls-fixture.mjs";

import { creatorFixture } from "./creator-fixture.mjs";

for (const verified of [false, true]) {
  test(`task completion ${verified ? "with" : "without"} verified PR evidence is not inferred from exit status`, async t => {
    const f = creatorFixture(t);
    const scan = await createUpdater({ ...f.options, callBohemia: async (_name, args) =>
      ({ ready: true, branch: args.branch, commit: f.pr.sourceCommit, repoRoot: args.repoRoot }) });
    assert.equal((await scan()).dispatched, 1);
    const metadata = f.store.metadata("OFF-123");
    const task = f.store.task("OFF-123");
    f.pr.sourceCommit = "b".repeat(40); f.pr.mergeStatus = "succeeded";
    task.comments = verified ? [{ author: "perf", message: "PR_UPDATE_RESULT: " + JSON.stringify({
      submissionId: metadata.key, fingerprint: metadata.contract.fingerprint, head: f.pr.sourceCommit,
      findings: [], repair: { evidence: "Conflict resolved and pushed",
        verification: { command: "fixture check", expected: "pass", actual: "pass" } },
    }) }] : [];
    writeJson(task.file, task);
    renameSync(task.file, path.join(f.store.queues, "completed", "OFF-123.json"));
    await scan();
    const { readJson } = await import("../spool-store.mjs");
    const proof = readJson(path.join(f.store.records, "verification-OFF-123.json"));
    assert.equal(proof.ok, verified);
    assert.equal(proof.agent, "perf");
    assert.equal(proof.head, f.pr.sourceCommit);
  });
}

test("a completed author result is reverified after transport repair without another author run", async t => {
  const f = creatorFixture(t);
  f.pr.mergeStatus = "succeeded";
  f.pr.description = "Original description";
  const threads = [{ id: 1, status: "active", comments: [{
    id: 1, commentType: "text", author: { uniqueName: "reviewer@example.test", displayName: "Reviewer" },
    content: "Clarify the behavior", publishedDate: "2026-09-10T00:00:00Z",
  }] }];
  f.ado.listThreads = async () => threads;
  const scan = await createUpdater({ ...f.options, callBohemia: async (_name, args) =>
    ({ ready: true, branch: args.branch, commit: f.pr.sourceCommit, repoRoot: args.repoRoot }) });
  assert.equal((await scan()).dispatched, 1);
  const task = f.store.task("OFF-123"), metadata = f.store.metadata(task.id);
  const originalSession = task.session_id;
  f.pr.description += "\nValidated explanation";
  threads[0].status = "fixed";
  task.comments.push({ author: "perf", message: String.raw`PR_UPDATE_RESULT: {"path":"C:\Code"}` });
  writeJson(task.file, task);
  renameSync(task.file, path.join(f.store.queues, "completed", `${task.id}.json`));
  await scan();
  const proofFile = path.join(f.store.records, `verification-${task.id}.json`);
  assert.equal(JSON.parse(readFileSync(proofFile, "utf8")).ok, false);
  writeJson(metadata.contract.resultFile, {
    submissionId: metadata.key, fingerprint: metadata.contract.fingerprint, head: f.pr.sourceCommit,
    findings: [{ threadId: "1", disposition: "answered", evidence: "Measured and published",
      descriptionEvidence: "Validated explanation",
      verification: { command: String.raw`node C:\Code\probe.js`, expected: "pass", actual: "pass" } }],
  });
  const completed = f.store.task(task.id);
  completed.comments.push({ author: "perf", message: `PR_UPDATE_RESULT_FILE: ${metadata.key}` });
  writeJson(completed.file, completed);
  assert.equal((await scan()).dispatched, 0);
  assert.equal(JSON.parse(readFileSync(proofFile, "utf8")).ok, true);
  assert.equal(f.store.tasks().length, 1);
  assert.equal(f.store.task(task.id).session_id, originalSession);
});

