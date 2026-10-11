import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { configure } from "../config.mjs";
import { engine, enginePath, engineRoot } from "../sources.mjs";
import { createUpdater } from "../updater.mjs";
import { assertCreatorWorkspaceReleased, resolveSpoolCreator } from "../creator-routing.mjs";
import { preparationBlocked } from "../../packages/bohemia-pr-mcp/src/resume-state.mjs";
import { digest, writeJson } from "../spool-store.mjs";
import { fixture } from "./fixtures.mjs";
import { finishTask } from "./continuation-fixtures.mjs";

const { readReviewProcedure, reviewPrompt } = await engine("lib/creator-review.mjs");

export async function handoff(t, agent = "perf", { updater = createUpdater, trigger = "conflict", dispatch = true, prepare, assertMigrationSafe } = {}) {
  const f = fixture(t);
  const taskId = "OFF-PROMPT-TEST", session = "00000000-0000-4000-8000-000000000123";
  const brief = "Original fixture goal: reduce eager imports without changing behavior.";
  f.put({ id: taskId, agent, session_id: session, prompt: brief, turns: 12,
    comments: [{ author: `agent:${agent}`, message: "Existing creator context is preserved.", created_at: "2026-09-16T00:00:00Z" }],
  }, "completed");
  const pr = { id: "123", url: "https://example.invalid/fixture/pullrequest/123", status: "active",
    title: "Fixture PR", branch: "user/fixture", sourceCommit: "a".repeat(40), mergeStatus: trigger === "conflict" ? "conflicts" : "succeeded",
    votes: [], reviewers: [], description: "Existing fixture description." };
  writeJson(path.join(f.store.records, "ownership.json"), { version: 1, pullRequests: [{
    verified: true, prId: pr.id, prUrl: pr.url, taskId, agent, creatorName: `Original ${agent}`,
    branch: pr.branch, workspace: f.workspace, sessionId: session, originalPrompt: brief,
  }] });
  const config = configure({ spool_dir: f.root, pr_updater: { enabled: true, workspace_dir: f.workspace } },
    "pr-updater", f.root).config;
  config.creatorMinimumFreeGiB = 0.001;
  const findings = [{ id: 42, status: "active", comments: [{ id: 1, commentType: "text",
    author: { id: "reviewer-fixture", displayName: "Fixture reviewer", uniqueName: "reviewer@example.invalid" },
    publishedDate: "2026-09-16T00:00:00Z", content: "Reproduce recovery after the first attempt fails; unrelated green tests are not evidence." }] }];
  let preparations = 0;
  const scan = await updater({ store: f.store, config, agent: "pr-updater", workspace: f.workspace,
    runtime: config.runtimeDirectory, preparationEvidence: () => "prompt-fixture", assertMigrationSafe,
    ado: { async listOwnPullRequests() { return [pr]; }, async getPullRequest() { return pr; },
      async listThreads() { return findings; }, async listBuilds() {
        return trigger === "build" ? [{ id: "fixture-build", status: "completed", result: "failed", sourceVersion: pr.sourceCommit }] : [];
      } },
    callBohemia: async (_name, args) => {
      preparations++;
      if (prepare) return prepare(args, preparations);
      return { ready: true, repoRoot: args.repoRoot, branch: args.branch,
        commit: "b".repeat(40), merge: { conflicted: trigger === "conflict", files: ["fixture.ts"] } };
    },
  });
  if (dispatch) assert.equal((await scan()).dispatched, 1);
  return { ...f, task: f.store.task(taskId), metadata: f.store.metadata(taskId), taskId, agent, session, brief,
    scan, pr, config, preparations: () => preparations };
}

