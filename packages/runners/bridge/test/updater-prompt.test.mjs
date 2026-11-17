import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { engine } from "../sources.mjs";
import { digest, writeJson } from "../spool-store.mjs";
import { finishTask } from "./continuation-fixtures.mjs";
import { inspectWorkflow } from "../workflow-inspection.mjs";
import { definition } from "../workflow-store.mjs";
import { runnerEngine } from "../native-supervisor.mjs";

const { readReviewProcedure, reviewPrompt, withSpoolReviewTools } = await engine("lib/creator-review.mjs");

import { handoff } from "./updater-fixture.mjs";

test("handoff adds exactly three lines after the verbatim agent role", async t => {
  const f = await handoff(t, "perf");
  const role = await readReviewProcedure(f.root);
  const suffix = [
    "Continue this existing PR on its original task/session.",
    `Read "${f.metadata.contract.contractFile}" for the PR, branch, checkout, creator instructions, feedback, and completion details.`,
    "Switch branches.",
  ].join("\n");
  assert.equal(f.task.interaction.messages.at(-1).text, `${role}\n\n${suffix}`);
  const saved = JSON.parse(readFileSync(f.metadata.contract.contractFile, "utf8"));
  assert.equal(saved.resultMarker, undefined);
  assert.equal(saved.responseMode, "pr_description");
  assert.equal(saved.replyPolicy, "never");
  assert.match(saved.completionInstructions, /spool_get_task/);
  assert.match(saved.completionInstructions, /JSON\.stringify/);
  assert.doesNotMatch(saved.completionInstructions, /spool_add_comment|resultMarker/);
  assert.match(saved.completionInstructions, /spool_update_task_status/);
  assert.match(saved.completionInstructions, /Never post PR comments or replies/);
  assert.match(saved.completionInstructions, /Run builds, tests, focused reproductions, browser benchmarks, screenshots and application servers directly/);
  assert.doesNotMatch(saved.completionInstructions, /repo_build|repo_check|bohemia_build|bohemia_check|Do not substitute shell build/);
  assert.deepEqual(saved.replyThreadIds, []);
  assert.equal(saved.resolutionMode, "runner");
  assert.equal(saved.resolverCommands, undefined);
  assert.deepEqual(saved, f.metadata.contract);
});

test("original comment wording and punctuation survive the original-agent handoff unchanged", async t => {
  const f = await handoff(t, "perf", { dispatch: false });
  const body = [
    "# Role", "",
    "You update pull requests and respond to their review comments. Be meticulous. Never assume; test to find answers.",
    "", "# Instructions", "",
    "10. Comment sparingly, don't write on every piece of feedback. Do not comment on agency, pipeline, or in general any automated/ai comments/feedback. Prefer upvotes for human comments. Start every PR comment with \u00a0\\[<your model name>] \u00a0(e.g. \u00a0\\[Gemini 3.8 Flash]\u00a0).",
    "11. When responding to a comment reply keep each comment to one sentence when possible and never more than two. Use tentative, neutral, natural, and varied wording. Avoid repeated `I think`, headings, praise, excess detail, and a period on the last sentence.",
    "12. If you are responding to a question DO NOT sound overconfident and make sure to use as few words as possible.",
    '13. If there is a significant catch someone finds it is appropriate to write something like "Good catch!" and upvote but we don\'t want to do that more than once in a PR.',
    "",
  ].join("\n");
  writeFileSync(path.join(f.root, "agents", "pr-updater.md"), `---\nmodel: fixture\n---\n${body}`);
  assert.equal((await f.scan()).dispatched, 1);
  const prompt = f.store.task(f.taskId).interaction.messages.at(-1).text;
  assert.equal(prompt.slice(0, body.length), body);
  assert.equal(prompt.slice(body.length).trim().split("\n").length, 3);
  assert.doesNotMatch(prompt, /spool_get_task|spool_add_comment|spool_update_task_status|bohemia_/);
  assert.match(f.store.metadata(f.taskId).contract.completionInstructions, /spool_update_task_status/);
});

