import assert from "node:assert/strict";
import test from "node:test";
import { failureResult } from "../src/errors.mjs";

for (const [message, code, action] of [
  ["Codespace connector must be an existing absolute local path", "runtime_incomplete", /complete MCP runtime bundle/],
  ["PR description rejected:\nsolution must end with a full stop", "invalid_input", /Correct the listed fields/],
  ["VS403660: You do not have permission to create ref", "branch_permission", /authorized branch/],
  ["Checkout has staged, unstaged or untracked changes", "dirty_checkout", /Commit the intended changes/],
  ["SSH timed out during publication", "operation_interrupted", /do not create a duplicate/],
  ["Codespace engineering preparation is not ready: SSH timed out", "preparation_required", /repo_prepare.*mode resume and reset false/],
  ["GitHub API rate limit exceeded", "GITHUB_RATE_LIMITED", /shared GitHub cooldown/],
  ["CODESPACE_WORKSPACE_BUSY: live operation 18192 owns this workspace", "workspace_busy", /Wait for the current owner/],
  ["Cannot read properties of undefined (reading 'packageJsonPath')", "validation_failed", /retained command log/],
]) test(`publication failure gives a concrete recovery action: ${code}`, () => {
  const result = failureResult(new Error(message), "pr");
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.startsWith(message));
  assert.equal(result.structuredContent.operationError.code, code);
  assert.match(result.structuredContent.operationError.nextAction, action);
});

test("GitHub cooldown reporting preserves the reset deadline for the original task", () => {
  const retryAt = "2026-11-02T20:01:00.000Z";
  const result = failureResult(Object.assign(new Error("GitHub API rate limit exceeded"), {
    code: "GITHUB_RATE_LIMITED", reasonCode: "github_rate_limited", retryAt,
  }), "pr");
  assert.equal(result.structuredContent.operationError.retryAt, retryAt);
  assert.equal(result.structuredContent.operationError.stage, "transport");
});

test("existing ownership error codes and reason codes survive error reporting", () => {
  const result = failureResult(Object.assign(new Error("workspace is busy"), {
    code: "CODESPACE_WORKSPACE_BUSY", reasonCode: "workspace_busy",
  }), "prepare");
  assert.equal(result.structuredContent.operationError.code, "CODESPACE_WORKSPACE_BUSY");
  assert.equal(result.structuredContent.operationError.reasonCode, "workspace_busy");
});

for (const file of ["C:\\project\\queues\\in_progress\\manual-original.json",
  "/project/queues/in_progress/manual-original.json"]) {
  test(`publication with a missing active task identifies safe original-task recovery: ${file}`, () => {
    const result = failureResult(Object.assign(new Error(
      `ENOENT: no such file or directory, open '${file}'`), { code: "ENOENT" }), "pr");
    assert.equal(result.structuredContent.operationError.code, "ENOENT");
    assert.equal(result.structuredContent.operationError.stage, "context");
    assert.match(result.structuredContent.operationError.nextAction, /reopen it through supported status controls/);
    assert.match(result.structuredContent.operationError.nextAction, /Do not mark work failed or completed/);
  });
}
