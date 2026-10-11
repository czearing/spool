import test from "node:test";
import assert from "node:assert/strict";
import { exclusionReason, isExcluded, partition } from "../exclusion.js";

test("agent related filenames are excluded at any depth", () => {
  assert.equal(isExcluded("apps/new-office/AGENTS.md"), true);
  assert.equal(isExcluded("packages/ux/CLAUDE.md"), true);
  assert.equal(isExcluded("SKILL.md"), true);
  assert.equal(isExcluded("src/agents.md"), true);
});

test(".github agent directories are excluded", () => {
  assert.equal(isExcluded(".github/skills/something.md"), true);
  assert.equal(isExcluded(".github/prompts/test.prompt.md"), true);
  assert.equal(isExcluded(".github/agents/engineer.json"), true);
  assert.equal(isExcluded(".github/instructions/spec.md"), true);
});

test("path segments naming agent, copilot or prompt are excluded", () => {
  assert.equal(isExcluded("packages/copilot-ux/src/button.ts"), true);
  assert.equal(isExcluded("apps/agent-runner/main.ts"), true);
  assert.equal(isExcluded("packages/prompt-builder/index.ts"), true);
});

test("normal source paths are kept", () => {
  assert.equal(isExcluded("apps/new-office/src/router.ts"), false);
  assert.equal(isExcluded("packages/new-office-ux/src/panel.tsx"), false);
});

test("partition splits kept and skipped with reason", () => {
  const result = partition([
    "apps/new-office/src/router.ts",
    "apps/new-office/AGENTS.md",
    "packages/copilot-ux/index.ts",
  ]);
  assert.deepEqual(result.kept, ["apps/new-office/src/router.ts"]);
  assert.equal(result.skipped.length, 2);
  assert.match(result.skipped[0].reason, /excluded/);
});
