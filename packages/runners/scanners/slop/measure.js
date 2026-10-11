#!/usr/bin/env node
/**
 * Measurement tool for AI slop in code comments.
 * Recomputes slop metrics for given repository-relative paths and prints structured JSON with line-by-line evidence.
 *
 * Usage:
 *   node measure.js apps/new-office/src/router.ts
 *   node measure.js --all
 */

import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { scanTrees } from "./scan.js";
import { exclusionReason } from "./exclusion.js";
import { loadTargets, measureFile, METRICS } from "./metrics.js";
import { buildSlopConfig, fromHere } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));

export function measurePaths({ repoRoot, paths, budgets = {}, minScore = 60 }) {
  const rows = [];
  for (const path of paths) {
    const reason = exclusionReason(path);
    if (reason) {
      rows.push({ path, excluded: reason, metrics: [] });
      continue;
    }

    const numbers = measureFile({ repoRoot, relPath: path, minScore });
    if (!numbers) continue;

    rows.push({
      path,
      metrics: METRICS.filter((metric) => numbers[metric.name]).map((metric) => ({
        metric: metric.name,
        current: numbers[metric.name].value,
        budget: budgets[metric.name] ?? 0,
        over: Math.max(0, numbers[metric.name].value - (budgets[metric.name] ?? 0)),
        unit: metric.unit,
        evidence: numbers[metric.name].evidence,
      })),
      totalSlopComments: numbers.totalSlopComments,
      totalSlopLines: numbers.totalSlopLines,
      totalCodeLines: numbers.totalCodeLines,
      slopDensity: numbers.slopDensity,
      findings: numbers.findings,
    });
  }

  const totalOverage = rows.reduce(
    (total, row) => total + (row.metrics ? row.metrics.reduce((sum, entry) => sum + entry.over, 0) : 0),
    0,
  );
  const totalSlopLines = rows.reduce((sum, r) => sum + (r.totalSlopLines ?? 0), 0);
  const totalSlopComments = rows.reduce((sum, r) => sum + (r.totalSlopComments ?? 0), 0);

  return {
    rows,
    totalOverage,
    totalSlopLines,
    totalSlopComments,
  };
}

async function main(argv) {
  const config = buildSlopConfig({ argv });
  const profile = loadTargets(fromHere(config.targetsPath));
  const scan = scanTrees({ repoRoot: config.repoRoot, trees: config.trees });

  const paths = config.all
    ? scan.source
    : config.paths && config.paths.length > 0
      ? config.paths
      : argv.includes("--all")
        ? scan.source
        : argv.filter((arg) => !arg.startsWith("--"));

  if (paths.length === 0) {
    process.stdout.write(
      `${JSON.stringify({ error: "measure.js requires one or more repo-relative paths, or --all" }, null, 2)}\n`,
    );
    return 1;
  }

  const result = measurePaths({
    repoRoot: config.repoRoot,
    paths,
    budgets: profile.budgets,
    minScore: config.minSlopScore,
  });

  process.stdout.write(`${JSON.stringify({ repoRoot: config.repoRoot, ...result }, null, 2)}\n`);
  return 0;
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  process.exitCode = await main(process.argv.slice(2));
}
