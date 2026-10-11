#!/usr/bin/env node
/**
 * The docs engine entry point. One run is one cycle. No interface, no agent in the loop.
 *
 *   node cycle.js                 run against the configured repository
 *   node cycle.js --dry-run       measure for real, write to an in memory queue
 *   node cycle.js --force         ignore the watermark for one run
 *
 * The shared scaffold runs the cycle: read the record, read results back, ask the gate whether the
 * repository moved, collect, select at most one document set, write at most one issue, append
 * telemetry. The derived todo list is rebuilt afterwards from the log, and nothing reads it back.
 */

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runCycle, buildStandardTodoData, writeRunnerJson } from "../../packages/bohemia-agent-tooling/src/index.js";
import { buildCycleConfig } from "./config.js";
import { buildTodoView } from "./todo.js";
import { openTasks } from "./open-tasks.js";

export async function runDocsCycle(config) {
  const summary = await runCycle(config);

  writeFileSync(
    config.todoPath,
    buildTodoView(config.telemetry.read(), {
      maxOpenTasks: config.context.maxOpenTasks,
      minOverage: config.context.minOverage,
      ranked: summary.selection.ranked ?? [],
      scanned: config.context.scanned?.last ?? null,
    }),
    "utf8",
  );
  if (config.todoJsonPath) {
    writeRunnerJson(config.todoJsonPath, {
      ...buildStandardTodoData({
        openTasks: openTasks(config.telemetry.read()),
        transitions: config.telemetry.read(),
        maxOpenTasks: config.context.maxOpenTasks,
        backlog: (summary.selection.ranked ?? []).map(entry => ({
          metric: entry.set, current: entry.overage, target: 0,
          action: `Update ${entry.files} file(s) for ${entry.reader}`,
        })),
      }),
      ranked: summary.selection.ranked ?? [],
      gate: summary.gate,
      ...config.todoMetadata,
    });
  }

  return summary;
}

export function summarise(summary, config) {
  const scanned = config.context.scanned?.last ?? null;
  return {
    tool: summary.tool,
    empty: summary.empty,
    gate: {
      proceed: summary.gate?.proceed ?? true,
      reason: summary.gate?.reason ?? null,
      previous: summary.gate?.previous ?? null,
      current: summary.gate?.current ?? null,
      detail: summary.gate?.detail ?? null,
    },
    issueId: summary.issueId,
    issueIdentifier: summary.issueIdentifier,
    candidateSet: summary.selection.candidate?.setKey ?? null,
    candidateFiles: summary.selection.candidate?.files?.map((file) => file.path) ?? [],
    candidateOverage: summary.selection.candidate?.current ?? null,
    selectionReason: summary.selection.reason,
    openTasks: summary.selection.openTasks ?? null,
    maxOpenTasks: summary.selection.maxOpenTasks ?? config.context.maxOpenTasks,
    observedSets: summary.observations.length,
    ranked: summary.selection.ranked ?? [],
    filesMeasured: scanned?.built.measured.length ?? 0,
    filesSkippedByExclusion: scanned?.scan.skipped.length ?? 0,
    collectionFailures: summary.failures,
    telemetryPath: config.telemetry.path,
    todoPath: config.todoPath,
  };
}

/**
 * One json summary on stdout, exit 0 for a completed cycle including an empty one, exit 1 for a cycle
 * that could not run.
 */
export async function runDocsWake(config, { stdout = process.stdout } = {}) {
  try {
    const summary = await runDocsCycle(config);
    stdout.write(`${JSON.stringify(summarise(summary, config), null, 2)}\n`);
    return 0;
  } catch (error) {
    stdout.write(`${JSON.stringify({ error: error.message }, null, 2)}\n`);
    return 1;
  }
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  process.exit(await runDocsWake(buildCycleConfig({ argv: process.argv.slice(2) })));
}
