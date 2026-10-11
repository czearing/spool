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

import { handoff } from "./updater-fixture.mjs";

for (const agent of ["perf", "software-engineer", "tech-writer"]) {
  test(`${agent} receives the complete canonical updater procedure and renderer without losing creator identity`, async t => {
    const f = await handoff(t, agent), procedure = await readReviewProcedure();
    const shared = reviewPrompt(f.metadata.contract, procedure, { transport: "spool" });
    const followup = f.task.interaction.messages.at(-1).text;
    assert.equal(f.task.prompt, f.brief);
    assert.ok(shared.includes(procedure));
    assert.ok(!followup.includes(f.brief), "Original context must come from the restored conversation");
    assert.equal(followup.split(procedure).length - 1, 1);
    assert.equal(f.task.agent, agent);
    assert.equal(f.task.session_id, f.session);
    assert.equal(f.task.workspace, f.workspace);
    assert.equal(f.task.turns, 12);
    assert.ok(f.task.comments.some(comment => comment.message === "Existing creator context is preserved."));
    assert.equal(f.metadata.updatePrompt.procedureSha256, digest(procedure));
    assert.equal(f.metadata.updatePrompt.promptSha256, digest(followup));
    assert.equal(f.metadata.updatePrompt.source, enginePath("pr-updater", "review-mode.md"));
    for (const instruction of [
      "Reproduce the precise reported behavior", "Preserve the original implementation goals",
      "never whole-repository builds or `--to`", "COMMIT_MESSAGE_POLICY",
      "Do not wait for CI", "Do not delegate", "Earlier completion summaries",
      "unpushed continuation at", "PR_UPDATE_RESULT_FILE:", "spool_get_task again",
      "descriptionEvidence",
    ]) assert.ok(followup.includes(instruction), instruction);
    assert.equal(f.metadata.contract.resultFile, path.join(f.store.records, "results", `${digest(f.metadata.key)}.json`));
    assert.ok(existsSync(path.dirname(f.metadata.contract.resultFile)));
    assert.ok(followup.includes(f.metadata.contract.findings[0].comments[0].body));
    assert.doesNotMatch(followup, /PUT the issue document|X-Paperclip-Run-Id|Read GET \/api\/issues/);
    assert.ok(followup.includes(enginePath("pr-updater", "resolve-thread.mjs")));
  });
}

for (const trigger of ["review", "build"]) {
  test(`${trigger} handoffs receive the same complete canonical procedure`, async t => {
    const f = await handoff(t, "perf", { trigger }), procedure = await readReviewProcedure();
    assert.equal(f.task.interaction.messages.at(-1).text.split(procedure).length - 1, 1);
    assert.equal(f.metadata.contract.repair?.type, trigger === "build" ? "build" : undefined);
    assert.ok(f.metadata.contract.findings.length > 0);
  });
}

test("changed canonical files reach future handoffs; missing/empty files fail before preparation or dispatch", async t => {
  const isolated = fixture(t), runnerRoot = fileURLToPath(new URL("../../", import.meta.url));
  const copiedEngine = path.join(isolated.root, "scanners");
  cpSync(engineRoot, copiedEngine, {
    recursive: true, filter: source => !["node_modules", ".runner"].includes(path.basename(source)),
  });
  cpSync(path.join(runnerRoot, "bridge"), path.join(isolated.root, "bridge"), {
    recursive: true, filter: source => path.basename(source) !== "test",
  });
  cpSync(path.join(runnerRoot, "packages", "workflow"), path.join(isolated.root, "packages", "workflow"), { recursive: true });
  writeJson(path.join(isolated.root, "package.json"), { type: "module" });
  mkdirSync(path.join(isolated.root, "node_modules"));
  for (const [name, target] of [
    ["bohemia-pr-mcp", path.join(runnerRoot, "packages", "bohemia-pr-mcp")],
    ["bohemia-agent-tooling", path.join(runnerRoot, "packages", "bohemia-agent-tooling")],
  ]) symlinkSync(target, path.join(isolated.root, "node_modules", name), process.platform === "win32" ? "junction" : "dir");
  const { createUpdater: updater } = await import(pathToFileURL(path.join(isolated.root, "bridge", "updater.mjs")));
  const procedureFile = path.join(copiedEngine, "pr-updater", "review-mode.md");
  const procedure = await readReviewProcedure();
  const first = await handoff(t, "perf", { updater });
  assert.ok(first.task.interaction.messages.at(-1).text.includes(procedure));
  const revised = `${procedure}\n- Isolated fixture procedure revision; preserve this exact sentinel.\n`;
  writeFileSync(procedureFile, revised);
  const next = await handoff(t, "perf", { updater });
  assert.ok(next.task.interaction.messages.at(-1).text.includes(revised));
  assert.equal(next.metadata.updatePrompt.procedureSha256, digest(revised));
  for (const empty of [true, false]) {
    if (empty) writeFileSync(procedureFile, " \n\t");
    else unlinkSync(procedureFile);
    const held = await handoff(t, "perf", { updater, dispatch: false });
    await assert.rejects(held.scan, empty ? /procedure is empty/ : /ENOENT/);
    assert.equal(held.preparations(), 0);
    assert.equal(held.store.task(held.taskId).status, "completed");
    assert.equal(held.store.task(held.taskId).prompt, held.brief);
    assert.equal(held.store.metadata(held.taskId), null);
  }
});

