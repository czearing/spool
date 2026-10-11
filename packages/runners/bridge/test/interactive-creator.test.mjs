import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importInteractiveCreator, verifyInteractiveCreation } from "../interactive-creator.mjs";
import { fixture } from "./fixtures.mjs";

function evidenceFixture(t) {
  const f = fixture(t), sessionId = "original-session", taskId = "original-work-item";
  const sessionDirectory = path.join(f.root, sessionId);
  mkdirSync(sessionDirectory);
  writeFileSync(path.join(sessionDirectory, "workspace.yaml"), `id: ${sessionId}\nmc_task_id: ${taskId}\n`);
  const pr = { id: "123", branch: "user/original", url: "https://dev.azure.com/office/OC/_git/office-bohemia/pullrequest/123" };
  const request = { id: "creation-request", type: "tool.execution_start", timestamp: "2026-09-24T00:00:00Z",
    data: { toolCallId: "call-create", toolName: "bohemia-pr-bohemia_pr",
      arguments: { action: "create", sourceBranch: pr.branch } } };
  const result = { id: "creation-result", type: "tool.execution_complete",
    data: { toolCallId: "call-create", success: true, result: { content: `Draft\n${pr.url}\nChecks passed` } } };
  const save = () => writeFileSync(path.join(sessionDirectory, "events.jsonl"), [request, result].map(JSON.stringify).join("\n"));
  save();
  const input = { pr, sessionDirectory, requestEventId: request.id, resultEventId: result.id };
  return { ...f, input, sessionId, taskId, sessionDirectory, pr, request, result, save };
}

test("proven interactive provenance waits for an active author, then preserves its original identities", async t => {
  const f = evidenceFixture(t);
  const proof = await verifyInteractiveCreation(f.input);
  const owner = { ...proof, creationEvidence: proof, branch: f.pr.branch, prUrl: f.pr.url,
    workspace: f.workspace, agent: "software-engineer", title: "Original task" };
  writeFileSync(path.join(f.sessionDirectory, "inuse.12.lock"), "12");
  f.store.processes = () => [{ ProcessId: 12, Name: "copilot.exe", CommandLine: "copilot --yolo" }];
  assert.match((await importInteractiveCreator(f.store, owner)).holding, /original author is active/);
  assert.equal(f.store.tasks().length, 0);
  f.store.processes = () => [];
  assert.equal((await importInteractiveCreator(f.store, owner)).imported, true);
  assert.equal(f.store.task(f.taskId).session_id, f.sessionId);
  assert.equal(f.store.task(f.taskId).status, "failed");
  assert.equal((await importInteractiveCreator(f.store, owner)).imported, false);
});

test("mentions, failed calls, mismatched replies and changed branches cannot establish ownership", async t => {
  for (const kind of ["read", "failure", "mismatch", "branch"]) {
    const f = evidenceFixture(t);
    if (kind === "read") f.request.data.arguments.action = "update";
    if (kind === "failure") f.result.data.success = false;
    if (kind === "mismatch") f.result.data.toolCallId = "other";
    if (kind === "branch") f.pr.branch = "user/other";
    f.save();
    await assert.rejects(verifyInteractiveCreation(f.input), /creation|exact PR/);
    assert.equal(f.store.tasks().length, 0);
  }
});
