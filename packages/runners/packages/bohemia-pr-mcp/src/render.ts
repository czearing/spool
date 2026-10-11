import type { Draft } from "./validate.ts";

/// The headings are the repository's own committed pull request template. Reviewers
/// treat an invented structure as a rejection condition, so they are copied verbatim
/// and are not configurable.
export const HEADINGS = {
  problem: "# What problem is the change addressing?",
  solution: "# What was your solution?",
  validation: "# How did you validate it?",
} as const;

export function renderDescription(draft: Draft): string {
  return [
    HEADINGS.problem,
    draft.problem.trim(),
    "",
    HEADINGS.solution,
    draft.solution.trim(),
    "",
    HEADINGS.validation,
    draft.validation.trim(),
    "",
  ].join("\n");
}

/// Sections are stored and returned verbatim, so an update revalidates the whole
/// pull request and preserves what it was not asked to change. Nothing is
/// reconstructed, which is what previously dropped an agent's tables and images.
export function parseDescription(description: string): {
  problem: string;
  solution: string;
  validation: string;
} {
  const section = (start: string, end?: string): string => {
    const from = description.indexOf(start);
    if (from < 0) return "";
    const rest = description.slice(from + start.length);
    const to = end ? rest.indexOf(end) : -1;
    return (to < 0 ? rest : rest.slice(0, to)).trim();
  };

  return {
    problem: section(HEADINGS.problem, HEADINGS.solution),
    solution: section(HEADINGS.solution, HEADINGS.validation),
    validation: section(HEADINGS.validation),
  };
}
