import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import ts from "typescript";
import { fromMarkdown } from "mdast-util-from-markdown";
import { parse } from "yaml";
import { proseText, scannerVersion } from "./check.mjs";

export const roles = ["required", "optional", "hidden", "notifyOnly"];
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fullPath = (root, file) => path.join(root, ...file.split("/"));
const sourceExtension = /\.(?:[cm]?js|jsx|tsx?)$/i;
const friendly = {
  "[OC]\\FluidX_Table": "Table", loopappeng: "Loop app", "[OC]\\Loop Canvas": "Canvas",
  ffxVideo: "Video", ffxrepo: "Repository", loopapi: "Loop API", loopcodeblocks: "Code blocks",
  "[OC]\\FluidX_SharedExp": "Shared experiences", fluidcomms: "Communications",
  loopbotaieng: "Loop AI", "[OC]\\FluidX_HostingComponents": "Hosting",
  "[OC]\\FluidX_LoopInteractions": "Loop interactions", looppages: "Loop pages",
  loopcontainerowners3: "Loop containers", loopwebservice: "Web service",
  workspaceseverywhere: "Loop workspaces", NotebooksContentGenerationEng: "Notebooks",
};
const subset = (a, b) => roles.every(role => a[role].every(identity => b[role].includes(identity)));
const size = footprint => new Set(roles.flatMap(role => footprint[role])).size;

export function reviewerRules(text) {
  const document = parse(text);
  const provider = document?.providers?.find(p => p.provider === "Ownership/CodeReviewers");
  if (!provider?.metadata?.reviewers || provider.allowInheritance === false) {
    throw new Error("Unsupported or missing inherited CodeReviewers policy");
  }
  return provider.metadata.reviewers.map(rule => {
    if (!rule.branches?.trim().startsWith("[Ref]") || !rule.scope?.trim().startsWith("[Glob]") ||
        roles.some(role => !Array.isArray(rule[role]) || rule[role].some(alias => typeof alias !== "string"))) {
      throw new Error("Unsupported reviewer policy; automatic batching held");
    }
    return rule;
  });
}

function matches(value, patterns) {
  const parts = patterns.split(";").map(part => part.trim()).filter(Boolean);
  return parts.some(part => !part.startsWith("!") && path.posix.matchesGlob(value, part)) &&
    !parts.some(part => part.startsWith("!") && path.posix.matchesGlob(value, part.slice(1)));
}

export function routing(file, rules) {
  const result = Object.fromEntries(roles.map(role => [role, new Set()]));
  for (const rule of rules) {
    if (!matches("refs/heads/master", rule.branches.trim().slice(5).trim()) ||
        !matches("/" + file, rule.scope.trim().slice(6).trim())) continue;
    for (const role of roles) for (const alias of rule[role]) result[role].add(alias);
  }
  return Object.fromEntries(roles.map(role => [role, [...result[role]].sort()]));
}

function position(text, issue) {
  if (!Number.isSafeInteger(issue.line) || !Number.isSafeInteger(issue.column) ||
      issue.line < 1 || issue.column < 1 || typeof issue.word !== "string") {
    throw new Error("Malformed spelling/grammar source location");
  }
  const lines = text.split("\n");
  if (issue.line > lines.length) throw new Error("Spelling/grammar source line is stale");
  return lines.slice(0, issue.line - 1).reduce((offset, line) => offset + line.length + 1, 0) + issue.column - 1;
}

