import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fixture } from "./fixtures.mjs";
import { configure } from "../config.mjs";
import { definition } from "../workflow-store.mjs";
import { createSpoolQueue } from "../queue.mjs";
import { createEventPipeline, bindEventQueue, eventPreparer } from "../workflow-event-pipeline.mjs";
import { createWorkspacePreparer } from "../workspace-preparation.mjs";
import { runReviewer } from "../../scanners/pr-reviewer/run.mjs";
import { runLivesite } from "../../scanners/livesite/run.mjs";
import { prepareReviewWorkspace } from "../../scanners/pr-reviewer/lib/workspace.mjs";
import { paperclipReviewerTasks } from "../../scanners/pr-reviewer/lib/task-source.mjs";
import { verifyEventWorkspace } from "../workflow-workspace.mjs";
import { eventConfiguration } from "../workflow-event-config.mjs";
import { eventRecipe, validateWorkflow } from "@spool/workflow";

for (const id of ["pr-reviewer", "livesite"]) test(`${id} emits into the same editable action executor from its real scan loop`, async t => {
  const f = fixture(t), agent = id === "pr-reviewer" ? id : "software-engineer";
  const input = { spool_dir: f.root, [id.replaceAll("-", "_")]: { enabled: true, workspace_dir: f.workspace } };
  const workflow = definition(input, id), { config, runtime } = configure(input, id, f.root);
  workflow.nodes.at(-1).prompt = "{{event.prompt}}\nAdded by the shared Agent block.";
  const queue = createSpoolQueue(f.store, { agent, workspace: f.workspace, runner: id });
  let preparations = 0;
  const call = async (_name, args) => { preparations++;
    return { ready: true, repoRoot: args.repoRoot, branch: args.branch, commit: args.sourceCommit || "a".repeat(40) };
  };
  const pipeline = createEventPipeline(workflow, { store: f.store, runtime, call, verifyPreparation: async () => {} });
  bindEventQueue(queue, pipeline);
  const prepare = eventPreparer(pipeline, createWorkspacePreparer({ store: f.store, queue, agent,
    workspace: f.workspace, call, ...(id === "pr-reviewer" ? { prepare: prepareReviewWorkspace } : {}) }), f.workspace);
  const entry = pathToFileURL(path.join(f.root, "run.mjs"));
  const pr = { id: "123", repository: "fixture", title: "Fixture review", sourceCommit: "a".repeat(40),
    url: "https://example.invalid/pr/123", status: "active", isDraft: false, reviewerVote: 0,
    selfAuthored: false, olderThanMaxAge: false, eligible: true, reasons: [] };
  const run = id === "pr-reviewer" ? () => runReviewer(entry, {
    config: { ...config, revisionSettleSeconds: 0 }, queue, once: true,
    scanAssignedPullRequests: async () => ({ detected: [pr], eligible: [pr] }),
    taskSource: cfg => paperclipReviewerTasks(cfg, queue), isBusy: async () => false, prepareWorkspace: prepare,
  }) : () => runLivesite(entry, {
    config: { ...config, definitions: [{ id: 8228 }] }, queue, once: true, setupAgentBranch: prepare,
    queryBuilds: async () => Array.from({ length: 3 }, (_, index) => ({
      id: String(123 - index), number: `fixture-${index}`, definitionId: 8228, status: "completed", result: "canceled",
      finishTime: new Date(Date.now() - index * 1000).toISOString(),
    })),
    queryTimeline: async () => assert.fail("Canceled builds do not require timelines"),
  });
  await run();
  assert.equal(f.store.tasks().length, 1);
  assert.match(f.store.tasks()[0].prompt, /Added by the shared Agent block/);
  assert.match(f.store.tasks()[0].prompt, /spool_update_task_status/);
  const initial = preparations;
  await run();
  assert.equal(f.store.tasks().length, 1);
  assert.equal(preparations, initial, "already delivered work must not prepare or dispatch again");
});
test("checkout verification reads the real repository and refuses tracked edits", async t => {
  const f = fixture(t);
  const git = args => execFileSync("git", args, { cwd: f.workspace, windowsHide: true, encoding: "utf8" }).trim();
  git(["init", "--quiet", "-b", "fixture"]);
  writeFileSync(path.join(f.workspace, "proof.txt"), "original");
  git(["add", "proof.txt"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  const prepared = { ready: true, repoRoot: f.workspace, branch: "fixture", commit: git(["rev-parse", "HEAD"]) };
  await verifyEventWorkspace(prepared);
  writeFileSync(path.join(f.workspace, "proof.txt"), "changed");
  await assert.rejects(verifyEventWorkspace(prepared), /changed the prepared checkout/);
  await verifyEventWorkspace(prepared, true);
});
test("changing the event operation selects its implementation, not the runner ID", t => {
  const f = fixture(t), input = { spool_dir: f.root, pr_reviewer: { enabled: true, workspace_dir: f.workspace } };
  const workflow = { ...definition(input, "pr-reviewer"), ...eventRecipe("livesite", { agent: "software-engineer" }) };
  validateWorkflow(workflow);
  const configured = configure(eventConfiguration(input, workflow), "livesite", f.root);
  assert.equal(configured.agent, "software-engineer");
  assert.equal(configured.config.stuckMinutes, 90);
  assert.equal(configured.config.pollSeconds, workflow.intervalSeconds);
});
