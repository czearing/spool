import { CATEGORIES, MAX_TITLE_WORDS, type Category } from "./categories.ts";

export type Draft = {
  category: Category;
  title: string;
  problem: string;
  solution: string;
  validation: string;
  uiChange: boolean;
};

/// Tables and images are the agent's markdown, so every prose check runs on the prose
/// alone. Measurements vary too much to render for the agent: one table or several,
/// any columns it needs.
export function proseOnly(text: string): string {
  let fenced = false;
  return text
    .split("\n")
    .filter((line) => {
      const value = line.trim();
      if (value.startsWith("```")) {
        fenced = !fenced;
        return false;
      }
      if (fenced) return false;
      if (value.startsWith("|")) return false;
      if (/^!\[[^\]]*\]\([^)]*\)$/.test(value)) return false;
      return Boolean(value);
    })
    .join(" ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const hasTable = (text: string): boolean => /^\s*\|.*\|\s*$/m.test(text);
const hasImage = (text: string): boolean => /!\[[^\]]*\]\([^)]+\)/.test(text);

/// Code is quoted, not written, so the wording rules do not apply to it. Everything
/// a reader reads as English, tables and captions included, is still checked.
const proseAndTables = (text: string): string =>
  text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");

/// Prose rules the JSON schema cannot see. The schema guarantees the shape; these
/// guarantee the wording, and every violation is returned at once so the agent
/// fixes the description in one pass rather than discovering rules one at a time.
/// `everywhere` rules also run over tables and image markdown, where a path or a
/// unit such as ms/op is legitimate but a dash or hype is still wrong.
const PROSE_RULES: { test: RegExp; violation: string; everywhere?: boolean }[] = [
  {
    test: /[\u2014\u2013]/,
    everywhere: true,
    violation: "contains an em or en dash; rewrite the sentence with a comma, a colon, or two sentences",
  },
  {
    test: /\b[\w.-]+\.(tsx?|jsx?|cs|cpp|h|hpp|json|s?css|py|rs|go|java|md|ya?ml)\b/i,
    violation: "names a source file; describe the behaviour that changed instead",
  },
  {
    test: /(^|\s)[\w.-]*[\\/][\w.-]+[\\/]?/,
    violation: "contains a file path; describe the area in words instead",
  },
  {
    test: /\blines?\s+\d+/i,
    violation: "cites line numbers; the diff already shows them",
  },
  {
    test: /\b(AB#\d+|#\d{3,}|[A-Z]{2,}-\d{2,})\b/,
    violation: "references a task, bug, or work item id, which is not part of the change",
  },
  {
    test: /\b(task|work[- ]?item|ticket|bug|story|backlog)\s*(id|number|#)/i,
    violation: "references tracking metadata, which is not part of the change",
  },
  {
    test: /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}\s*(am|pm)?\b/i,
    violation: "contains a timestamp or date, which is not part of the change",
  },
  {
    test: /\b(massive(ly)?|huge(ly)?|dramatic(ally)?|drastic(ally)?|vastly|tremendous(ly)?|incredibl[ey]|blazing(ly)?|seamless(ly)?|effortless(ly)?|flawless(ly)?|perfect(ly)?|bulletproof|rock[- ]solid|supercharge[sd]?|game[- ]chang\w*|revolutionar\w+|guarantee[sd]?)\b/i,
    everywhere: true,
    violation: "uses overconfident wording; state the outcome plainly",
  },
  {
    test: /\b(ai[- ]generated|generated (by|with) (ai|an ai|copilot|claude|chatgpt|cursor)|written (by|with) (ai|an ai|copilot|claude|chatgpt)|with the help of (ai|copilot|claude|chatgpt)|as an ai|co[- ]authored[- ]by:?\s*(copilot|claude|chatgpt)|authored by (ai|copilot|claude))\b/i,
    everywhere: true,
    violation: "credits an AI tool for the work, which never appears in pull request text",
  },
];

const sentences = (text: string): string[] =>
  proseOnly(text)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

function checkProse(field: string, text: string, violations: string[]) {
  const prose = proseOnly(text);
  if (!prose) {
    violations.push(`${field} is empty`);
    return;
  }
  if (!/[.!?]$/.test(prose)) violations.push(`${field} must end with a full stop`);
  for (const rule of PROSE_RULES) {
    const target = rule.everywhere ? proseAndTables(text) : prose;
    if (rule.test.test(target)) violations.push(`${field} ${rule.violation}`);
  }
}

export function validate(draft: Draft): string[] {
  const violations: string[] = [];

  if (!(draft.category in CATEGORIES)) {
    violations.push(`category must be one of ${Object.keys(CATEGORIES).join(", ")}`);
  }

  const title = draft.title.trim();
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length === 0) violations.push("title is empty");
  if (words.length > MAX_TITLE_WORDS) {
    violations.push(`title is ${words.length} words; the template allows at most ${MAX_TITLE_WORDS}`);
  }
  if (/[.!?]$/.test(title)) violations.push("title must not end with punctuation");
  // Two prefix habits to catch: the rendered form this tool itself produces, and the conventional
  // commit form a model reaches for by default. Only the category words count, so an ordinary
  // title like "Retry: keep the cached width" is not mistaken for a prefix.
  const categoryPrefix = new RegExp(`^\\s*(${Object.keys(CATEGORIES).join("|")})\\s*[:\\-]\\s`, "i");
  if (/^(✨|🐛|📝|📦|⚡|🧪|🔧|♻️)/.test(title) || /^\s*\w+\s*-\s/.test(title) || categoryPrefix.test(title)) {
    violations.push("title must not include the category prefix; the prefix is added for you");
  }
  for (const rule of PROSE_RULES) {
    if (rule.test.test(title)) violations.push(`title ${rule.violation}`);
  }

  checkProse("problem", draft.problem, violations);
  checkProse("solution", draft.solution, violations);
  checkProse("validation", draft.validation, violations);

  const problemCount = sentences(draft.problem).length;
  const solutionCount = sentences(draft.solution).length;
  const validationCount = sentences(draft.validation).length;
  if (problemCount > 1) violations.push(`problem is ${problemCount} sentences; the template allows one`);
  if (solutionCount > 2) violations.push(`solution is ${solutionCount} sentences; the template allows two`);
  if (validationCount > 1) {
    violations.push(`validation is ${validationCount} sentences; the template allows one`);
  }

  if (draft.uiChange && !hasImage(draft.solution)) {
    violations.push("uiChange is true, so the solution must embed before and after images");
  }
  if (draft.category === "perf" && !hasTable(draft.solution)) {
    violations.push("category is perf, so the solution must include a table of measured results");
  }

  return violations;
}
