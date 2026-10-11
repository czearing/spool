/**
 * Metric definitions and measurement routines for the slop engine.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractComments } from "./parser.js";
import { analyzeFileComments } from "./detector.js";
import { isExcluded } from "./exclusion.js";

export const MEASURE_ENTRY_POINT = resolve(dirname(fileURLToPath(import.meta.url)), "measure.js");

export const METRICS = [
  {
    name: "slop.tautology-comments",
    unit: "comments",
    direction: "lower_is_better",
    note: "comments that merely repeat or echo the name of the function, variable, or type below them",
  },
  {
    name: "slop.ai-filler-comments",
    unit: "comments",
    direction: "lower_is_better",
    note: "comments with conversational AI filler, boilerplate lecturing, or template phrasing",
  },
  {
    name: "slop.bloated-doc-blocks",
    unit: "doc blocks",
    direction: "lower_is_better",
    note: "JSDoc/TSDoc blocks with redundant @param/@returns tags or excessive verbosity",
  },
  {
    name: "slop.structural-noise",
    unit: "comments",
    direction: "lower_is_better",
    note: "section banner comments and trivial section divider labels (e.g. // IMPORTS, // State)",
  },
  {
    name: "slop.micro-narration",
    unit: "comments",
    direction: "lower_is_better",
    note: "line-by-line trivial narration of basic control flow (if, for, return, throw)",
  },
  {
    name: "slop.total-slop-lines",
    unit: "lines",
    direction: "lower_is_better",
    note: "total lines of AI slop and redundant commentary across the file",
  },
];

export function metricByName(name) {
  const metric = METRICS.find((entry) => entry.name === name);
  if (!metric) throw new Error(`unknown metric: ${name}`);
  return metric;
}

export function loadTargets(path) {
  if (!existsSync(path)) {
    return {
      profile: "default",
      minSlopScore: 60,
      budgets: {
        "slop.tautology-comments": 0,
        "slop.ai-filler-comments": 0,
        "slop.bloated-doc-blocks": 0,
        "slop.structural-noise": 0,
        "slop.micro-narration": 0,
        "slop.total-slop-lines": 0,
      },
    };
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function reproductionCommand(paths) {
  const quoted = `"${MEASURE_ENTRY_POINT}"`;
  return `node ${quoted} ${paths.join(" ")}`;
}

/**
 * Measures AI slop across a single source file.
 */
export function measureFile({ repoRoot, relPath, minScore = 60 }) {
  if (isExcluded(relPath)) {
    return null;
  }

  const absolute = join(repoRoot, relPath.replace(/\//g, "\\"));
  let source;
  try {
    source = readFileSync(absolute, "utf8");
  } catch (err) {
    throw new Error(`cannot read file ${relPath}: ${err.message}`);
  }

  const comments = extractComments(source);
  const rawFindings = analyzeFileComments(comments);
  const findings = rawFindings.filter((f) => f.score >= minScore);

  let tautologyCount = 0;
  let aiFillerCount = 0;
  let bloatedDocCount = 0;
  let structuralNoiseCount = 0;
  let microNarrationCount = 0;
  let totalSlopLines = 0;

  for (const item of findings) {
    totalSlopLines += item.lineCount;
    if (item.category === "tautology") tautologyCount += 1;
    else if (item.category === "ai_filler" || item.category === "excessive_length") aiFillerCount += 1;
    else if (item.category === "bloated_doc") bloatedDocCount += 1;
    else if (item.category === "structural_noise") structuralNoiseCount += 1;
    else if (item.category === "micro_narration") microNarrationCount += 1;
    else aiFillerCount += 1;
  }

  const totalCodeLines = source.split(/\r?\n/).length;

  return {
    "slop.tautology-comments": {
      value: tautologyCount,
      evidence: findings.filter((f) => f.category === "tautology").map((f) => `line ${f.startLine}: ${f.cleanText.slice(0, 60)}`),
    },
    "slop.ai-filler-comments": {
      value: aiFillerCount,
      evidence: findings.filter((f) => f.category === "ai_filler" || f.category === "excessive_length").map((f) => `line ${f.startLine}: ${f.cleanText.slice(0, 60)}`),
    },
    "slop.bloated-doc-blocks": {
      value: bloatedDocCount,
      evidence: findings.filter((f) => f.category === "bloated_doc").map((f) => `line ${f.startLine}: ${f.cleanText.slice(0, 60)}`),
    },
    "slop.structural-noise": {
      value: structuralNoiseCount,
      evidence: findings.filter((f) => f.category === "structural_noise").map((f) => `line ${f.startLine}: ${f.cleanText.slice(0, 60)}`),
    },
    "slop.micro-narration": {
      value: microNarrationCount,
      evidence: findings.filter((f) => f.category === "micro_narration").map((f) => `line ${f.startLine}: ${f.cleanText.slice(0, 60)}`),
    },
    "slop.total-slop-lines": {
      value: totalSlopLines,
      evidence: [`${totalSlopLines} slop lines out of ${totalCodeLines} total lines`],
    },
    findings,
    totalSlopComments: findings.length,
    totalSlopLines,
    totalCodeLines,
    slopDensity: totalCodeLines > 0 ? Number((totalSlopLines / totalCodeLines).toFixed(4)) : 0,
  };
}
