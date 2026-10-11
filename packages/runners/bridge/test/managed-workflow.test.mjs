import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixture } from "./fixtures.mjs";
import { configure } from "../config.mjs";
import { definition, saveDefinition } from "../workflow-store.mjs";
import { inspectWorkflow } from "../workflow-inspection.mjs";
import { validateWorkflow, managedIds, eventSource } from "../../packages/workflow/index.mjs";
import { createSpoolQueue, renderSpoolTaskPrompt } from "../queue.mjs";
import { taskBody } from "../../scanners/pr-reviewer/lib/work-queue.mjs";
import { handoff } from "./updater-fixture.mjs";

function settings(f, id) {
  return { spool_dir: f.root, ado: { author_account: "reviewer@example.invalid", token: "PRIVATE_SENTINEL" },
    agent_workspaces: { "software-engineer": f.workspace },
    [id.replaceAll("-", "_")]: { enabled: true, ...(id === "pr-updater" ? {} : { workspace_dir: f.workspace }) } };
}
for (const id of managedIds) test(`${id} is a composition of shared integration operations`, async t => {
  const f = fixture(t), input = settings(f, id), value = await inspectWorkflow(input, definition(input, id));
  assert.equal(value.nodes.length, id === "spelling" ? 2 : 3);
  assert.equal(eventSource(value), id);
  assert.ok(validateWorkflow(value).every(node => !node.block && node.kind !== "runner"));
  assert.doesNotThrow(() => validateWorkflow({ ...value, id: "another-runner", kind: "custom" }));
  assert.ok(!JSON.stringify(value).includes("PRIVATE_SENTINEL"));
  const node = value.nodes.at(-1);
  if (id === "spelling") {
    assert.equal(node.kind, "data"); assert.equal(value.inspection[node.id].prompt, undefined); return;
  }
  assert.ok(value.inspection[node.id].prompt.includes("{{"));
  assert.match(value.inspection[node.id].prompt, /spool_/);
  if (id === "pr-updater") {
    assert.match(value.inspection[node.id].prompt, /original implementation owner/);
    assert.match(value.inspection[node.id].agentSource, /Original creator/);
  } else assert.equal(value.inspection[node.id].agentInstructions, "Fixture agent. Never executed.");
});
test("compositions persist executable topology while cosmetic changes preserve implicit settings", async t => {
  const f = fixture(t), input = settings(f, "pr-reviewer"), file = path.join(f.root, "spool-runners.json");
  input.pr_reviewer.editor = { name: "My reviewer", nodes: [
    { id: "node-0", position: { x: 12, y: 20 } },
    { id: "scanner", kind: "runner", label: "Legacy scanner", position: { x: 300, y: 0 } },
  ] };
  writeFileSync(file, JSON.stringify(input));
  const value = definition(input, "pr-reviewer");
  assert.deepEqual(value.nodes[0].position, { x: 12, y: 20 });
  const unchanged = await saveDefinition(file, f.root, value, value.revision);
  let stored = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(stored.pr_reviewer.parameters, undefined, "presentation saves must not introduce execution overrides");
  assert.equal(stored.pr_reviewer.handoff_instructions, undefined);
  assert.equal(stored.pr_reviewer.workflow, undefined);
  assert.equal(stored.pr_reviewer.scan_interval_seconds, undefined);
  unchanged.nodes[0].revisionSettleSeconds = "240";
  unchanged.nodes.at(-1).prompt = "{{event.prompt}}\nInclude the exact verification command.";
  const saved = await saveDefinition(file, f.root, unchanged, unchanged.revision);
  stored = JSON.parse(readFileSync(file, "utf8"));
  const config = configure(stored, "pr-reviewer", f.root).config;
  assert.equal(config.revisionSettleSeconds, 240);
  assert.equal(stored.pr_reviewer.workflow.nodes.at(-1).prompt, "{{event.prompt}}\nInclude the exact verification command.");
  assert.equal(stored.pr_reviewer.workflow.nodes[0].position, undefined);
  assert.equal(stored.ado.token, "PRIVATE_SENTINEL");
  const detail = await inspectWorkflow(stored, saved);
  assert.match(detail.inspection[saved.nodes.at(-1).id].prompt, /Include the exact verification command/);
  assert.throws(() => validateWorkflow({ ...saved, nodes: saved.nodes.slice(0, -1), edges: saved.edges.slice(0, -1) }), /event needs/);
  const invalid = structuredClone(saved); invalid.nodes[0].revisionSettleSeconds = "-1";
  assert.throws(() => validateWorkflow(invalid), /integer/);
  const relabeled = structuredClone(saved); relabeled.nodes[1].label = "Different execution";
  assert.doesNotThrow(() => validateWorkflow(relabeled));
  await assert.rejects(saveDefinition(file, f.root, value, value.revision), /changed elsewhere/);
});
test("review prompt preview is the canonical renderer and real queue handoffs receive saved instructions", async t => {
  const f = fixture(t), input = settings(f, "pr-reviewer");
  input.pr_reviewer.agent = "software-engineer";
  input.pr_reviewer.handoff_instructions = "Show the focused reproduction.";
  const value = await inspectWorkflow(input, definition(input, "pr-reviewer"));
  const pr = { id: "{{pr.id}}", title: "{{pr.title}}", url: "{{pr.url}}", sourceCommit: "{{pr.sourceCommit}}" };
  const body = taskBody(pr, { transport: "spool" }, { branch: "{{prepared.branch}}", repoRoot: f.workspace });
  const queue = createSpoolQueue(f.store, { agent: "software-engineer", workspace: f.workspace,
    runner: "pr-reviewer", handoffInstructions: input.pr_reviewer.handoff_instructions });
  queue.setPreparation(f.preparation);
  const issue = await queue.createIssue({ title: "Fixture review", description: body, assigneeAgentId: "software-engineer" });
  const prompt = f.store.task(issue.id).prompt;
  assert.equal(prompt, value.inspection[value.nodes.at(-1).id].prompt);
  assert.match(prompt, /Show the focused reproduction/);
  assert.match(prompt, /All original review, posting, approval and notification instructions remain unchanged/);
  assert.doesNotMatch(prompt, /Use this task only\. Do not post PR comments/);
  assert.equal(renderSpoolTaskPrompt(body, "pr-reviewer"), renderSpoolTaskPrompt(body, "pr-reviewer", ""));
});
test("saved livesite thresholds reach the scanner and invalid policies are rejected", t => {
  const f = fixture(t), input = settings(f, "livesite");
  input.livesite.parameters = { maxBuilds: 15, alertCooldownHours: 12, stuckMinutes: 45, persistentFailureMinutes: 30 };
  const config = configure(input, "livesite", f.root).config;
  for (const [key, value] of Object.entries(input.livesite.parameters)) assert.equal(config[key], value);
  input.livesite.parameters.maxBuilds = "not a number";
  assert.throws(() => configure(input, "livesite", f.root), /integer/);
});
test("updater additional instructions reach the original conversation without replacing the canonical procedure", async t => {
  const f = await handoff(t, "software-engineer", { dispatch: false });
  f.config.handoffInstructions = "Report the exact repair test.";
  assert.equal((await f.scan()).dispatched, 1);
  const prompt = f.store.task(f.taskId).interaction.messages.at(-1).text;
  assert.match(prompt, /Report the exact repair test/);
  assert.match(prompt, /original implementation owner/);
  assert.match(prompt, /PR_UPDATE_RESULT_FILE/);
});
test("the staged native launcher accepts saved managed settings", { skip: !process.env.SPOOL_TEST_RUNNER_BINARY }, t => {
  const f = fixture(t), file = path.join(f.root, "spool-runners.json");
  writeFileSync(file, JSON.stringify({ spool_dir: f.root,
    pr_reviewer: { enabled: false, parameters: { revisionSettleSeconds: 180 }, handoff_instructions: "Retain verification evidence.",
      workflow: { nodes: [], edges: [] } } }));
  const result = spawnSync(process.env.SPOOL_TEST_RUNNER_BINARY, ["--config", file, "status"],
    { encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /Completed: 0/);
});
