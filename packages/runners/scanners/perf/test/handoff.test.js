import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTaskIssue } from "../../../packages/bohemia-agent-tooling/src/index.js";
import { appPath } from "../artifacts.mjs";
import { collectArtifacts } from "../build.mjs";
import { benchmark, rootMetric } from "../benchmark.mjs";
import { performanceHandoff, renderPerformanceTask } from "../handoff.mjs";
import { renderSpoolTaskPrompt } from "../../../bridge/queue.mjs";
import { withAdmission } from "../../../bridge/admission.mjs";
import { artifactFixture, buildCall, emitArtifacts, proofFixture } from "./fixtures.js";

async function handoffFixture(t) {
  const f = proofFixture(t), calls = [];
  mkdirSync(path.join(f.root, "controls"), { recursive: true });
  writeFileSync(path.join(f.root, "controls", "capabilities.json"),
    JSON.stringify({ bundleAcceptanceVersion: 2, updatedAt: new Date().toISOString() }));
  cpSync(path.join(f.directory, "baseline", appPath), f.app, { recursive: true });
  cpSync(f.directory, path.join(f.config.runtimeDirectory, "bundle-proofs", "page"), { recursive: true });
  f.git("add", "."); f.git("commit", "-qm", "route source");
  f.scan.commit = f.git("rev-parse", "HEAD");
  await collectArtifacts({ scan: f.scan, receiptPath: path.join(f.config.runtimeDirectory, "artifact-build.json"),
    call: async () => ({ ...f.scan, ready: true, productionArtifacts: true }) });
  execFileSync("git", ["clone", "-q", "--local", f.repoRoot, f.workspace], { windowsHide: true, stdio: "pipe" });
  const agentGit = (...args) => execFileSync("git", args, {
    cwd: f.workspace, encoding: "utf8", windowsHide: true, stdio: "pipe",
  }).trim();
  const call = async (tool, args) => {
    calls.push({ tool, args });
    assert.equal(args.repoRoot, f.workspace, "release may prepare/build only the assigned task checkout");
    if (tool === "bohemia_prepare") {
      assert.deepEqual(args, { repoRoot: f.workspace, operation: "branch",
        branch: args.branch, baseBranch: "master", mode: "checkout", reset: false, runSetup: true, runBuild: true,
        sourceCommit: f.scan.commit, mergeMaster: false });
      agentGit("checkout", "-qb", args.branch, args.sourceCommit);
    } else {
      assert.equal(tool, "bohemia_build");
      assert.deepEqual(args, { repoRoot: f.workspace, packages: ["@fluidx/new-office"], productionArtifacts: true });
      for (const directory of ["dist", "bundleAnalysis"]) {
        cpSync(path.join(f.directory, "baseline", appPath, directory),
          path.join(f.workspace, appPath, directory), { recursive: true });
      }
    }
    return { repoRoot: f.workspace, branch: agentGit("branch", "--show-current"),
      commit: agentGit("rev-parse", "HEAD"), ready: true, productionArtifacts: tool === "bohemia_build" };
  };
  const options = { config: f.config, store: f.store, workspace: f.workspace,
    item: "unused-route-export-PageContent", call, listPullRequests: async () => [] };
  const preview = await performanceHandoff(options);
  return { ...f, options, preview, calls, call, agentGit };
}

test("preview has the legacy five-field brief and never prepares or queues work", async t => {
  const f = await handoffFixture(t);
  assert.equal(f.preview.status, "preview_only");
  assert.equal(f.preview.dispatched, 0);
  assert.deepEqual(f.calls, []);
  assert.equal(f.store.tasks().length, 0);
  const rendered = renderPerformanceTask(f.preview.issue, f.workspace);
  const original = buildTaskIssue({
    metric: rootMetric, current: f.preview.issue.initialBrotliBytes.before,
    target: f.preview.issue.initialBrotliBytes.after, acceptance: f.preview.issue.initialBrotliBytes.after,
    unit: "bytes", reproduction: /^reproduction: (.+)$/m.exec(rendered.brief)[1],
  });
  assert.equal(rendered.brief, original.body);
  assert.equal(f.preview.prompt, renderSpoolTaskPrompt(rendered.body));
  assert.match(rendered.brief, /^after: <number>$/m);
  assert.doesNotMatch(rendered.brief, /checked out.*verified clean/);
  assert.doesNotMatch(f.preview.prompt, /paperclip|compatibility|supersede|report-defect|PerfEngineManager|bohemia_pr_create/i);
  assert.match(f.preview.prompt, /Push with bohemia push before creating the PR with bohemia_pr/);
  assert.match(f.preview.prompt, /Confirm the remote branch exists first/);
  assert.ok(f.preview.prompt.length < 5000, "Handoff must remain concise despite the explicit scenario matrix");
  assert.match(f.preview.prompt, /five seconds after ready/);
  assert.match(f.preview.prompt, /including workers/);
  assert.match(f.preview.prompt, /suggestion-to-composer/);
});