function candidate(text, prose, issue) {
  const start = position(text, issue), end = start + issue.word.length;
  if (text.slice(start, end) !== issue.word || prose.slice(start, end) !== issue.word) {
    throw new Error("Spelling/grammar source or safe prose changed after scanning");
  }
  let replacement;
  if (issue.kind === "spelling") {
    if (issue.suggestions?.length !== 1 || /^[A-Z\d_-]+$/.test(issue.word)) return null;
    replacement = issue.suggestions[0];
    if (typeof replacement !== "string" || !/^[a-z]+(?:['-][a-z]+)*$/i.test(replacement)) return null;
    if (/^[A-Z]/.test(issue.word)) replacement = replacement[0].toUpperCase() + replacement.slice(1);
  } else if (issue.kind === "grammar") {
    if (issue.edits?.length !== 1 || !["CommaFixes", "Spaces"].includes(issue.rule)) return null;
    const edit = issue.edits[0];
    if (edit.type === "insertAfter") return null;
    replacement = edit.replacement;
    if (typeof replacement !== "string" || /[\r\n]/.test(issue.word + replacement)) return null;
    if (issue.rule === "CommaFixes") {
      if (issue.category !== "Punctuation" || !/^[ ,]*$/.test(issue.word + replacement) ||
          issue.word.replaceAll(" ", "") !== replacement.replaceAll(" ", "")) return null;
    } else if (issue.rule === "Spaces") {
      if (issue.category !== "Formatting" || !/^[ \t]+$/.test(issue.word) || !/^[ \t]+$/.test(replacement)) return null;
    }
  } else return null;
  if (replacement === issue.word || /[\r\n]/.test(replacement) ||
      replacement.includes("/*") || replacement.includes("*/")) return null;
  return { start, end, before: issue.word, replacement, kind: issue.kind, rule: issue.rule, line: issue.line };
}

function hasBareIdentifierReference(file, text, lineNumbers) {
  if (!sourceExtension.test(file)) return false;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return [...lineNumbers].some(lineNumber => {
    const line = lines[lineNumber - 1];
    if (typeof line !== "string") return false;
    const commentText = line
      .replace(/^[ \t]*(?:\/\/+|\/\*+|\*+\/?)[ \t]?/, "")
      .replace(/`[^`]*`/g, " ");
    return /\b(?:[a-z]+(?:[A-Z][a-z0-9]+)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\b/.test(commentText);
  });
}

function markdownShape(node) {
  return Object.fromEntries(Object.entries(node).filter(([key]) =>
    key !== "position" && !(node.type === "text" && key === "value")).map(([key, value]) =>
    [key, key === "children" ? value.map(markdownShape) : value]));
}

export function assertProseOnly(file, before, after) {
  const normalize = text => text.replace(/\r\n/g, "\n");
  if (file.endsWith(".md")) {
    assert.deepEqual(markdownShape(fromMarkdown(before)), markdownShape(fromMarkdown(after)),
      `Markdown structure or nonprose changed: ${file}`);
  } else {
    const oldSource = ts.createSourceFile(file, normalize(before), ts.ScriptTarget.Latest, true);
    const newSource = ts.createSourceFile(file, normalize(after), ts.ScriptTarget.Latest, true);
    assert.equal(oldSource.parseDiagnostics.length, 0, file);
    assert.equal(newSource.parseDiagnostics.length, 0, file);
    const printer = ts.createPrinter({ removeComments: true });
    assert.equal(printer.printFile(oldSource), printer.printFile(newSource), `Executable code changed: ${file}`);
  }
}

export function planBatches(report, { root, rules, identities,
  read = file => readFileSync(fullPath(root, file), "utf8") }) {
  const entries = [], held = [], exact = new Map();
  for (const finding of report.findings) {
    const file = finding.file;
    if (!/^(?:packages|apps)\/[^/]+\//.test(file) || /(?:^|\/)(?:CHANGELOG|HISTORY|NOTICE|LICENSE)/i.test(file) ||
        file.split("/").some(part => part === "..") || file.includes("\\")) {
      held.push({ file, reason: "Outside publishable package prose" }); continue;
    }
    const reviewers = routing(file, rules);
    if (!size(reviewers)) { held.push({ file, reason: "No explicit reviewer ownership" }); continue; }
    const unresolved = roles.flatMap(role => reviewers[role]).filter(alias => typeof identities.get(alias)?.group !== "boolean");
    if (unresolved.length) {
      held.push({ file, reason: "Reviewer identity is unresolved; automatic publication held", aliases: [...new Set(unresolved)] });
      continue;
    }
    const before = read(file), prose = proseText(file, before), candidates = [];
    for (const issue of finding.issues) {
      const edit = candidate(before, prose, issue);
      if (edit) candidates.push(edit);
      else held.push({ file, line: issue.line, word: issue.word, reason: "Ambiguous or context-dependent correction" });
    }
    candidates.sort((a, b) => a.start - b.start);
    const edits = candidates.filter((edit, index) => {
      const overlap = candidates.some((other, otherIndex) => index !== otherIndex &&
        edit.start < other.end && other.start < edit.end);
      if (overlap) held.push({ file, line: edit.line, word: edit.before, reason: "Overlapping corrections require review" });
      return !overlap;
    });
    if (!edits.length) continue;
    let after = before;
    for (const edit of [...edits].reverse()) after = after.slice(0, edit.start) + edit.replacement + after.slice(edit.end);
    try { assertProseOnly(file, before, after); }
    catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      held.push({ file, reason: `Parser invariance rejected correction: ${error.message}` });
      continue;
    }
    const teams = Object.fromEntries(roles.map(role => [role, reviewers[role].filter(alias =>
      role === "required" || identities.get(alias).group)]));
    const footprint = size(teams) ? teams : reviewers;
    const entry = { file, reviewers, footprint, before, after, edits };
    entries.push(entry);
    const key = JSON.stringify(footprint);
    if (!exact.has(key)) exact.set(key, footprint);
  }
  const maximal = [...exact.values()].filter(footprint =>
    ![...exact.values()].some(other => other !== footprint && subset(footprint, other)));
  const batches = maximal.map(footprint => ({ footprint, key: hash(footprint).slice(0, 12), files: [] }));
  for (const entry of entries) {
    const targets = batches.filter(batch => subset(entry.footprint, batch.footprint))
      .sort((a, b) => size(a.footprint) - size(b.footprint) || a.key.localeCompare(b.key));
    assert(targets.length, "A reviewed file lost its reviewer boundary");
    targets[0].files.push(entry);
  }
  for (const batch of batches) {
    const names = [...new Set(roles.flatMap(role => batch.footprint[role]).map(alias => friendly[alias]).filter(Boolean))];
    const packages = [...new Set(batch.files.map(entry => entry.file.split("/").slice(0, 2).join("/")))];
    batch.area = names.length === 1 ? names[0] : packages.length === 1 ?
      packages[0].split("/")[1].split("-").slice(0, 2).map(word => word[0].toUpperCase() + word.slice(1)).join(" ") :
      "Shared components";
    batch.packages = packages;
    batch.corrections = batch.files.reduce((sum, file) => sum + file.edits.length, 0);
    batch.fingerprint = hash({ scannerVersion, commit: report.commit, footprint: batch.footprint,
      files: batch.files.map(file => ({ file: file.file, edits: file.edits })) });
  }
  return { version: 1, scannerVersion, commit: report.commit,
    batches: batches.sort((a, b) => a.key.localeCompare(b.key)), held };
}

export async function validatePlan(plan, checker) {
  const held = [...plan.held], batches = [];
  for (const batch of plan.batches) {
    const files = [];
    for (const file of batch.files) {
      const checked = await checker.check(file.file, file.after);
      const changedLines = new Set(file.edits.map(edit => edit.line));
      const residual = [...checked.issues, ...checked.review].filter(issue => changedLines.has(issue.line));
      if (residual.length) {
        held.push({ file: file.file, reason: "Correction leaves unresolved language findings on an edited line",
          issues: residual });
      } else if (hasBareIdentifierReference(file.file, file.after, changedLines)) {
        held.push({ file: file.file,
          reason: "Correction still leaves a bare identifier-like token on an edited prose line" });
      } else files.push(file);
    }
    if (!files.length) continue;
    batches.push({ ...batch, files, corrections: files.reduce((sum, file) => sum + file.edits.length, 0),
      packages: [...new Set(files.map(file => file.file.split("/").slice(0, 2).join("/")))],
      fingerprint: hash({ scannerVersion, commit: plan.commit, footprint: batch.footprint,
        files: files.map(file => ({ file: file.file, edits: file.edits })) }) });
  }
  return { ...plan, batches, held };
}
