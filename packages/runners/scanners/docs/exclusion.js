import { createExclusionRules } from "../lib/exclusion.mjs";

export { segments } from "../lib/exclusion.mjs";
export const { exclusionReason, isExcluded, partition } = createExclusionRules();

export const EXCLUSION_STATEMENT = [
  "exclusion: never touch AGENTS.md, CLAUDE.md or SKILL.md at any depth, anything under .github/skills,",
  ".github/prompts, .github/agents or .github/instructions, or any path with agent, copilot or prompt",
  "in a path segment.",
].join(" ");
