import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fixture } from "./fixtures.mjs";
import { writeJson } from "../spool-files.mjs";
import { configure } from "../config.mjs";
import { codespaceReviewer, codespaceReviewInUse, codespaceReviewPending } from "../codespace-reviewer.mjs";
import { recoveryCommandId } from "../control-identity.mjs";
import { taskBody } from "../../scanners/pr-reviewer/lib/work-queue.mjs";
import { createSpoolQueue, renderSpoolTaskPrompt } from "../queue.mjs";
import { definition } from "../workflow-store.mjs";
import { createEventPipeline, bindEventQueue, eventPreparer } from "../workflow-event-pipeline.mjs";
import { createWorkspacePreparer } from "../workspace-preparation.mjs";
import { runReviewer } from "../../scanners/pr-reviewer/run.mjs";
import { paperclipReviewerTasks } from "../../scanners/pr-reviewer/lib/task-source.mjs";

test("Codespace configuration is opt-in and scoped to Office/1JS", t => {
  const f = fixture(t);
  const file = path.join(f.root, "codespace.json");
  writeFileSync(file, "{}");
  const input = { spool_dir: f.root, repository_profile: "1js", codespace_review_config: file,
    ado: { organization: "office", project: "Office", repository: "1JS" },
    pr_reviewer: { enabled: true, workspace_dir: f.workspace } };
  const { config } = configure(input, "pr-reviewer", f.root);
  assert.equal(config.codespaceReviewConfig, file);
  assert.equal(config.scopes[0].repository, "1JS");
  assert.throws(() => configure({ ...input, repository_profile: "bohemia" }, "pr-reviewer", f.root), /Codespace review/);
  const legacy = configure({ ...input, codespace_review_config: undefined, repository_profile: undefined }, "pr-reviewer", f.root);
  assert.equal(legacy.config.codespaceReviewConfig, undefined);
});
test("remote reviewer releases previous owned lifecycle before preparing next revision", async () => {
  const actions = [];
  const prepareSession = async (repo, input) => {
    assert.equal(repo, "1js");
    actions.push(input.reviewPullRequestId);
    return { result: { structuredContent: { ready: true, repoRoot: input.repoRoot, commit: input.sourceCommit } },
      close: async () => actions.push("release") };
  };
  const reviewer = codespaceReviewer({ codespaceReviewConfig: "fixture" }, { prepareSession });
  await reviewer.prepare({ prId: 1, sourceCommit: "a".repeat(40), repoRoot: "fixture" });
  await reviewer.prepare({ prId: 2, sourceCommit: "b".repeat(40), repoRoot: "fixture" });
  await reviewer.dispose();
  await reviewer.dispose();
  assert.deepEqual(actions, [1, "release", 2, "release"]);
});
test("remote lifecycle remains owned while the reviewer task awaits pickup or its session is still live", () => {
  let tasks = [{ agent: "pr-review", status: "incoming" }], live = [];
  const store = { tasks: () => tasks, liveTasks: values => {
    assert.equal(values, tasks);
    return live;
  } };
  assert.equal(codespaceReviewInUse(store, "pr-review"), true);
  tasks = [{ agent: "pr-review", status: "completed" }];
  live = [tasks[0]];
  assert.equal(codespaceReviewInUse(store, "pr-review"), true);
  live = [];
  assert.equal(codespaceReviewInUse(store, "pr-review"), false);
  tasks = [{ agent: "another-agent", status: "incoming" }];
  assert.equal(codespaceReviewInUse(store, "pr-review"), false);
});
for (const state of ["incoming", "starting", "admission", "running", "surviving"])
for (const matching of [true, false])
test(`operator retry requires its own lease without releasing ordinary review ownership: ${state}, ${matching}`, async t => {
  const f = fixture(t), agent = "pr-reviewer", session = randomUUID();
  const message = { id: randomUUID(), text: "Try again", status: "queued" };
  const task = { id: "original-review", agent, session_id: session, workspace: f.workspace,
    status: ["admission", "surviving"].includes(state) ? "failed" : state === "incoming" ? "incoming" : "in_progress",
    interaction: { phase: state === "starting" ? "starting" : state === "running" ? "running" : "ended",
      messages: [message], applied_requests: [message.id] } };
  writeJson(path.join(f.root, "controls", "commands", `${message.id}.json`), {
    input: { id: message.id, kind: "message", taskId: task.id, message: matching ? message.text : "Different input" },
    request: { kind: "message", taskId: task.id, agent, workspace: f.workspace },
    conversation: { sessionId: session },
  });
  if (state === "admission")
    writeJson(path.join(f.root, "controls", "manual", `${randomUUID()}.json`), {
      status: "waiting", request: { kind: "status", taskId: task.id, agent,
        expectedStatus: "failed", status: "in_progress" },
    });
  const store = { root: f.root, tasks: () => [task],
    liveTasks: () => ["starting", "running", "surviving"].includes(state) ? [task] : [] };
  assert.equal(codespaceReviewInUse(store, agent), ["running", "surviving"].includes(state) || !matching);
  assert.equal(codespaceReviewPending(store, agent), matching && ["incoming", "admission", "surviving"].includes(state));
  if (matching && !["running", "surviving"].includes(state)) {
    let closed = 0;
    const reviewer = codespaceReviewer({}, {
      prepareSession: async (_repo, input) => ({
        result: { structuredContent: { ready: true, repoRoot: input.repoRoot, commit: input.sourceCommit } },
        close: async () => { closed++; },
      }),
      delay: () => assert.fail("An operator continuation must not wait on the idle runner lease it needs"),
    });
    await reviewer.prepare({ prId: 1, sourceCommit: "a".repeat(40), repoRoot: f.workspace });
    await reviewer.drain(store, agent);
    assert.equal(closed, 1);
  }
});
for (const terminal of ["manual", "results"])
test(`retired operator recovery does not indefinitely reserve the reviewer: ${terminal}`, t => {
  const f = fixture(t), agent = "pr-reviewer", message = { id: randomUUID(), text: "Try again", status: "queued" };
  const task = { id: "original-review", agent, status: "failed", updated_at: "2026-11-14T04:19:41Z",
    error: "Copilot ACP startup failed: Codespace workspace is busy with another operation; retry after it finishes.",
    interaction: { phase: "ended", chat_return: { status: "completed" }, messages: [message] } };
  const store = { root: f.root, tasks: () => [task] };
  assert.equal(codespaceReviewPending(store, agent), true);
  const id = recoveryCommandId(task, message, true);
  writeJson(path.join(f.root, "controls", terminal, `${id}.json`),
    terminal === "manual" ? { status: "failed" } : { result: { status: "failed" } });
  assert.equal(codespaceReviewPending(store, agent), false);
});
test("draining the runner preserves its live native borrower until normal completion", async () => {
  let live = true, closed = 0, recovered = 0;
  const task = { id: "borrower", agent: "pr-review", status: "in_progress" };
  const store = { tasks: () => [task], liveTasks: () => live ? [task] : [] };
  const reviewer = codespaceReviewer({}, {
    prepareSession: async (_repo, input) => ({
      result: { structuredContent: { ready: true, repoRoot: input.repoRoot, commit: input.sourceCommit } },
      close: async () => { closed++; },
    }),
    delay: async () => {
      assert.equal(closed, 0, "The runner must retain the lease while its borrower is live");
      live = false;
      task.status = "completed";
    },
  });
  await reviewer.prepare({ prId: 1, sourceCommit: "a".repeat(40), repoRoot: "fixture" });
  await reviewer.drain(store, "pr-review", async () => { recovered++; });
  assert.equal(recovered, 1);
  assert.equal(closed, 1);
});
test("remote review scan releases idle ownership before admitting recovery without a repository-profile output field", t => {
  const f = fixture(t), agent = "pr-reviewer", session = randomUUID(), id = randomUUID();
  const profile = path.join(f.root, "codespace.json");
  writeJson(profile, { purpose: "review", workspace: f.workspace, remoteRoot: "/workspaces/1JS" });
  const input = { spool_dir: f.root, repository_profile: "1js", codespace_review_config: profile,
    ado: { organization: "office", project: "Office", repository: "1JS" },
    copilotProviders: { [agent]: { command: process.execPath, args: ["--config", profile],
      workingDirectory: "/workspaces/1JS" } },
    pr_reviewer: { enabled: true, workspace_dir: f.workspace } };
  writeJson(path.join(f.root, "spool.json"), { copilotProviders: input.copilotProviders });
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, statusControl: true, taskControl: true, updatedAt: new Date().toISOString(),
  });
  f.put({ id: "original-review", agent, session_id: session,
    runner_metadata: { runner: "pr-reviewer", preparation: f.preparation },
    interaction: { phase: "waiting_preparation", chat_return: { status: "completed" },
      messages: [{ id, text: "Try again", status: "queued" }] } }, "failed");
  const scanner = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import path from "node:path";
    export async function runReviewer(entry, options) {
      options.onLifecycle({ observe() {} });
      await options.wrapScan(async () => {
        const directory = ${JSON.stringify(path.join(f.root, "controls", "requests"))};
        const files = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
        assert.equal(files.length, 1, "Queued retry must be admitted before scanning for another PR");
        assert.equal(JSON.parse(fs.readFileSync(path.join(directory, files[0]))).taskId, "original-review");
        assert.equal(await options.isBusy(), true, "Pending original input must prevent a new borrowed preparation");
        return {};
      });
    }
  `;
  const script = `
    import { registerHooks } from "node:module";
    registerHooks({ load(url, context, next) {
      if (url.endsWith("/scanners/pr-reviewer/run.mjs")) return { format: "module", shortCircuit: true,
        source: ${JSON.stringify(scanner)} };
      if (url.endsWith("/bridge/codespace-reviewer.mjs")) return { format: "module", shortCircuit: true,
        source: 'export * from ' + JSON.stringify(url + "?actual") + ';' +
          'import {codespaceReviewer as actual} from ' + JSON.stringify(url + "?actual") + ';' +
          'export function codespaceReviewer(...args) { const reviewer = actual(...args), dispose = reviewer.dispose;' +
          'reviewer.dispose = async () => { await dispose(); globalThis.idleReviewOwnershipReleased = true; }; return reviewer; }' };
      if (url.endsWith("/bridge/monitor-controls.mjs")) return { format: "module", shortCircuit: true,
        source: 'export * from ' + JSON.stringify(url + "?actual") + ';' +
          'import assert from "node:assert/strict"; import {createMonitorControls as actual} from ' +
          JSON.stringify(url + "?actual") + ';' +
          'export function createMonitorControls(...args) { const controls = actual(...args), jobs = controls.jobs;' +
          'controls.jobs = async () => { assert.equal(globalThis.idleReviewOwnershipReleased, true,' +
          '"Release idle reviewer ownership before attempting an independent continuation"); return jobs(); }; return controls; }' };
      return next(url, context);
    } });
    process.argv.push("--watch", "--service");
    const { run } = await import(${JSON.stringify(new URL("../run.mjs", import.meta.url).href)});
    await run("pr-reviewer", new URL(${JSON.stringify(pathToFileURL(path.join(f.root, "run.mjs")).href)}),
      undefined, ${JSON.stringify(input)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", windowsHide: true, timeout: 15000,
  });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stderr}`);
});
test("remote handoff keeps connection and task-delivery instructions out of the PR prompt", async t => {
  const f = fixture(t);
  const prepared = { ready: true, repoRoot: f.workspace, commit: "a".repeat(40), branch: "review/pr-1-aaaa",
    runtime: { url: "https://localhost:3000/library?tanstack=3" },
    execution: { kind: "codespace", codespace: "fixture", nativeRepoRoot: "/workspaces/1JS",
      command: "C:\\tools\\run.mjs", configFile: "C:\\tools\\config.json" } };
  const pr = { id: "1", title: "Fixture", sourceCommit: prepared.commit, url: "https://example.invalid/pr/1" };
  const attempt = { transport: "spool" };
  const prompt = taskBody(pr, attempt, prepared);
  assert.equal(prompt, [
    "Review Azure DevOps pull request #1: Fixture",
    "PR URL: https://example.invalid/pr/1",
    `Source commit: ${prepared.commit}`,
    `Branch: ${prepared.branch}`,
  ].join("\n"));
  assert.doesNotMatch(prompt, /spool_|PAPERCLIP|\/workspaces\/1JS|Prepared remote|exec --config|verify --config|localhost:3000/);
  const queue = createSpoolQueue(f.store, { agent: "pr-reviewer", workspace: f.workspace, runner: "pr-reviewer" });
  queue.setPreparation(prepared);
  const task = await queue.createIssue({ title: "Review", description: prompt, assigneeAgentId: "pr-reviewer" });
  assert.equal(task.workspace, f.workspace);
  assert.equal(task.description, renderSpoolTaskPrompt(prompt, "pr-reviewer", "", "pr-reviewer"));
});
test("remote runtime facts do not add instructions to the verbatim reviewer message", () => {
  const pr = { id: "2", title: "Bebop factories", sourceCommit: "a".repeat(40), url: "fixture" };
  const prepared = { repoRoot: "C:\\control", commit: "a".repeat(40), branch: "review/fixture",
      runtime: { kind: "package", verified: true },
      execution: { kind: "codespace", nativeRepoRoot: "/workspaces/1JS",
        command: "C:\\tools\\run.mjs", configFile: "C:\\config.json" } };
  for (const phase of ["initial", "revision"]) {
    const attempt = { transport: "spool", phase, retryOf: "failed-review", retryUpdatedAt: "2026-10-22T00:00:00Z" };
    const prompt = taskBody(pr, attempt, prepared);
    assert.equal(taskBody(pr, attempt, { ...prepared, runtime: { url: "https://localhost:3000/" } }), prompt);
    assert.doesNotMatch(prompt, /Application:|executable package tests|no application URL|C:\\control|spool_|PAPERCLIP/);
  }
});

for (const succeeds of [true, false]) {
  test(`the unchanged reviewer loop ${succeeds ? "prepares and hands off once" : "retains queued work without handing off a failed preparation"} for the configured 1JS agent`, async t => {
    const f = fixture(t), agent = "pr-review", sha = "a".repeat(40);
    const role = path.join(f.root, "agents", `${agent}.md`);
    writeFileSync(role, "Existing reviewer role: post verified findings and approve clean reviews.");
    const file = path.join(f.root, "codespace.json");
    writeFileSync(file, "{}");
    const input = { spool_dir: f.root, repository_profile: "1js", codespace_review_config: file,
      ado: { organization: "office", project: "Office", repository: "1JS", author_account: "fixture@example.invalid" },
      pr_reviewer: { enabled: true, agent, workspace_dir: f.workspace } };
    const { config } = configure(input, "pr-reviewer", f.root);
    const workflow = definition(input, "pr-reviewer");
    const bohemia = definition({ ...input, pr_reviewer: { ...input.pr_reviewer, agent: "pr-reviewer" } }, "pr-reviewer");
    assert.deepEqual(workflow.nodes.map(node => ({ ...node, ...(node.agent ? { agent: "pr-reviewer" } : {}) })), bohemia.nodes);
    assert.deepEqual(workflow.edges, bohemia.edges);
    let preparations = 0, verifications = 0, freshReads = 0;
    const prepared = { ready: true, repoRoot: f.workspace, branch: "review/pr-123-aaaaaaaaaaaa",
      commit: sha, sourceCommit: sha, preparationKind: "repository-prepare",
      execution: { kind: "codespace", codespace: "fixture", nativeRepoRoot: "/workspaces/1JS",
        command: "C:\\tools\\run.mjs", configFile: file } };
    const prepareSession = async (repo, options) => {
        preparations++;
        assert.equal(repo, "1js");
        assert.equal(options.reviewPullRequestId, 123);
        assert.equal(options.sourceCommit, sha);
        assert.equal(options.repoRoot, f.workspace);
        assert.equal(options.operation, "branch");
        assert.equal(options.mode, "checkout");
        assert.equal(options.reset, false);
        assert.equal(options.mergeMaster, false);
        assert.equal(options.runSetup, true);
        assert.equal(options.runBuild, true);
        if (!succeeds) throw new Error("Scoped remote preparation failed");
        return { result: { structuredContent: prepared }, close: async () => {} };
    };
    const remote = codespaceReviewer(config, { prepareSession, verify: async value => {
      assert.deepEqual(value, prepared);
      verifications++;
    } });
    t.after(() => remote.dispose());
    const queue = createSpoolQueue(f.store, { agent, workspace: f.workspace, runner: "pr-reviewer" });
    const call = async () => assert.fail("Codespace preparation must not call local Bohemia commands");
    const pipeline = createEventPipeline(workflow, { store: f.store, runtime: config.runtimeDirectory, call,
      verifyPreparation: value => remote.verify(value) });
    bindEventQueue(queue, pipeline);
    const prepare = createWorkspacePreparer({ store: f.store, queue, agent, workspace: f.workspace, call,
      prepare: options => remote.prepare(options) });
    const pr = { id: "123", repository: "1JS", title: "Fixture", sourceCommit: sha,
      url: "https://example.invalid/pr/123", status: "active", isDraft: false,
      reviewerVote: 0, selfAuthored: false, olderThanMaxAge: false, eligible: true, reasons: [] };
    const options = { config, queue, once: true, taskSource: cfg => paperclipReviewerTasks(cfg, queue),
      isBusy: async () => f.store.liveTasks().some(task => task.agent === agent),
      scanAssignedPullRequests: async (_config, flags) => {
        if (flags?.fresh) freshReads++;
        return { detected: [{ ...pr }], eligible: [{ ...pr }] };
      },
      prepareWorkspace: eventPreparer(pipeline, prepare, f.workspace),
      wrapScan: async scan => { try { return await scan(); } finally { pipeline.completeScan(); } },
    };
    const scan = () => runReviewer(pathToFileURL(path.join(f.root, "run.mjs")), options);
    await scan();
    assert.equal(preparations, 1, readFileSync(path.join(f.root, ".runner", "status.json"), "utf8"));
    assert.equal(f.store.tasks().length, succeeds ? 1 : 0,
      readFileSync(path.join(f.root, ".runner", "status.json"), "utf8"));
    if (succeeds) {
      const task = f.store.tasks()[0];
      assert.equal(task.agent, agent);
      assert.equal(task.workspace, f.workspace);
      assert.equal(task.prompt, renderSpoolTaskPrompt(taskBody(pr, { transport: "spool" }, prepared), agent, "", "pr-reviewer"));
      assert.doesNotMatch(task.prompt, /## Spool task delivery|Task-system adapter only/);
      assert.doesNotMatch(task.prompt, /spool_add_comment|spool_update_task_status|spool_get_task/);
      assert.match(task.prompt, /^Review Azure DevOps pull request #123: Fixture\n/);
      assert.doesNotMatch(task.prompt, /Do not post PR comments|read-only externally|Never publish/);
      assert.deepEqual(f.store.metadata(task.id).preparation, prepared);
      assert.equal(verifications, 1);
      assert.equal(freshReads, 2);
      await scan();
      assert.equal(preparations, 1);
      assert.equal(f.store.tasks().length, 1);
    } else {
      const status = JSON.parse(readFileSync(path.join(f.root, ".runner", "status.json"), "utf8"));
      assert.match(status.lastError, /Scoped remote preparation failed/);
      assert.equal(verifications, 0);
      assert.equal(freshReads, 2);
    }
    assert.equal(readFileSync(role, "utf8"), "Existing reviewer role: post verified findings and approve clean reviews.");
  });
}