test("cleaned updater role is handed off verbatim with artifact pointers, not duplicated instructions", async t => {
  const f = await handoff(t, "perf", { dispatch: false });
  const source = path.join(f.root, "agents", "pr-updater.md");
  const body = "# Role\r\n\r\nExact cleaned updater instructions.\r\nKeep this spacing.  \r\n";
  writeFileSync(source, `---\r\nmodel: fixture\r\n---\r\n${body}`);
  const creatorFile = path.join(f.root, "agents", "perf.md");
  writeFileSync(creatorFile, "Creator-only sentinel: preserve the measured performance goal.");
  assert.equal((await f.scan()).dispatched, 1);
  const task = f.store.task(f.taskId), metadata = f.store.metadata(f.taskId);
  const prompt = task.interaction.messages.at(-1).text;
  assert.ok(prompt.startsWith(body));
  assert.equal(prompt.split(body).length - 1, 1);
  assert.equal(metadata.updatePrompt.source, source);
  assert.equal(metadata.updatePrompt.procedureSha256, digest(body));
  assert.equal(task.session_id, f.session);
  assert.equal(task.agent, "perf");
  assert.equal(metadata.contract.creatorRoleFile, creatorFile);
  assert.ok(!prompt.includes(creatorFile));
  assert.ok(prompt.includes(metadata.contract.contractFile));
  assert.deepEqual(JSON.parse(readFileSync(metadata.contract.contractFile, "utf8")), metadata.contract);
  assert.doesNotMatch(prompt, /Creator-only sentinel|Existing fixture description|Reproduce recovery after/);
  assert.doesNotMatch(prompt, /## Review procedure|## Exact review contract|model: fixture/);
});

test("role edits during preparation are reloaded before the actual handoff", async t => {
  const body = "# Role\nUpdated during preparation; deliver these exact instructions.\n";
  const f = await handoff(t, "perf", { dispatch: false, prepare: args => {
    writeFileSync(path.join(f.root, "agents", "pr-updater.md"), body);
    return { ready: true, repoRoot: args.repoRoot, branch: args.branch, commit: "b".repeat(40) };
  } });
  assert.equal((await f.scan()).dispatched, 1);
  const prompt = f.store.task(f.taskId).interaction.messages.at(-1).text;
  assert.ok(prompt.startsWith(body));
  assert.equal(f.store.metadata(f.taskId).updatePrompt.procedureSha256, digest(body));
});

for (const agent of ["perf", "software-engineer", "tech-writer", "ci"]) {
  test(`${agent} receives the complete canonical updater procedure and renderer without losing creator identity`, async t => {
    const f = await handoff(t, agent), procedure = await readReviewProcedure(f.root);
    const shared = reviewPrompt(f.metadata.contract, procedure, { transport: "spool" });
    const followup = f.task.interaction.messages.at(-1).text;
    assert.equal(f.task.prompt, f.brief);
    assert.ok(shared.includes(procedure));
    assert.equal(followup, shared);
    assert.ok(!followup.includes(f.brief), "Original context must come from the restored conversation");
    assert.equal(followup.split(procedure).length - 1, 1);
    assert.equal(f.task.agent, agent);
    assert.equal(f.task.session_id, f.session);
    assert.equal(f.task.workspace, f.workspace);
    assert.equal(f.task.turns, 12);
    assert.ok(f.task.comments.some(comment => comment.message === "Existing creator context is preserved."));
    assert.equal(f.metadata.updatePrompt.procedureSha256, digest(procedure));
    assert.equal(f.metadata.updatePrompt.promptSha256, digest(followup));
    assert.equal(f.metadata.updatePrompt.source, path.join(f.root, "agents", "pr-updater.md"));
    assert.match(followup, /original task\/session/);
    assert.ok(followup.endsWith("Switch branches."));
    assert.doesNotMatch(followup, /prepared checkout|new-task setup|default checkout/);
    assert.doesNotMatch(followup, /Checkout head:|Result marker:|Guarded resolver:|## Assignment/);
    assert.equal(f.metadata.contract.resultFile, path.join(f.store.records, "results", `${digest(f.metadata.key)}.json`));
    assert.ok(existsSync(path.dirname(f.metadata.contract.resultFile)));
    const savedContract = JSON.parse(readFileSync(f.metadata.contract.contractFile, "utf8"));
    assert.deepEqual(savedContract, f.metadata.contract);
    assert.ok(savedContract.findings[0].comments[0].body);
    assert.ok(!followup.includes(savedContract.findings[0].comments[0].body));
    assert.doesNotMatch(followup, /PUT the issue document|X-Paperclip-Run-Id|Read GET \/api\/issues/);
    assert.equal(savedContract.resultMarker, undefined);
    assert.equal(savedContract.resolutionMode, "runner");
    assert.equal(savedContract.resolverCommands, undefined);
    assert.match(savedContract.completionInstructions, /runner owns guarded thread resolution/);
    assert.doesNotMatch(followup, /resolve-thread\.mjs/);
  });
}

for (const trigger of ["review", "build"]) {
  test(`${trigger} handoffs receive the same complete canonical procedure`, async t => {
    const f = await handoff(t, "perf", { trigger }), procedure = await readReviewProcedure(f.root);
    assert.equal(f.task.interaction.messages.at(-1).text.split(procedure).length - 1, 1);
    assert.equal(f.metadata.contract.repair?.type, trigger === "build" ? "build" : undefined);
    assert.ok(f.metadata.contract.findings.length > 0);
  });
}

test("changed canonical files reach future handoffs; missing/empty files hold before preparation or dispatch", async t => {
  const first = await handoff(t, "perf");
  const procedureFile = path.join(first.root, "agents", "pr-updater.md");
  const procedure = await readReviewProcedure(first.root);
  assert.ok(first.task.interaction.messages.at(-1).text.includes(procedure));
  finishTask(first, first.taskId);
  first.pr.sourceCommit = "c".repeat(40);
  const revised = `${procedure}\n- Preserve this exact revised role sentinel.\n`;
  writeFileSync(procedureFile, `---\nmodel: fixture\n---\n${revised}`);
  assert.equal((await first.scan()).dispatched, 1);
  assert.ok(first.store.task(first.taskId).interaction.messages.at(-1).text.startsWith(revised));
  assert.equal(first.store.metadata(first.taskId).updatePrompt.procedureSha256, digest(revised));
  for (const empty of [true, false]) {
    const held = await handoff(t, "perf", { dispatch: false });
    const file = path.join(held.root, "agents", "pr-updater.md");
    if (empty) writeFileSync(file, "---\nmodel: fixture\n---\n \n\t");
    else unlinkSync(file);
    const outcome = await held.scan();
    assert.equal(outcome.dispatched, 0);
    assert.match(outcome.holding, empty ? /procedure is empty/ : /ENOENT/);
    assert.equal(held.preparations(), 0);
    assert.equal(held.store.task(held.taskId).status, "completed");
    assert.equal(held.store.task(held.taskId).prompt, held.brief);
    assert.equal(held.store.metadata(held.taskId), null);
  }
});

test("updater preview uses the same role and renderer and reloads edits without a copied procedure", async t => {
  const f = await handoff(t, "perf", { dispatch: false });
  const input = { spool_dir: f.root, pr_updater: { enabled: true, handoff_instructions: "Saved extra instructions." } };
  const workflow = definition(input, "pr-updater");
  const file = path.join(f.root, "agents", "pr-updater.md");
  for (const body of ["# Role\nExact updater preview.\n", "# Role\nUpdated updater preview.\n"]) {
    writeFileSync(file, `---\nmodel: fixture\n---\n${body}`);
    const value = await inspectWorkflow(input, workflow);
    const preview = value.inspection[workflow.nodes.at(-1).id];
    assert.ok(preview.prompt.startsWith(body));
    assert.equal(preview.prompt.split(body).length - 1, 1);
    assert.equal(preview.promptSource, file);
    assert.match(preview.prompt, /Saved extra instructions/);
    assert.match(preview.prompt, /\{\{contract\.contractFile\}\}/);
    assert.doesNotMatch(preview.prompt, /## Review procedure|## Exact review contract|model: fixture/);
  }
});

test("canonical renderer requires the project prompt and rejects legacy delivery", async t => {
  const f = await handoff(t, "perf", { dispatch: false });
  const contract = { identifier: "OFF-fixture", prId: "123", agent: "perf", branch: "topic",
    cwd: "fixture", head: "a".repeat(40), resolutionMode: "runner",
    findings: [], submissionId: "fixture-submission", fingerprint: "fixture",
    contractFile: "fixture-contract.json", creatorRoleFile: "fixture-creator.md", resultFile: "fixture-result.json" };
  await assert.rejects(readReviewProcedure(), /absolute Spool project root/);
  const procedure = await readReviewProcedure(f.root);
  assert.throws(() => reviewPrompt(contract, ""), /required/);
  assert.throws(() => reviewPrompt(contract, procedure, { transport: "unknown" }), /Unknown/);
  assert.throws(() => reviewPrompt(contract, procedure, { transport: "paperclip" }), /only Spool/);
  const spool = reviewPrompt(contract, procedure, { transport: "spool" });
  assert.equal(reviewPrompt(contract, procedure), spool);
  assert.ok(spool.includes(procedure));
  assert.match(spool, /original task\/session/);
  assert.doesNotMatch(spool, /PR_UPDATE_RESULT_FILE|resolve-thread\.mjs/);
  assert.throws(() => reviewPrompt({ ...contract, contractFile: undefined }, procedure, { transport: "spool" }), /file paths/);
  assert.doesNotMatch(spool, /PUT the issue document|X-Paperclip-Run-Id|Read GET \/api\/issues/);
});

test("contract completion tools are deterministic, lossless, and leave the input untouched", () => {
  const original = { prId: "123", submissionId: "submission:123", contractFile: "C:\\fixture\\contract.json",
    creatorRoleFile: "C:\\fixture\\creator.md", resultFile: "C:\\fixture\\result.json",
    resolutionMode: "runner",
    head: "a".repeat(40), fingerprint: "current-feedback", findings: [{ threadId: "42", comments: [{ body: "Exact feedback." }] }] };
  const before = structuredClone(original);
  const completed = withSpoolReviewTools(original);
  assert.deepEqual(original, before);
  for (const [key, value] of Object.entries(original)) assert.deepEqual(completed[key], value);
  assert.deepEqual(withSpoolReviewTools(completed), completed);
  assert.equal(completed.resultMarker, undefined);
  assert.equal(completed.resolverCommands, undefined);
  assert.match(completed.completionInstructions, /runner owns guarded thread resolution/);
  assert.throws(() => withSpoolReviewTools({ ...original, resolutionMode: undefined }), /runner-owned resolution/);
  assert.throws(() => withSpoolReviewTools({ ...original, submissionId: undefined }), /submission identity/);
  assert.throws(() => withSpoolReviewTools({ ...original, resultFile: undefined }), /file paths/);
});

const binary = process.env.SPOOL_TEST_BINARY || runnerEngine();
test("actual Spool MCP returns the exact canonical updater prompt on the original CI task", {
  skip: !process.env.SPOOL_TEST_BINARY && !existsSync(binary) ? "Build the application engine or set SPOOL_TEST_BINARY for the real MCP transcript test" : false,
}, async t => {
  assert.ok(existsSync(binary), `Spool test executable is missing: ${binary}`);
  const f = await handoff(t, "ci");
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
