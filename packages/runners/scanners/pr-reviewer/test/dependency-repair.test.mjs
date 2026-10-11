import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { needsDependencyRepair, reviewBuildPackages } from "../lib/dependency-repair.mjs";
import { deliverQueuedWork } from "../lib/delivery.mjs";
import { enqueueReview } from "../lib/work-queue.mjs";
import { prepareReviewWorkspace } from "../lib/workspace.mjs";
import { issueFromTask } from "../../../bridge/queue.mjs";
import { reviewTasksFromIssues } from "../lib/task-source.mjs";

test("the actual Spool failure survives the issue adapter and review receipt", () => {
  const issue = issueFromTask({ id: "original", agent: "reviewer", title: "Review Azure DevOps pull request #1: Fixture",
    prompt: `Source commit: ${"a".repeat(40)}`, status: "failed", error: "MODULE_NOT_FOUND in generated output" });
  const receipt = reviewTasksFromIssues([issue], "reviewer").get(`1:${"a".repeat(40)}`);
  assert.equal(receipt.error, issue.error);
  assert.equal(needsDependencyRepair(receipt.error), true);
  assert.equal(needsDependencyRepair("Approval API authentication failed"), false);
  assert.equal(needsDependencyRepair("four current-source protocol exports remain absent from generated lib/index.d.ts. Runner buildWarmed:false."), true);
  assert.equal(needsDependencyRepair("Generate matching declarations before requeuing"), true);
  assert.equal(needsDependencyRepair("Current-artifact typecheck still exits 1 with same 11 diagnostics despite runner buildWarmed:true. Actual local html-canvas-protocol lib/index.d.ts and lib/tree/index.d.ts still lack four current source exports and retain Oct 6 timestamps. Owner: runner/bootstrap declaration-output preparation; verify actual emitted declarations in this checkout."), true);
  assert.equal(needsDependencyRepair("Current-source typecheck failed with an incompatible interface"), false);
});
for (const buildFails of [false, true]) test(`dependency repair gates the same review task: buildFails=${buildFails}`, async t => {
  const root = mkdtempSync(path.join(tmpdir(), "review-build-repair-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const commit = "a".repeat(40), updatedAt = new Date(Date.now() - 120000).toISOString();
  const pr = { id: "1", title: "Fixture", repository: "repo", url: "https://example.invalid/1", sourceCommit: commit };
  const issue = { id: "original", assigneeAgentId: "reviewer", status: "failed",
    title: "Review Azure DevOps pull request #1: Fixture", description: `Source commit: ${commit}`,
    error: "MODULE_NOT_FOUND in generated output", createdAt: updatedAt, updatedAt };
  const config = { repoRoot: root, workFolder: path.join(root, "queue"), agentId: "reviewer", transport: "spool" };
  await enqueueReview(config.workFolder, pr, { retryOf: issue.id, retryUpdatedAt: updatedAt });
  const calls = []; let resumed = false;
  const options = {
    pullRequests: [pr], admittedPullRequests: [pr], isReviewerBusy: async () => false, isPullRequestCurrent: async () => true,
    queue: { listIssues: async () => [issue], retryIssue: async (id, payload) => {
      assert.equal(id, "original"); assert.match(payload.description, /rebuilt the dependency graph/);
      resumed = true; return { id, status: "todo" };
    } },
    prepareWorkspace: args => {
      assert.equal(args.repairDependencies, true);
      return prepareReviewWorkspace({ ...args, selectPackages: () => ["@fluidx/fixture"],
        call: async (name, input) => {
          calls.push(name);
          if (name === "bohemia_build" && buildFails) throw new Error("build failed");
          return { ready: true, repoRoot: input.repoRoot, branch: "review/pr-1-aaaaaaa", commit };
        } });
    },
  };
  if (buildFails) await assert.rejects(deliverQueuedWork(config, options), /build failed/);
  else assert.equal(await deliverQueuedWork(config, options), true);
  assert.deepEqual(calls, ["bohemia_prepare", "bohemia_build"]);
  assert.equal(resumed, !buildFails);
});
test("repair selects only changed package graphs, deduplicates them and fails closed without a package", t => {
  const root = mkdtempSync(path.join(tmpdir(), "review-package-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "pipe" });
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  };
  git("init", "-q");
  write("package.json", '{"name":"root"}');
  write("packages\\feature\\package.json", '{"name":"@fixture/feature"}');
  write("packages\\other\\package.json", '{"name":"@fixture/other"}');
  write("README.md", "baseline"); commit();
  git("update-ref", "refs/remotes/origin/master", "HEAD");
  write("README.md", "changed root documentation"); commit();
  assert.throws(() => reviewBuildPackages(root), /identifiable changed package/);
  write("packages\\feature\\src\\first.ts", "export const first = 1;");
  write("packages\\feature\\src\\second.ts", "export const second = 2;"); commit();
  assert.deepEqual(reviewBuildPackages(root), ["@fixture/feature"]);
});
