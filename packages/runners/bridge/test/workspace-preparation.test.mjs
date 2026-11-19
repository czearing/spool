import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspacePreparer } from "../workspace-preparation.mjs";
import { createSpoolQueue } from "../queue.mjs";
import { prepareReviewWorkspace } from "../../scanners/pr-reviewer/lib/workspace.mjs";
import { fixture } from "./fixtures.mjs";

const sha = "a".repeat(40);

for (const runBuild of [true, false]) {
  test(`shared task preparation uses bohemia_prepare with explicit workspace and runBuild=${runBuild}`, async t => {
    const f = fixture(t), calls = [];
    const queue = createSpoolQueue(f.store, { agent: "perf", workspace: f.workspace, runner: "perf" });
    const prepare = createWorkspacePreparer({
      store: f.store, queue, agent: "perf", workspace: f.workspace,
      call: async (tool, args) => {
        calls.push({ tool, args });
        return { ready: true, repoRoot: args.repoRoot, branch: args.branch, commit: sha };
      },
    });
    await prepare({ branch: "fixture", repoRoot: "must-not-override-workspace", runBuild });
    assert.deepEqual(calls, [{
      tool: "bohemia_prepare",
      args: { repoRoot: f.workspace, operation: "branch", branch: "user/calebzearing/fixture",
        baseBranch: "master", mode: "create", reset: false, runSetup: true, runBuild },
    }]);
    const issue = await queue.createIssue({ assigneeAgentId: "perf", title: "Fixture", description: "Prepared fixture" });
    assert.equal(f.store.metadata(issue.id).preparation.commit, sha);
  });
}

test("review preparation retains the exact revision through the same ownership guard", async t => {
  const f = fixture(t), queue = createSpoolQueue(f.store, { agent: "pr-reviewer", workspace: f.workspace, runner: "pr-reviewer" });
  const prepare = createWorkspacePreparer({
    store: f.store, queue, agent: "pr-reviewer", workspace: f.workspace, prepare: prepareReviewWorkspace,
    call: async (tool, args) => {
      assert.equal(tool, "bohemia_prepare");
      assert.equal(args.repoRoot, f.workspace);
      assert.equal(args.sourceCommit, sha);
      assert.equal(args.reset, false);
      assert.equal(args.mergeMaster, false);
      assert.equal(args.runSetup, true);
      assert.equal(args.runBuild, false);
      return { ready: true, repoRoot: args.repoRoot, branch: args.branch, commit: sha };
    },
  });
  assert.equal((await prepare({ prId: "123", sourceCommit: sha })).commit, sha);
});

for (const stage of ["before", "after"]) {
  test(`ownership is checked ${stage} MCP preparation, before recording a handoff`, async t => {
    const f = fixture(t);
    if (stage === "before") f.put({ id: "owner", agent: "perf" });
    let recorded = false, called = false;
    const prepare = createWorkspacePreparer({
      store: f.store, queue: { setPreparation() { recorded = true; } }, agent: "perf", workspace: f.workspace,
      call: async (_tool, args) => {
        called = true;
        f.put({ id: "owner", agent: "perf" });
        return { ready: true, repoRoot: args.repoRoot, branch: args.branch, commit: sha };
      },
    });
    await assert.rejects(prepare({ branch: "fixture" }), /owned/);
    assert.equal(called, stage === "after");
    assert.equal(recorded, false);
  });
}

test("failed MCP preparation never records a ready workspace", async t => {
  const f = fixture(t);
  const prepare = createWorkspacePreparer({
    store: f.store, queue: { setPreparation() { assert.fail("Failed setup was recorded"); } },
    agent: "perf", workspace: f.workspace,
    call: async () => { throw new Error("dependency installation failed"); },
  });
  await assert.rejects(prepare({ branch: "fixture" }), /dependency installation failed/);
});

test("existing prepared discovery results use the same guarded handoff without preparing again", async t => {
  const f = fixture(t), queue = createSpoolQueue(f.store, { agent: "perf", workspace: f.workspace, runner: "perf" });
  const prepare = createWorkspacePreparer({ store: f.store, queue, agent: "perf", workspace: f.workspace,
    call: async () => assert.fail("A prepared discovery result must not be rebuilt") });
  assert.equal(await prepare({ prepared: f.preparation }), f.preparation);
  await assert.rejects(prepare({ prepared: { ...f.preparation, repoRoot: f.root } }), /configured workspace/);
  const issue = await queue.createIssue({ assigneeAgentId: "perf", title: "Prepared", description: "Use verified preparation" });
  assert.deepEqual(f.store.metadata(issue.id).preparation, f.preparation);
});

test("reusing preparation still checks ownership before recording it", async () => {
  let checks = 0;
  const prepare = createWorkspacePreparer({
    store: { assertIdle() { if (++checks === 2) throw new Error("Workspace acquired another owner"); } },
    queue: { setPreparation() { assert.fail("Occupied workspace must not be recorded"); } },
    agent: "perf", workspace: "workspace",
    call: async () => assert.fail("Prepared result must not be rebuilt"),
  });
  await assert.rejects(prepare({ prepared: { ready: true } }), /another owner/);
  assert.equal(checks, 2);
});

test("explicit preparation adapters cannot be bypassed by a supplied discovery result", async t => {
  const f = fixture(t), queue = createSpoolQueue(f.store, { agent: "pr-reviewer", workspace: f.workspace, runner: "pr-reviewer" });
  const prepare = createWorkspacePreparer({ store: f.store, queue, agent: "pr-reviewer", workspace: f.workspace,
    prepare: async options => {
      assert.equal(options.sourceCommit, sha);
      throw new Error("Fresh review revision could not be verified");
    } });
  await assert.rejects(prepare({ sourceCommit: sha, prepared: f.preparation }), /Fresh review revision/);
});
