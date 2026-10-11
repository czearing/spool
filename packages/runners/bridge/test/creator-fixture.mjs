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

export function creatorFixture(t) {
  const f = fixture(t);
  const config = configure({ spool_dir: f.root, pr_updater: { enabled: true, workspace_dir: f.workspace } }, "pr-updater", f.root).config;
  config.creatorMinimumFreeGiB = 0.001;
  const pr = { id: "123", url: "https://dev.azure.com/office/OC/_git/office-bohemia/pullrequest/123",
    status: "active", title: "Conflict", branch: "user/fixture", sourceCommit: "a".repeat(40),
    mergeStatus: "conflicts", votes: [], reviewers: [] };
  f.put({ id: "OFF-123", agent: "perf", session_id: "original-session", turns: 12 }, "completed");
  writeJson(path.join(f.store.records, "ownership.json"), { version: 1, pullRequests: [{
    verified: true, prId: pr.id, prUrl: pr.url, branch: pr.branch, taskId: "OFF-123",
    agent: "perf", workspace: f.workspace, creatorName: "Original performance owner",
    sourceAgentId: "original-agent", sourceIssueId: "original-issue", originalPrompt: "Original brief",
  }] });
  const ado = { async listOwnPullRequests() { return [pr]; }, async listThreads() { return []; },
    async listBuilds() { return []; }, async getPullRequest() { return pr; } };
  return { ...f, config, pr, ado,
    options: { store: f.store, config, agent: "pr-updater", workspace: f.workspace, runtime: config.runtimeDirectory, ado,
      preparationEvidence: () => "fixture-evidence" } };
}
