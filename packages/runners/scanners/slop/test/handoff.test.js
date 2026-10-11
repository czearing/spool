import test from "node:test";
import assert from "node:assert/strict";
import { renderSlopTask, dispatchNextSlopTask } from "../handoff.js";

test("renderSlopTask formats structured task description and branch name", () => {
  const candidate = {
    path: "packages/example/src/utils.ts",
    slopLines: 12,
    slopComments: 3,
    codeLines: 100,
    reproduction: "node slop/measure.js packages/example/src/utils.ts",
    findings: [
      {
        startLine: 10,
        endLine: 12,
        category: "tautology",
        severity: "high",
        snippet: "// The counter\nlet count = 0;",
        reasons: ["Tautological comment"],
      },
    ],
  };

  const task = renderSlopTask(candidate);
  assert.match(task.title, /^docs\(comments\): clean up redundant and verbose comments in packages\/example\/src\/utils\.ts/);
  assert.ok(task.branchName.includes("docs-packages-example-src-utils"));
  assert.ok(task.description.includes("### Background"));
  assert.ok(task.description.includes("The branch `user/calebzearing/docs-packages-example-src-utils` is checked out and verified clean."));
  assert.ok(task.description.includes("Do not run git checkout, fetch, reset, or clean; proceed directly to your edits."));
  assert.ok(task.description.includes("### Acceptance Criteria"));
  assert.ok(task.description.includes("bohemia push"));
  assert.ok(task.description.includes("Line 10-12"));
});

test("dispatchNextSlopTask honors maxOpenTasks cap (max 2 PRs)", async () => {
  const candidate = {
    path: "packages/example/src/foo.ts",
    slopLines: 5,
    slopComments: 1,
    codeLines: 50,
    reproduction: "node slop/measure.js packages/example/src/foo.ts",
    findings: [],
  };

  let fetchCalled = false;
  const mockFetch = async (url) => {
    fetchCalled = true;
    if (url.includes("/issues?")) {
      return {
        ok: true,
        json: async () => [
          { id: "1", title: "slop: file1.ts", status: "in_progress" },
          { id: "2", title: "slop: file2.ts", status: "in_review" },
        ],
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  const result = await dispatchNextSlopTask({
    candidate,
    agentId: "f833b5c8-7703-4d35-beb3-f89cd3deb4e7",
    companyId: "b15271fe-75c2-4273-b08e-08c41b2101c2",
    repoRoot: "C:\\Code\\bohemia\\office-bohemia-tech-writter",
    maxOpenTasks: 2,
    apiUrl: "http://localhost:3400",
    apiKey: "dummy-key",
    queue: { listIssues: async () => (await mockFetch("/issues?")).json() },
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, "max_open_tasks_reached");
  assert.equal(result.activeCount, 2);
  assert.equal(result.maxOpenTasks, 2);
});

test("dispatchNextSlopTask performs dry run when dryRun is true and cap has space", async () => {
  const candidate = {
    path: "packages/example/src/bar.ts",
    slopLines: 8,
    slopComments: 2,
    codeLines: 80,
    reproduction: "node slop/measure.js packages/example/src/bar.ts",
    findings: [],
  };

  const mockFetch = async (url) => {
    if (url.includes("/issues?")) {
      return {
        ok: true,
        json: async () => [{ id: "1", title: "slop: file1.ts", status: "in_progress" }],
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  const result = await dispatchNextSlopTask({
    candidate,
    agentId: "f833b5c8-7703-4d35-beb3-f89cd3deb4e7",
    companyId: "b15271fe-75c2-4273-b08e-08c41b2101c2",
    repoRoot: "C:\\Code\\bohemia\\office-bohemia-tech-writter",
    maxOpenTasks: 2,
    apiUrl: "http://localhost:3400",
    apiKey: "dummy-key",
    dryRun: true,
    queue: { listIssues: async () => (await mockFetch("/issues?")).json() },
  });

  assert.equal(result.dispatched, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.activeCount, 1);
  assert.ok(result.task);
  assert.match(result.task.title, /^docs\(comments\): clean up redundant and verbose comments in packages\/example\/src\/bar\.ts/);
});
