import { buildTitle, parseTitle } from "../../../bohemia-pr-mcp/src/categories.ts";
import { parseDescription, renderDescription } from "../../../bohemia-pr-mcp/src/render.ts";
import { descriptionFields } from "../../../bohemia-pr-mcp/src/tools.ts";
import { validate } from "../../../bohemia-pr-mcp/src/validate.ts";

export const prFields = {
  action: { type: "string", enum: ["create", "update"] },
  sourceBranch: { type: "string", minLength: 1 },
  targetBranch: { type: "string", minLength: 1 },
  pullRequestId: { type: "integer", minimum: 1 },
  draft: { type: "boolean", default: false },
  notify: { type: "boolean", default: false },
  ...descriptionFields,
};

export function pullRequestDraft(input, existing) {
  const stored = existing ? {
    ...parseTitle(existing.title || ""),
    ...parseDescription((existing.description || "").replace(/\n<!-- repository-mcp:[\w-]+ -->\s*$/, "")),
  } : {};
  const draft = Object.fromEntries(Object.keys(prFields).map(key => [key, input[key] ?? stored[key]]));
  draft.uiChange ??= /!\[[^\]]*\]\([^)]+\)/.test(draft.solution || "");
  const violations = validate(draft);
  for (const key of ["title", "problem", "solution", "validation"]) {
    const value = draft[key];
    if (typeof value !== "string" || !value.trim() || value.length > descriptionFields[key].maxLength)
      violations.push(`${key} must be nonempty text within its length limit`);
    if (typeof value === "string" && /(?:^|\n)#{1,6}\s|<!--|-->/.test(value))
      violations.push(`${key} cannot inject template headings or HTML comments`);
  }
  if (violations.length) throw new Error(`PR description rejected:\n${violations.join("\n")}`);
  return draft;
}

export function renderPullRequest(draft) {
  return { title: buildTitle(draft.category, draft.title), description: renderDescription(draft) };
}
