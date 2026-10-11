import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { assertAgentWorkspaceIdle, checkAcceptance, createTelemetryWriter, rollup, runCycle } from "../../packages/bohemia-agent-tooling/src/index.js";
import { configure } from "../config.mjs";
import { createSpoolQueue } from "../queue.mjs";
import { engine } from "../sources.mjs";
import { SpoolStore, writeJson } from "../spool-store.mjs";
import { fixture } from "./fixtures.mjs";

const sha = "a".repeat(40);
const incident = {
  kind: "regression", key: "regression:8228:fixture-test", actionable: true,
  summary: "Fixture build regression", build: {
    id: "123", number: "fixture-build", url: "https://example.invalid/build/123",
    sourceBranch: "refs/heads/master", sourceVersion: sha,
  },
};
const prepared = workspace => ({ ready: true, repoRoot: workspace, branch: "user/fixture", commit: sha });
const binary = process.env.SPOOL_TEST_BINARY ||
  fileURLToPath(new URL(`../../../spool/target/release/spool${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
function assertSpoolPrompt(prompt, agent) {
  for (const tool of ["spool_add_comment", "spool_update_task_status", "spool_get_task"]) assert.ok(prompt.includes(tool));
  if (agent === "pr-reviewer") {
    assert.doesNotMatch(prompt, /PAPERCLIP_TASK_ID|PAPERCLIP_RUN_ID|X-Paperclip-Run-Id/);
    assert.match(prompt, /no separate evidence service is required/);
    assert.doesNotMatch(prompt, /Do not post PR comments|Never post PR comments|Spool-only findings/);
    assert.match(prompt, /All original review, posting, approval and notification instructions remain unchanged/);
  } else {
    assert.doesNotMatch(prompt, /PAPERCLIP_TASK_ID|PAPERCLIP_RUN_ID|X-Paperclip-Run-Id/);
    assert.match(prompt, /Do not post PR comments/);
  }
}
function finishThroughMcp(f, task, status = "completed") {
  assert.ok(existsSync(binary), "Build sibling Spool or set SPOOL_TEST_BINARY to test real task delivery");
  writeJson(task.file, { ...task, file: undefined, status: "in_progress" });
  renameSync(task.file, path.join(f.store.queues, "in_progress", `${task.id}.json`));
  const comment = "Isolated protocol fixture result. No model execution or real PR change is claimed.";
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "runner-behavior-test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    ...[
      ["spool_get_task", {}],
      ["spool_add_comment", { comment }],
      ["spool_update_task_status", { status, ...(status === "failed" ? { error: "isolated fixture failure" } : {}) }],
      ["spool_get_task", {}],
    ].map(([name, args], index) => ({ jsonrpc: "2.0", id: index + 2, method: "tools/call", params: { name, arguments: args } })),
  ];
  const output = spawnSync(binary, ["--root", f.root, "mcp", "--agent", task.agent, "--task", task.id], {
    input: requests.map(row => JSON.stringify(row)).join("\n") + "\n",
    encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(output.status, 0, `${output.error || ""}\n${output.stderr}`);
  const responses = output.stdout.trim().split(/\r?\n/).map(JSON.parse);
  for (const id of [2, 3, 4, 5]) {
    const response = responses.find(row => row.id === id);
    assert.ok(response?.result, `missing MCP result ${id}`);
    assert.notEqual(response.result.isError, true, JSON.stringify(response.result));
  }
  const before = JSON.parse(responses.find(row => row.id === 2).result.content[0].text);
  const after = JSON.parse(responses.find(row => row.id === 5).result.content[0].text);
  assert.equal(before.prompt, task.prompt);
  assert.equal(after.status, status);
  assert.equal(after.agent, task.agent);
  assert.equal(after.workspace, task.workspace);
  assert.ok(after.comments.some(row => row.message === comment));
  assert.equal(f.store.task(task.id).status, status);
}

test("terminal failures never hold workspace capacity, but genuine blocked work and surviving sessions do", async t => {
  const f = fixture(t);
  f.put({ id: "old", agent: "software-engineer", session_id: "surviving-session" }, "failed");
  const queue = createSpoolQueue(f.store, { agent: "software-engineer", workspace: f.workspace, runner: "livesite" });
  assert.equal((await queue.getIssue("old")).status, "failed");
  await assertAgentWorkspaceIdle(queue, "software-engineer");
  const liveStore = new SpoolStore(f.root, { processes: () => [{ Name: "copilot.exe", CommandLine: "--session-id surviving-session" }] });
  const liveQueue = createSpoolQueue(liveStore, { agent: "software-engineer", workspace: f.workspace, runner: "livesite" });
  await assert.rejects(assertAgentWorkspaceIdle(liveQueue, "software-engineer"), /live run/);
  await assert.rejects(assertAgentWorkspaceIdle({
    listIssues: async () => [{ assigneeAgentId: "software-engineer", status: "blocked" }],
    listLiveRuns: async () => [],
  }, "software-engineer"), /unfinished work/);
  assert.equal(f.store.task("old").status, "failed");
});

for (const terminal of ["failed", "completed"]) test(`livesite dispatches past 18 historical failures and creates a new attempt after ${terminal}`, async t => {
  const f = fixture(t), agent = "software-engineer";
  for (let i = 0; i < 18; i++) f.put({ id: `historic-${i}`, agent }, "failed");
  const queue = createSpoolQueue(f.store, { agent, workspace: f.workspace, runner: "livesite" });
  const { assignIncident } = await engine("livesite/lib/delivery.mjs");
  const config = { agentId: agent, repoRoot: f.workspace };
  let preparations = 0;
  const options = { queue, setupAgentBranch: async args => {
    preparations++;
    assert.equal(args.repoRoot, f.workspace);
    assert.equal(args.runSetup, true);
    assert.equal(args.runBuild, false);
    queue.setPreparation(prepared(f.workspace));
    return prepared(f.workspace);
  } };
  const first = await assignIncident(config, incident, 1, options);
  assert.ok(first?.id, "a terminal failed task is not an active incident");
  assertSpoolPrompt(f.store.task(first.id).prompt);
  assert.equal(await assignIncident(config, incident, 1, options), null, "active incident prevents competing work");
  finishThroughMcp(f, f.store.task(first.id), terminal);
  const replay = await assignIncident(config, incident, 1, options);
  assert.equal(replay.id, first.id, "same event/attempt is idempotent after restart");
  assert.equal(preparations, 1, "replay must not prepare an already-authored branch again");
  const second = await assignIncident(config, incident, 2, options);
  assert.notEqual(second.id, first.id, "new attempt must not reuse a terminal task");
  assert.equal(f.store.task(second.id).status, "incoming");
  assert.equal(f.store.task(first.id).status, terminal);
  assert.equal(f.store.tasks().length, 20);
});

test("livesite preparation failure does not publish an incident", async t => {
  const f = fixture(t), agent = "software-engineer";
  const queue = createSpoolQueue(f.store, { agent, workspace: f.workspace, runner: "livesite" });
  const { assignIncident } = await engine("livesite/lib/delivery.mjs");
  await assert.rejects(assignIncident({ agentId: agent, repoRoot: f.workspace }, incident, 1, {
    queue, setupAgentBranch: async () => { throw new Error("fixture installation failure"); },
  }), /installation failure/);
  assert.equal(f.store.tasks().length, 0);
});

test("livesite retries delivery failures without inventing Azure outages or consuming cooldown", async t => {
  const f = fixture(t), agent = "software-engineer";
  const { config } = configure({ spool_dir: f.root,
    livesite: { enabled: true, workspace_dir: f.workspace },
  }, "livesite", f.root);
  const queue = createSpoolQueue(f.store, { agent, workspace: f.workspace, runner: "livesite" });
  const { runLivesite } = await engine("livesite/run.mjs");
  let failPreparation = true;
  let preparations = 0;
  const builds = Array.from({ length: 3 }, (_, index) => ({
    id: String(123 - index), number: `fixture-${index}`, definitionId: 8228,
    status: "completed", result: "canceled", finishTime: new Date(Date.now() - index * 1000).toISOString(),
  }));
  const options = {
    config: { ...config, definitions: [{ id: 8228 }] }, queue, once: true,
    queryBuilds: async () => builds,
    queryTimeline: async () => { throw new Error("Canceled builds must not require timelines"); },
    setupAgentBranch: async () => {
      preparations++;
      if (failPreparation) throw new Error("Branch already contains work");
      const result = prepared(f.workspace);
      queue.setPreparation(result);
      return result;
    },
  };
  const run = () => runLivesite(pathToFileURL(path.join(f.root, "run.mjs")), options);
  for (let attempt = 0; attempt < 2; attempt++) {
    await run();
    const state = JSON.parse(readFileSync(path.join(f.root, ".runner", "state.json")));
    const status = JSON.parse(readFileSync(path.join(f.root, ".runner", "status.json")));
    assert.equal(state.consecutiveScanFailures, 0);
    assert.deepEqual(state.alerts, {});
    assert.equal(state.lastAssessment.assessments[0].kind, "manual_action");
    assert.equal(state.lastAssessment.deliveryErrors.length, 1);
    assert.equal(status.deliveryFailed, 1);
    assert.match(status.lastError, /Branch already contains work/);
    assert.equal(f.store.tasks().length, 0);
  }
  failPreparation = false;
  await run();
  await run();
  assert.equal(preparations, 3, "the confirmed submission consumes cooldown; failed preparation does not");
  assert.equal(f.store.tasks().length, 1);
  const state = JSON.parse(readFileSync(path.join(f.root, ".runner", "state.json")));
  assert.equal(Object.values(state.alerts)[0].attempt, 1);
  assert.equal(state.lastAssessment.deliveryErrors.length, 0);
});

test("real reviewer loop detects, prepares, publishes once, reads completion and admits a changed revision", async t => {
  const f = fixture(t), agent = "pr-reviewer";
  const { config } = configure({ spool_dir: f.root,
    ado: { author_account: "fixture@example.invalid" },
    pr_reviewer: { enabled: true, workspace_dir: f.workspace },
  }, "pr-reviewer", f.root);
  config.revisionSettleSeconds = 0;
  const queue = createSpoolQueue(f.store, { agent, workspace: f.workspace, runner: "pr-reviewer" });
  const { runReviewer } = await engine("pr-reviewer/run.mjs");
  const { paperclipReviewerTasks } = await engine("pr-reviewer/lib/task-source.mjs");
  const { prepareReviewWorkspace } = await engine("pr-reviewer/lib/workspace.mjs");
  const pr = { id: "123", repository: "fixture", title: "Fixture review", sourceCommit: sha,
    url: "https://example.invalid/pr/123", status: "active", isDraft: false,
    reviewerVote: 0, selfAuthored: false, olderThanMaxAge: false, eligible: true, reasons: [] };
  let preparations = 0, freshReads = 0;
  const options = {
    config, queue, once: true, taskSource: cfg => paperclipReviewerTasks(cfg, queue),
    isBusy: async () => false,
    scanAssignedPullRequests: async (_config, flags) => {
      if (flags?.fresh) freshReads++;
      return { detected: [{ ...pr }], eligible: [{ ...pr }] };
    },
    prepareWorkspace: async args => {
      preparations++;
      const value = await prepareReviewWorkspace({ ...args, call: async (_tool, input) => {
        assert.equal(input.runSetup, true);
        assert.equal(input.runBuild, false, "review must not wait for an unconditional monorepo build");
        assert.equal(input.reset, false);
        assert.equal(input.mergeMaster, false);
        return { ready: true, branch: input.branch, commit: input.sourceCommit, repoRoot: input.repoRoot };
      } });
      queue.setPreparation(value);
      return value;
    },
  };
  const run = () => runReviewer(pathToFileURL(path.join(f.root, "run.mjs")), options);
  await run();
  const first = f.store.tasks()[0];
  assert.ok(first, "eligible revision reached the real Spool filesystem queue");
  assert.equal(first.agent, agent);
  assert.equal(first.workspace, f.workspace);
  assert.match(first.prompt, new RegExp(sha));
  assertSpoolPrompt(first.prompt, agent);
  assert.equal(freshReads, 1);
  await run();
  assert.equal(f.store.tasks().length, 1);
  assert.equal(preparations, 1);
  finishThroughMcp(f, first);
  await run();
  assert.equal(f.store.tasks().length, 1);
  assert.equal(JSON.parse(readFileSync(path.join(f.root, ".runner", "status.json"))).completed, 1);
  pr.sourceCommit = "b".repeat(40);
  await run();
  assert.equal(f.store.tasks().length, 2);
  assert.equal(preparations, 2);
  assert.equal(freshReads, 2);
});

test("failed reviews remain blocked against duplicate dispatch while capacity is released", async t => {
  const f = fixture(t);
  f.put({ id: "review-failed", agent: "pr-reviewer", title: "Review Azure DevOps pull request #123: Fixture",
    prompt: `Source commit: ${sha}` }, "failed");
  const queue = createSpoolQueue(f.store, { agent: "pr-reviewer", workspace: f.workspace, runner: "pr-reviewer" });
  const { paperclipReviewerTasks } = await engine("pr-reviewer/lib/task-source.mjs");
  const receipts = await paperclipReviewerTasks({ agentId: "pr-reviewer" }, queue);
  assert.equal(receipts.get(`123:${sha}`).status, "blocked");
  await assertAgentWorkspaceIdle(queue, "pr-reviewer");
});

test("shared numeric task reconciliation closes terminal failures without successful measurements", async t => {
  const f = fixture(t);
  f.put({ id: "failed-metric", agent: "perf", prompt: "after: 1" }, "failed");
  const queue = createSpoolQueue(f.store, { agent: "perf", workspace: f.workspace, runner: "perf" });
  const task = { issueId: "failed-metric", metric: "fixture.metric", current: 100, acceptance: 50 };
  const verdict = checkAcceptance(task, await queue.getIssue(task.issueId));
  assert.equal(verdict.transition, "closed");
  assert.equal(verdict.verdict, "failed");
  const telemetry = createTelemetryWriter({ path: path.join(f.root, "cycles.jsonl"), tool: "perf" });
  telemetry.append("task_transition", { ...task, transition: "opened" });
  const config = { tool: "fixture", telemetry, queue,
    collectors: [{ name: "fixture", collect: () => [] }], selector: () => ({ candidate: null }) };
  const changes = await runCycle(config);
  assert.equal(changes.transitions[0].verdict, "failed");
  assert.equal(rollup(telemetry.read()).openTasks.length, 0);
  assert.equal((await runCycle(config)).transitions.length, 0, "failure is not reopened next scan");
});

for (const runner of ["perf", "docs", "slop"]) test(`${runner} handoff carries common Spool closure instructions`, async t => {
  const f = fixture(t), agent = runner === "perf" ? "perf" : "tech-writer";
  const queue = createSpoolQueue(f.store, { agent, workspace: f.workspace, runner });
  queue.setPreparation(prepared(f.workspace));
  const issue = await queue.createIssue({ assigneeAgentId: agent, title: "Fixture measured work",
    description: "metric: fixture\ncurrent: 100\ntarget: 50\nRecord after: with the measured result." });
  assert.equal(f.store.metadata(issue.id).runner, runner);
  assertSpoolPrompt(f.store.task(issue.id).prompt);
  finishThroughMcp(f, f.store.task(issue.id));
});

test("real livesite loop detects a regression, publishes once, retains cooldown across restart and observes recovery", async t => {
  const f = fixture(t), agent = "software-engineer";
  const { config } = configure({ spool_dir: f.root, livesite: { enabled: true, workspace_dir: f.workspace } }, "livesite", f.root);
  const queue = createSpoolQueue(f.store, { agent, workspace: f.workspace, runner: "livesite" });
  const { runLivesite } = await engine("livesite/run.mjs");
  const now = Date.now();
  const builds = [2, 1].map(id => ({
    id: String(id), number: `fixture-${id}`, definitionId: "8228", status: "completed", result: "failed",
    queueTime: new Date(now - (3 - id) * 60_000).toISOString(),
    finishTime: new Date(now - (3 - id) * 60_000).toISOString(),
    sourceBranch: "refs/heads/master", sourceVersion: sha, url: `https://example.invalid/build/${id}`,
  }));
  let preparations = 0;
  const options = { config, queue, once: true,
    queryBuilds: async () => builds,
    queryTimeline: async () => [{ name: "Tests", result: "failed",
      issues: ["Your build failed on the following packages => [@fluidx/fixture test]"] }],
    setupAgentBranch: async () => {
      preparations++;
      queue.setPreparation(prepared(f.workspace));
      return prepared(f.workspace);
    },
  };
  const run = () => runLivesite(pathToFileURL(path.join(f.root, "run.mjs")), options);
  await run();
  assert.equal(f.store.tasks().length, 1);
  let state = JSON.parse(readFileSync(path.join(f.root, ".runner", "state.json")));
  assert.equal(Object.values(state.alerts)[0].issueId, f.store.tasks()[0].id);
  finishThroughMcp(f, f.store.tasks()[0]);
  await run();
  assert.equal(preparations, 1);
  assert.equal(f.store.tasks().length, 1);
  builds[0].result = "succeeded";
  await run();
  state = JSON.parse(readFileSync(path.join(f.root, ".runner", "state.json")));
  assert.equal(state.lastAssessment.assessments[0].kind, "healthy");
  assert.equal(state.lastAssessment.assessments[0].actionable, false);
});
