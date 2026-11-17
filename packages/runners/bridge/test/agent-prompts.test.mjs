import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const spoolRoot = path.resolve(import.meta.dirname, "..", "..", "..", "spool");
const manifest = JSON.parse(readFileSync(path.join(spoolRoot, "agents", "paperclip-prompts.json"), "utf8"));
const roles = [
  "chief-of-staff", "perf", "perf-engine-manager", "pr-reviewer", "pr-updater",
  "prompt-engineer", "software-engineer", "tech-writer", "tooling-engineer", "workflow-auditor",
];
const documentationRule = "Only change documentation, READMEs, or code comments when explicitly requested or needed to explain non-obvious behavior; keep small behavioral notes to one or two sentences and omit implementation walkthroughs, test summaries, and task history.";

test("spelling has a concise engine-first role and an executable regression/regeneration template", () => {
  const prompt = readFileSync(path.join(spoolRoot, "agents", "spelling.md"), "utf8");
  assert.ok(prompt.trim().split(/\s+/).length < 65);
  for (const requirement of ["shared engine", "regression tests", "quality.md", "repair.mjs",
    "NEVER manually edit repository prose", "one-off regex", "code/interfaces", "engine/tooling"]) {
    assert.ok(prompt.includes(requirement), requirement);
  }
  const template = readFileSync(path.resolve(import.meta.dirname, "..", "..", "scanners", "spelling", "quality.md"), "utf8");
  for (const requirement of ["--journal", "--owner", "--apply", "false-positive", "Bohemia", "blocker", "unresolved"]) {
    assert.ok(template.includes(requirement), requirement);
  }
});

test("all original role mappings have a pinned Paperclip prompt", () => {
  assert.equal(manifest.version, 1);
  assert.deepEqual(Object.keys(manifest.roles).sort(), roles.toSorted());
  assert.deepEqual(manifest.roles["pr-updater"].original, ["PRUpdater", "PRUpdater 2"]);
});

for (const role of roles.filter(role => !["perf", "pr-reviewer"].includes(role))) {
  test(`${role} preserves its original prompt apart from the concise documentation rule`, () => {
    const file = readFileSync(path.join(spoolRoot, "agents", `${role}.md`));
    const header = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(file.toString("utf8"))?.[0];
    assert.ok(header, "Native configuration must remain separate from the original role body");
    const body = file.subarray(Buffer.byteLength(header)).toString("utf8")
      .replace(new RegExp(`^[*-] ${documentationRule.replaceAll(".", "\\.")}\\r?\\n`, "m"), "");
    assert.equal(createHash("sha256").update(body).digest("hex"), manifest.roles[role].sha256,
      "The original role must not be summarized, truncated, normalized, or silently rewritten");
  });
}

test("every agent receives the same single documentation rule", () => {
  for (const role of [...roles, "engineering-manager", "reviewer"]) {
    const prompt = readFileSync(path.join(spoolRoot, "agents", `${role}.md`), "utf8");
    assert.equal(prompt.split(documentationRule).length - 1, 1, role);
  }
});

test("reviewer retains evidence and external-action verification without obsolete task or evidence services", () => {
  const prompt = readFileSync(path.join(spoolRoot, "agents", "pr-reviewer.md"), "utf8");
  assert.doesNotMatch(prompt, /Cairn|Paperclip|PAPERCLIP/);
  assert.match(prompt, /existing local review log and current Spool task; no separate evidence service is required/);
  for (const tool of ["spool_update_task_status", "spool_get_task"]) assert.ok(prompt.includes(tool));
  assert.doesNotMatch(prompt, /spool_add_comment/);
  assert.match(prompt, /Verify posted finding IDs or the approval vote against the assigned source commit/);
  assert.match(prompt, /verify the required notification was sent/);
  assert.match(prompt, /Do not stop after the first finding/);
  assert.match(prompt, /Do not repeat the full review or send another notification/);
  assert.match(prompt, /record the exact blocker and mark the task `failed`/);
});

test("perf has native task instructions and MCP publication", () => {
  const role = readFileSync(path.join(spoolRoot, "agents", "perf.md"), "utf8");
  assert.doesNotMatch(role, /paperclip|compatibility|supersede|report-defect|PerfEngineManager|bohemia_pr_create|work product|in_review|blockedByIssueIds/i);
  for (const tool of ["spool_get_task", "spool_update_task_status",
    "bohemia_pr"]) assert.ok(role.includes(tool));
  assert.match(role, /repository: "office-bohemia"/);
  assert.match(role, /pushed code alone is not completion/);
  assert.doesNotMatch(role, /spool_add_comment/);
});

test("perf owns validation while repository MCP owns pushing and PR publication", () => {
  const role = readFileSync(path.join(spoolRoot, "agents", "perf.md"), "utf8");
  assert.doesNotMatch(role, /bohemia_build|bohemia_check|bohemia push/);
  assert.match(role, /Run builds, tests, focused reproductions, browser benchmarks and screenshots directly/);
  assert.match(role, /Agent MCP access is publication-only/);
  assert.match(role, /the PR tool owns pushing the verified branch/);
});
