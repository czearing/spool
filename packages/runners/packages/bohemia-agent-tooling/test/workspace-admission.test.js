import test from "node:test";
import assert from "node:assert/strict";
import { assertAgentWorkspaceIdle } from "../src/workspace-admission.js";

test("idle workspaces are admitted only after issue and live-run checks", async () => {
  await assertAgentWorkspaceIdle({ listIssues: async () => [], listLiveRuns: async () => [] }, "agent");
  await assert.rejects(assertAgentWorkspaceIdle({ listIssues: async () => [] }, "agent"), /Cannot verify/);
});
test("a surviving run protects a checkout even when its issue is done", async () => {
  await assert.rejects(assertAgentWorkspaceIdle({
    listIssues: async () => [{ status: "done", assigneeAgentId: "agent" }],
    listLiveRuns: async () => [{ agentId: "agent" }],
  }, "agent"), /live run/);
});
test("blocked and pending work, unknown responses and failed lookups are not idle", async () => {
  for (const status of ["todo", "in_progress", "in_review", "blocked"]) {
    await assert.rejects(assertAgentWorkspaceIdle({
      listIssues: async () => [{ status, assigneeAgentId: "agent" }], listLiveRuns: async () => [],
    }, "agent"), /unfinished work/);
  }
  await assert.rejects(assertAgentWorkspaceIdle({ listIssues: async () => null, listLiveRuns: async () => [] }, "agent"), /Invalid/);
  await assert.rejects(assertAgentWorkspaceIdle({
    listIssues: async () => [], listLiveRuns: async () => { throw new Error("server unavailable"); },
  }, "agent"), /server unavailable/);
});
