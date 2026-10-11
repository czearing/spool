#!/usr/bin/env node
/**
 * Generates actionable, module-clustered TODO reports (JSON and Markdown) for eliminating AI slop comments.
 * Groups related files in similar directories/subsystems into cohesive, condensed tasks.
 * Dispatch is owned by the supervised Spool scanner.
 *
 * Usage:
 *   node todo.js --dry-run --repo <checkout>
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeStandardTodoFiles } from "../../packages/bohemia-agent-tooling/src/index.js";
import { scanTrees } from "./scan.js";
import { loadTargets, measureFile, reproductionCommand } from "./metrics.js";
import { buildSlopConfig, fromHere } from "./config.js";
import { clusterFiles } from "./cluster.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Builds pure structured data for AI slop findings across the scanned repository.
 */
export function buildTodoData({
  repoRoot,
  trees,
  minScore = 60,
  maxRankedFiles = 50,
  maxOpenTasks = 2,
  activeTasks = [],
  budgets = {},
}) {
  const scan = scanTrees({ repoRoot, trees });
  const filesMeasured = [];
  let totalSlopLines = 0;
  let totalSlopComments = 0;
  let totalCodeLines = 0;

  const categoryCounts = {
    tautology: 0,
    ai_filler: 0,
    bloated_doc: 0,
    structural_noise: 0,
    micro_narration: 0,
    excessive_length: 0,
  };

  const activePaths = new Set(
    activeTasks
      .map((t) => {
        const match = t.title && t.title.match(/slop:\s+([^\s(]+)/);
        return match ? match[1] : null;
      })
      .filter(Boolean),
  );

  for (const relPath of scan.source) {
    const result = measureFile({ repoRoot, relPath, minScore });
    if (!result) continue;

    totalCodeLines += result.totalCodeLines;

    if (result.totalSlopComments > 0) {
      totalSlopLines += result.totalSlopLines;
      totalSlopComments += result.totalSlopComments;

      for (const f of result.findings) {
        if (categoryCounts[f.category] !== undefined) {
          categoryCounts[f.category] += 1;
        } else {
          categoryCounts.ai_filler += 1;
        }
      }

      filesMeasured.push({
        path: relPath,
        slopComments: result.totalSlopComments,
        slopLines: result.totalSlopLines,
        codeLines: result.totalCodeLines,
        slopDensity: result.slopDensity,
        isInFlight: activePaths.has(relPath) || Array.from(activePaths).some((p) => relPath.includes(p)),
        reproduction: reproductionCommand([relPath]),
        findings: result.findings.map((f) => ({
          startLine: f.startLine,
          endLine: f.endLine,
          lineCount: f.lineCount,
          category: f.category,
          severity: f.severity,
          score: f.score,
          reasons: f.reasons,
          snippet: f.rawText,
          cleanSnippet: f.cleanText,
          targetIdentifier: f.targetIdentifier,
          targetCodeLine: f.targetCodeLine,
        })),
      });
    }
  }

  // Sort files by worst slop lines first
  filesMeasured.sort((a, b) => b.slopLines - a.slopLines || b.slopDensity - a.slopDensity || a.path.localeCompare(b.path));

  // Cluster files into condensed module/folder-scoped tasks
  const rankedTasks = clusterFiles(filesMeasured, { maxFilesPerCluster: 35, activeTasks });
  const rankedFiles = filesMeasured.slice(0, maxRankedFiles);
  const unqueuedTasks = rankedTasks.filter((t) => !t.isInFlight);

  const isClosed = activeTasks.length >= maxOpenTasks;
  const waitingBehindCap = isClosed ? unqueuedTasks : [];

  return {
    generatedAt: new Date().toISOString(),
    repoRoot,
    trees,
    queueCap: {
      open: activeTasks.length,
      max: maxOpenTasks,
      isClosed,
      remainingSlots: Math.max(0, maxOpenTasks - activeTasks.length),
    },
    inFlight: activeTasks.map((task) => ({
      issueId: task.id,
      identifier: task.identifier,
      title: task.title,
      status: task.status,
      priority: task.priority,
      createdAt: task.createdAt,
    })),
    summary: {
      totalFilesScanned: scan.source.length,
      filesWithSlop: filesMeasured.length,
      totalTaskClusters: rankedTasks.length,
      totalCodeLines,
      totalSlopLines,
      totalSlopComments,
      overallSlopDensity: totalCodeLines > 0 ? Number((totalSlopLines / totalCodeLines).toFixed(4)) : 0,
      categoryBreakdown: categoryCounts,
      skippedByExclusion: scan.skipped.length,
    },
    rankedTasks,
    rankedFiles,
    waitingBehindCap: waitingBehindCap.map((t) => ({
      title: t.title,
      directory: t.directory,
      fileCount: t.fileCount,
      files: t.files,
      slopLines: t.totalSlopLines,
      slopComments: t.totalSlopComments,
      reproduction: t.reproduction,
    })),
  };
}

async function main(argv) {
  const config = buildSlopConfig({ argv });
  if (!config.dryRun || config.dispatch) {
    throw new Error("Run slop through spool-runners; standalone todo supports --dry-run measurements only");
  }
  const profile = loadTargets(fromHere(config.targetsPath));
  const initialData = buildTodoData({
    repoRoot: config.repoRoot,
    trees: config.trees,
    minScore: config.minSlopScore,
    maxRankedFiles: config.maxRankedFiles,
    maxOpenTasks: config.maxOpenTasks,
    activeTasks: [],
    budgets: profile.budgets,
  });

  mkdirSync(dirname(config.todoJsonPath), { recursive: true });

  writeStandardTodoFiles({
    jsonPath: config.todoJsonPath,
    data: initialData,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        todoJsonPath: config.todoJsonPath,
        queueCap: initialData.queueCap,
        filesWithSlop: initialData.summary.filesWithSlop,
        totalTaskClusters: initialData.summary.totalTaskClusters,
        totalSlopLines: initialData.summary.totalSlopLines,
        totalSlopComments: initialData.summary.totalSlopComments,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  process.exitCode = await main(process.argv.slice(2));
}