test("approved fixture uses canonical preparation and delivers the exact brief through native Spool MCP once", async t => {
  const f = await handoffFixture(t);
  const result = await performanceHandoff({ ...f.options, approval: f.preview.approval });
  assert.equal(result.dispatched, 1);
  const task = f.store.task(result.taskId), metadata = f.store.metadata(result.taskId);
  assert.equal(task.agent, "perf");
  assert.equal(task.workspace, f.workspace);
  assert.equal(task.prompt, renderSpoolTaskPrompt(
    renderPerformanceTask(f.preview.issue, f.workspace, metadata.preparation.branch).body));
  assert.match(task.prompt, /checked out.*verified clean/);
  const binary = process.env.SPOOL_TEST_BINARY ||
    fileURLToPath(new URL(`../../../../spool/target/release/spool${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05",
      capabilities: {}, clientInfo: { name: "perf-handoff-fixture", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "spool_get_task", arguments: {} } },
  ];
  const output = spawnSync(binary, ["--root", f.root, "mcp", "--agent", "perf", "--task", task.id], {
    input: requests.map(row => JSON.stringify(row)).join("\n") + "\n", encoding: "utf8",
    windowsHide: true, timeout: 15_000,
  });
  assert.equal(output.status, 0, `${output.error ?? ""}\n${output.stderr}`);
  const response = output.stdout.trim().split(/\r?\n/).map(JSON.parse).find(row => row.id === 2);
  assert.notEqual(response.result.isError, true, JSON.stringify(response));
  const delivered = JSON.parse(response.result.content[0].text);
  assert.equal(delivered.prompt, task.prompt);
  assert.equal(delivered.status, "incoming", "MCP inspection must not start an agent");
  assert.deepEqual(delivered.acceptance, task.acceptance);
  assert.equal(metadata.acceptance.kind, "bundle-v2");
  const replay = await performanceHandoff({ ...f.options, approval: f.preview.approval });
  assert.equal(replay.status, "already_released");
  assert.equal(replay.taskId, result.taskId);
  assert.equal(f.store.tasks().length, 1);
  assert.deepEqual(f.calls.map(row => row.tool), ["bohemia_prepare", "bohemia_build"]);
});

test("a competing preparation explicitly holds preview and release without doing either", async t => {
  const f = await handoffFixture(t);
  await withAdmission(f.root, "perf", async () => {
    for (const approval of [undefined, f.preview.approval]) {
      const result = await performanceHandoff({ ...f.options, approval });
      assert.equal(result.status, "held");
      assert.equal(result.dispatched, 0);
    }
  }, f.workspace);
  assert.deepEqual(f.calls, []);
  assert.equal(f.store.tasks().length, 0);
});

test("one-task capacity approval is bound to the preview, audited, and cannot create a second task", async t => {
  const f = await handoffFixture(t);
  const options = { ...f.options, allowOneExtraTask: true,
    listPullRequests: async () => Array.from({ length: 4 }, (_, index) => ({ branch: `user/fixture/perf-${index}` })) };
  await assert.rejects(performanceHandoff({ ...options, approval: f.preview.approval }), /Preview changed/);
  const preview = await performanceHandoff(options);
  const result = await performanceHandoff({ ...options, approval: preview.approval });
  assert.equal(result.dispatched, 1);
  assert.deepEqual(f.store.metadata(result.taskId).handoff,
    { item: options.item, approval: preview.approval, allowOneExtraTask: true });
  assert.equal((await performanceHandoff({ ...options, approval: preview.approval })).status, "already_released");
  assert.equal(f.store.tasks().length, 1);
  assert.equal(f.calls.filter(row => row.tool === "bohemia_prepare").length, 1);
});

for (const reason of ["paused", "busy", "stale-proof"]) {
  test(`a one-task capacity exception does not bypass ${reason}`, async t => {
    const f = await handoffFixture(t);
    const options = { ...f.options, allowOneExtraTask: true };
    const preview = await performanceHandoff(options);
    if (reason === "paused") {
      mkdirSync(path.join(f.root, "controls", "paused"), { recursive: true });
      writeFileSync(path.join(f.root, "controls", "paused", "perf"), "");
    }
    if (reason === "busy") f.put({ id: "owner", agent: "perf" });
    if (reason === "stale-proof") writeFileSync(path.join(f.repoRoot, f.sourcePath), f.afterSource);
    if (reason === "stale-proof") {
      await assert.rejects(performanceHandoff({ ...options, approval: preview.approval }));
    } else assert.equal((await performanceHandoff({ ...options, approval: preview.approval })).status, "held");
    assert.deepEqual(f.calls, []);
    assert.equal(f.store.tasks().length, reason === "busy" ? 1 : 0);
  });
}
for (const reason of ["wrong-approval", "changed-role", "changed-model", "stale-source", "changed-artifacts", "paused", "busy", "open-pr"]) {
  test(`handoff is held before preparation: ${reason}`, async t => {
    const f = await handoffFixture(t);
    let options = { ...f.options, approval: f.preview.approval };
    if (reason === "wrong-approval") options.approval = "a".repeat(64);
    if (reason === "changed-role") writeFileSync(path.join(f.root, "agents", "perf.md"), "Changed role");
    if (reason === "changed-model") {
      writeFileSync(path.join(f.root, "agents", "perf.md"), "---\nmodel: changed\n---\nFixture agent. Never executed.");
    }
    if (reason === "stale-source") writeFileSync(path.join(f.repoRoot, f.sourcePath), f.afterSource);
    if (reason === "changed-artifacts") emitArtifacts(f, "export const changed=1;");
    if (reason === "paused") {
      mkdirSync(path.join(f.root, "controls", "paused"), { recursive: true });
      writeFileSync(path.join(f.root, "controls", "paused", "perf"), "");
    }
    if (reason === "busy") f.put({ id: "already-busy", agent: "perf" });
    if (reason === "open-pr") options.listPullRequests = async () => [{ branch: "user/fixture/perf-existing" }];
    const initialTasks = f.store.tasks().length;
    if (["paused", "busy", "open-pr"].includes(reason)) {
      const result = await performanceHandoff(options);
      assert.equal(result.status, "held");
      assert.equal(result.dispatched, 0);
    } else await assert.rejects(performanceHandoff(options));
    assert.deepEqual(f.calls, []);
    assert.equal(f.store.tasks().length, initialTasks);
  });
}

for (const reason of ["failed-prepare", "wrong-revision", "wrong-workspace", "wrong-branch", "failed-build",
  "different-task-assets", "pause-during-build", "changed-role-during-build"]) {
  test(`handoff cannot publish after invalid preparation: ${reason}`, async t => {
    const f = await handoffFixture(t);
    const call = async (tool, args) => {
      if (reason === "failed-prepare") throw new Error("Fixture setup failure");
      const result = await f.call(tool, args);
      if (reason === "wrong-revision") result.commit = "b".repeat(40);
      if (reason === "wrong-workspace") result.repoRoot = f.repoRoot;
      if (reason === "wrong-branch") result.branch = "master";
      if (reason === "failed-build" && tool === "bohemia_build") result.ready = false;
      if (reason === "different-task-assets" && tool === "bohemia_build") {
        emitArtifacts({ app: path.join(f.workspace, appPath) }, "export const changed=2;");
      }
      if (reason === "pause-during-build" && tool === "bohemia_build") {
        mkdirSync(path.join(f.root, "controls", "paused"), { recursive: true });
        writeFileSync(path.join(f.root, "controls", "paused", "perf"), "");
      }
      if (reason === "changed-role-during-build" && tool === "bohemia_build") {
        writeFileSync(path.join(f.root, "agents", "perf.md"), "Changed while preparing");
      }
      return result;
    };
    const run = () => performanceHandoff({ ...f.options, call, approval: f.preview.approval });
    if (reason === "pause-during-build") assert.equal((await run()).status, "held");
    else await assert.rejects(run());
    assert.equal(f.store.tasks().length, 0);
  });
}

test("task reproduction rebuilds and measures uncommitted working-tree changes rather than frozen evidence", async t => {
  const f = artifactFixture(t);
  const before = await benchmark({ repoRoot: f.repoRoot, call: buildCall(f) });
  writeFileSync(path.join(f.repoRoot, "source.txt"), "candidate source\n");
  const after = await benchmark({ repoRoot: f.repoRoot, call: buildCall(f, "export const value=1;") });
  assert.equal(before.metric, rootMetric);
  assert.equal(after.commit, before.commit);
  assert.notEqual(after.sourceFingerprint, before.sourceFingerprint);
  assert.ok(after.value < before.value);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(row => row.tool === "bohemia_build" && row.args.productionArtifacts === true));
});

for (const change of ["source", "assets", "role"]) {
  test(`last-moment ${change} drift cannot publish an already-verified brief`, async t => {
    const f = await handoffFixture(t);
    let checks = 0;
    const listPullRequests = async () => {
      if (++checks === 2) {
        if (change === "source") writeFileSync(path.join(f.workspace, f.sourcePath), f.afterSource);
        if (change === "assets") emitArtifacts({ app: path.join(f.workspace, appPath) }, "export const changed=3;");
        if (change === "role") writeFileSync(path.join(f.root, "agents", "perf.md"), "Late role change");
      }
      return [];
    };
    await assert.rejects(performanceHandoff({ ...f.options, approval: f.preview.approval, listPullRequests }));
    assert.equal(checks, 2);
    assert.equal(f.store.tasks().length, 0);
  });
}

test("task reproduction rejects changing source during build, including untracked contents", async t => {
  const f = artifactFixture(t), file = path.join(f.repoRoot, "new-source.txt");
  writeFileSync(file, "before");
  await assert.rejects(benchmark({ repoRoot: f.repoRoot, call: async (...args) => {
    const result = await buildCall(f)(...args);
    writeFileSync(file, "after");
    return result;
  } }), /Checkout changed/);
});
