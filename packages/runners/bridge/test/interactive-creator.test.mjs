import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importInteractiveCreator, verifyInteractiveCreation } from "../interactive-creator.mjs";
import { writeJson } from "../spool-store.mjs";
import { recoverSpoolCreator, resolveSpoolCreator } from "../creator-routing.mjs";
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

for (const kind of ["valid", "updated", "unrecorded", "failed-write", "failed-create", "changed-branch", "dynamic-call"]) {
  test(`recorded PR creation script ${kind} retains immutable original provenance`, async t => {
    const f = evidenceFixture(t), file = path.join(f.sessionDirectory, "files", "create.mjs");
    const source = `import { callBohemia } from 'bohemia-pr-mcp/client';\n` +
      `const result = await callBohemia('bohemia_pr', { action: 'create', sourceBranch: '${f.pr.branch}', repository: 'fixture' });\n`;
    const creation = { id: "script-write", type: "tool.execution_start", data: { toolCallId: "write-script",
      toolName: "apply_patch", arguments: `*** Begin Patch\n*** Add File: ${file}\n` +
        source.trimEnd().split("\n").map(line => "+" + line).join("\n") + "\n*** End Patch\n" } };
    const written = { id: "script-written", type: "tool.execution_complete",
      data: { toolCallId: "write-script", success: kind !== "failed-write" } };
    if (kind === "dynamic-call") creation.data.arguments = creation.data.arguments.replace(`'${f.pr.branch}'`, "process.env.BRANCH");
    const events = [creation, written];
    if (kind === "updated") events.push(
      { id: "script-update", type: "tool.execution_start", data: { toolCallId: "update-script", toolName: "apply_patch",
        arguments: `*** Begin Patch\n*** Update File: ${file}\n@@\n-${source.trimEnd().split("\n")[1]}\n+${source.trimEnd().split("\n")[1].replace("fixture", "updated-fixture")}\n*** End Patch\n` } },
      { id: "script-updated", type: "tool.execution_complete", data: { toolCallId: "update-script", success: true } });
    f.request.data.toolName = "powershell";
    f.request.data.arguments = { command: `node "${file}" *> "${file}.log"; Get-Content "${file}.log"; exit $LASTEXITCODE` };
    if (kind === "changed-branch") f.pr.branch = "user/unrelated";
    if (kind === "failed-create") f.result.data.success = false;
    writeFileSync(path.join(f.sessionDirectory, "events.jsonl"),
      [...(kind === "unrecorded" ? [] : events), f.request, f.result].map(JSON.stringify).join("\n"));
    if (["valid", "updated"].includes(kind)) {
      const proof = await verifyInteractiveCreation(f.input);
      assert.equal(proof.taskId, f.taskId);
      assert.equal(proof.scriptEvidence.file, file);
      assert.match(proof.scriptEvidence.sha256, /^[a-f0-9]{64}$/);
    } else await assert.rejects(verifyInteractiveCreation(f.input), /creation|exact PR/);
  });
}

test("two verified PRs from one interactive work item retain one original conversation and serialize checkout assignments", async t => {
  const f = evidenceFixture(t), secondWorkspace = path.join(f.root, "second-workspace");
  mkdirSync(secondWorkspace);
  const second = { ...f.pr, id: "124", branch: "user/second", url: f.pr.url.replace("123", "124") };
  const secondRequest = { ...f.request, id: "second-request", data: { ...f.request.data,
    toolCallId: "second-create", arguments: { action: "create", sourceBranch: second.branch } } };
  const secondResult = { ...f.result, id: "second-result", data: { ...f.result.data,
    toolCallId: "second-create", result: { content: second.url } } };
  writeFileSync(path.join(f.sessionDirectory, "events.jsonl"),
    [f.request, f.result, secondRequest, secondResult].map(JSON.stringify).join("\n"));
  const firstProof = await verifyInteractiveCreation(f.input);
  const secondProof = await verifyInteractiveCreation({ pr: second, sessionDirectory: f.sessionDirectory,
    requestEventId: secondRequest.id, resultEventId: secondResult.id });
  const historicalOwner = (pr, workspace, proof) => ({ verified: true, originKind: "copilot_cli",
    taskId: proof.taskId, sessionId: proof.sessionId, prId: pr.id, prUrl: pr.url, branch: pr.branch,
    agent: "software-engineer", workspace, creationEvidence: proof });
  const firstOwner = historicalOwner(f.pr, f.workspace, firstProof);
  const secondOwner = historicalOwner(second, secondWorkspace, secondProof);
  writeJson(path.join(f.store.records, "ownership.json"), { version: 1, pullRequests: [firstOwner, secondOwner] });
  assert.equal(firstOwner.taskId, secondOwner.taskId);
  await recoverSpoolCreator(f.store, f.pr);
  await recoverSpoolCreator(f.store, second);
  assert.equal(f.store.tasks().length, 1);
  assert.equal(resolveSpoolCreator(f.store, second).workspace, f.workspace);
  assert.equal(resolveSpoolCreator(f.store, second).assignedWorkspace, secondWorkspace);
  assert.equal(f.store.task(f.taskId).session_id, f.sessionId);
});