test("canonical renderer rejects empty procedures and keeps Paperclip delivery separate from Spool", async () => {
  const contract = { identifier: "OFF-fixture", prId: "123", agent: "perf", branch: "topic",
    cwd: "fixture", head: "a".repeat(40), documentKey: "pr-review-contract", issueId: "fixture",
    findings: [], submissionId: "fixture-submission", fingerprint: "fixture" };
  const procedure = await readReviewProcedure();
  assert.throws(() => reviewPrompt(contract, ""), /required/);
  assert.throws(() => reviewPrompt(contract, procedure, { transport: "unknown" }), /Unknown/);
  const legacy = reviewPrompt(contract, procedure);
  assert.ok(legacy.includes(procedure));
  assert.match(legacy, /PUT the issue document/);
  assert.match(legacy, /X-Paperclip-Run-Id/);
  assert.doesNotMatch(legacy, /spool_add_comment/);
  const spool = reviewPrompt(contract, procedure, { transport: "spool" });
  assert.ok(spool.includes(procedure));
  assert.match(spool, /spool_add_comment/);
  assert.doesNotMatch(spool, /PUT the issue document|X-Paperclip-Run-Id|Read GET \/api\/issues/);
});

const binary = process.env.SPOOL_TEST_BINARY ||
  fileURLToPath(new URL(`../../../spool/target/release/spool${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
test("actual Spool MCP returns the exact canonical updater prompt on the original task", {
  skip: !process.env.SPOOL_TEST_BINARY && !existsSync(binary) ? "Build sibling Spool or set SPOOL_TEST_BINARY for the real MCP transcript test" : false,
}, async t => {
  assert.ok(existsSync(binary), `Spool test executable is missing: ${binary}`);
  const f = await handoff(t);
  const activeFile = path.join(f.store.queues, "in_progress", `${f.taskId}.json`);
  writeJson(f.task.file, { ...f.task, file: undefined, status: "in_progress" });
  renameSync(f.task.file, activeFile);
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "isolated-prompt-verifier", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "spool_get_task", arguments: {} } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
  const result = spawnSync(binary, ["--root", f.root, "mcp", "--agent", f.agent, "--task", f.taskId], {
    input: requests, encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stderr}`);
  const response = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)).find(row => row.id === 2);
  assert.equal(response.result.isError, undefined);
  const returned = JSON.parse(response.result.content[0].text);
  assert.equal(returned.prompt, f.task.prompt);
  assert.equal(returned.agent, f.agent);
  assert.equal(returned.session_id, f.session);
  assert.equal(returned.workspace, f.workspace);
  const delivered = returned.interaction.messages.at(-1).text;
  assert.equal(digest(delivered), f.metadata.updatePrompt.promptSha256);
  assert.deepEqual(returned.runner_metadata.contract, f.metadata.contract);
  const output = process.env.SPOOL_PROMPT_TRANSCRIPT;
  if (output) {
    assert.ok(path.isAbsolute(output), "Transcript output must be an absolute path");
    const transcript = [
      "ISOLATED SPOOL MCP HANDOFF TRANSCRIPT",
      `Captured: ${new Date().toISOString()}`,
      "This is an actual request/response from the real Spool MCP executable using disposable queues.",
      "It is NOT a live Copilot model conversation or a new PR update. No model or external PR API was invoked.",
      "The pipeline used mocked preparation/PR reads, then the fixture simulated the queue claim.",
      `Original creator: ${returned.agent}; task: ${returned.id}; preserved fixture session: ${returned.session_id}`,
      `Canonical procedure source: ${f.metadata.updatePrompt.source}`,
      `Procedure SHA-256: ${f.metadata.updatePrompt.procedureSha256}`,
      `Delivered prompt SHA-256: ${digest(delivered)}`,
      "",
      "=== EXACT DELIVERED PROMPT (decoded verbatim from spool_get_task response) ===",
      delivered,
      "",
      "=== EXACT CLIENT JSON-RPC INPUT ===",
      requests,
      "=== EXACT SERVER JSON-RPC OUTPUT ===",
      result.stdout,
      "=== END OF CAPTURE ===",
    ].join("\n");
    writeFileSync(output, transcript, { encoding: "utf8", flag: "wx" });
    assert.equal(readFileSync(output, "utf8"), transcript);
  }
});
