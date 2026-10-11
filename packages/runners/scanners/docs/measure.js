#!/usr/bin/env node
/**
 * The reproduction command named in every written task. It recomputes the numbers for the paths it is
 * given and prints them beside their budgets, so the numbers in an issue can always be checked.
 *
 * It is named by absolute path in an issue and takes its repository root from DOCS_REPO_ROOT or
 * engine.config.json, so it runs from any working directory:
 *
 *   node "<engine dir>/measure.js" apps/new-office/README.md
 *   node "<engine dir>/measure.js" --all
 */

import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanTrees } from "./scan.js";
import { buildIdentifierIndex, loadTargets, measureFile, METRICS } from "./metrics.js";
import { exclusionReason } from "./exclusion.js";
import { loadEngineConfig } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));

export function measurePaths({ repoRoot, paths, budgets, identifierIndex }) {
  const rows = [];
  for (const path of paths) {
    const reason = exclusionReason(path);
    if (reason) {
      rows.push({ path, excluded: reason, metrics: [] });
      continue;
    }
    const kind = path.toLowerCase().endsWith(".md") ? "markdown" : "source";
    const numbers = measureFile({ repoRoot, relPath: path, kind, identifierIndex });
    rows.push({
      path,
      kind,
      metrics: METRICS.filter((metric) => numbers[metric.name]).map((metric) => ({
        metric: metric.name,
        current: numbers[metric.name].value,
        budget: budgets[metric.name],
        over: Math.max(0, numbers[metric.name].value - budgets[metric.name]),
        unit: metric.unit,
        evidence: numbers[metric.name].evidence,
      })),
    });
  }
  const totalOverage = rows.reduce(
    (total, row) => total + row.metrics.reduce((sum, entry) => sum + entry.over, 0),
    0,
  );
  return { rows, totalOverage };
}

async function main(argv) {
  const engineConfig = loadEngineConfig();
  const repoRoot = process.env.DOCS_REPO_ROOT ?? engineConfig.repoRoot ?? process.cwd();
  const profile = loadTargets(resolve(here, engineConfig.targetsPath));
  const scan = scanTrees({ repoRoot, trees: engineConfig.trees });
  const identifierIndex = buildIdentifierIndex({ repoRoot, sourcePaths: scan.source });

  const paths = argv.includes("--all") ? [...scan.markdown, ...scan.source] : argv.filter((arg) => !arg.startsWith("--"));
  if (paths.length === 0) {
    process.stdout.write(`${JSON.stringify({ error: "measure.js needs one or more repo relative paths, or --all" }, null, 2)}\n`);
    return 1;
  }

  const result = measurePaths({ repoRoot, paths, budgets: profile.budgets, identifierIndex });
  process.stdout.write(`${JSON.stringify({ repoRoot, ...result }, null, 2)}\n`);
  return 0;
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  process.exit(await main(process.argv.slice(2)));
}
