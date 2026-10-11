/**
 * The configuration surface of the docs engine. Everything a person changes about how this tool
 * behaves is here or in the two json files beside it: the trees it reads, the readers it groups by,
 * the budgets, the floor, the cap, and where the log and the watermark live.
 *
 * The shared scaffold is configured, never forked. What is local to docs is the metric collection,
 * the reader grouping, the ranking rule and the wording of the issue.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  createTelemetryWriter,
  createMarkStore,
  defineChangeGate,
  defineCollector,
  defineOpenCapSelector,
  createMemoryQueue,
} from "../../packages/bohemia-agent-tooling/src/index.js";
import { scanTrees, inScope } from "./scan.js";
import { openTasks } from "./open-tasks.js";
import { buildIdentifierIndex, loadTargets } from "./metrics.js";
import { buildDocumentSets, renderDocsTask } from "./docset.js";
import { defineDocsSelector } from "./select.js";
import { gitHead, changedPaths } from "./watermark.js";
import { EXCLUSION_STATEMENT } from "./exclusion.js";

const here = dirname(fileURLToPath(import.meta.url));

export function fromHere(value) {
  return isAbsolute(value) ? value : resolve(here, value);
}

export function parseArgs(argv) {
  const options = { dryRun: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--repo") options.repoRoot = argv[++index];
    else if (arg === "--targets") options.targetsPath = argv[++index];
    else if (arg === "--telemetry") options.telemetryPath = argv[++index];
    else if (arg === "--watermark") options.watermarkPath = argv[++index];
    else if (arg === "--max-open") options.maxOpenTasks = Number(argv[++index]);
    else if (arg === "--min-overage") options.minOverage = Number(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.maxOpenTasks !== undefined && !Number.isInteger(options.maxOpenTasks)) {
    throw new Error("--max-open requires a whole number");
  }
  if (options.minOverage !== undefined && !Number.isInteger(options.minOverage)) {
    throw new Error("--min-overage requires a whole number");
  }
  return options;
}

export function loadEngineConfig(path = resolve(here, "engine.config.json")) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The docs collector. It scans the trees, measures every file past the exclusion, and returns one
 * observation per document set. Metric collection lives here, never in the shared core.
 */
export function createDocsCollector({ repoRoot, trees, budgets, readers, maxFilesPerSet, onScan }) {
  return defineCollector({
    name: "new-office-docs",
    collect() {
      const scan = scanTrees({ repoRoot, trees });
      const identifierIndex = buildIdentifierIndex({ repoRoot, sourcePaths: scan.source });
      const files = [
        ...scan.markdown.map((path) => ({ path, kind: "markdown" })),
        ...scan.source.map((path) => ({ path, kind: "source" })),
      ];
      const built = buildDocumentSets({ repoRoot, files, budgets, readers, identifierIndex, maxFilesPerSet });
      if (onScan) onScan({ scan, built });
      return built.observations;
    },
  });
}

/**
 * The trigger gate. A run that observes the same commit it observed last time appends its record and
 * exits. A run whose changed paths are all out of scope or excluded does the same.
 */
export function createDocsGate({ repoRoot, trees, watermarkPath, force }) {
  const store = createMarkStore({ path: watermarkPath });
  return defineChangeGate({
    store,
    bypass: Boolean(force),
    readCurrent: () => gitHead(repoRoot),
    isRelevant: ({ previous, current }) => {
      const changed = changedPaths({ repoRoot, from: previous, to: current });
      if (changed === null) {
        return { relevant: true, detail: { reason: previous ? "diff unavailable, measuring everything" : "first run" } };
      }
      const scoped = inScope({ paths: changed, trees });
      return {
        relevant: scoped.kept.length > 0,
        detail: {
          changed: changed.length,
          inScope: scoped.kept.slice(0, 10),
          inScopeCount: scoped.kept.length,
          skipped: scoped.skipped.slice(0, 10),
        },
      };
    },
    // A change the cap refused to act on is still unmeasured work, so the watermark stays where it is
    // and the next run sees the same change again.
    shouldAdvance: (outcome) => outcome.selection?.reason !== "max_open_tasks_reached",
  });
}

export function countOpenTasksFrom(telemetry) {
  return () => openTasks(telemetry.read()).length;
}

export function buildCycleConfig({ argv = [], env = process.env, engineConfig = loadEngineConfig(), queue: suppliedQueue } = {}) {
  const options = parseArgs(argv);
  const repoRoot = options.repoRoot ?? env.DOCS_REPO_ROOT ?? engineConfig.repoRoot;
  if (!repoRoot) throw new Error("the docs engine needs a repository root, set DOCS_REPO_ROOT");

  const targetsPath = fromHere(options.targetsPath ?? engineConfig.targetsPath);
  const profile = loadTargets(targetsPath);
  // A dry run measures for real and must leave no mark on the shipped record, so its log, its
  // watermark and its derived view are written beside the ones people read, never over them.
  const configuredTelemetry = fromHere(options.telemetryPath ?? env.DOCS_TELEMETRY_PATH ?? engineConfig.telemetryPath);
  const telemetryPath =
    options.dryRun && !options.telemetryPath
      ? resolve(dirname(configuredTelemetry), "docs-cycles.dry-run.jsonl")
      : configuredTelemetry;
  const watermarkPath = options.watermarkPath
    ? fromHere(options.watermarkPath)
    : options.dryRun
      ? resolve(dirname(telemetryPath), "docs-watermark.dry-run.json")
      : fromHere(env.DOCS_WATERMARK_PATH ?? engineConfig.watermarkPath);

  const queue = options.dryRun
    ? createMemoryQueue()
    : suppliedQueue;
  if (!queue) throw new Error("Run docs through spool-runners, or use --dry-run for a local measurement");

  const telemetry = createTelemetryWriter({ path: telemetryPath, tool: engineConfig.tool });
  const fromEnv = Number(env.DOCS_MAX_OPEN_TASKS);
  const maxOpenTasks = options.maxOpenTasks ?? (Number.isInteger(fromEnv) ? fromEnv : engineConfig.maxOpenTasks);
  const minOverage = options.minOverage ?? profile.minOverage;
  const scanned = { last: null };

  const todoPath = options.dryRun
    ? resolve(dirname(telemetryPath), "docs-todo.dry-run.md")
    : fromHere(engineConfig.todoPath);

  return {
    tool: engineConfig.tool,
    ...(options.dryRun ? {} : {
      agentWorkspaceRoot: fromHere(env.DOCS_WORKSPACE_ROOT ?? engineConfig.agentWorkspaceRoot ?? repoRoot),
    }),
    projectId: engineConfig.projectId ?? null,
    telemetry,
    queue,
    todoPath,
    gate: createDocsGate({ repoRoot, trees: engineConfig.trees, watermarkPath, force: options.force }),
    collectors: [
      createDocsCollector({
        repoRoot,
        trees: engineConfig.trees,
        budgets: profile.budgets,
        readers: engineConfig.readers,
        maxFilesPerSet: engineConfig.maxFilesPerSet,
        onScan: (result) => (scanned.last = result),
      }),
    ],
    selector: defineOpenCapSelector({
      selector: defineDocsSelector({ minOverage }),
      countOpen: countOpenTasksFrom(telemetry),
      maxOpenTasks,
    }),
    renderTask: (candidate) => renderDocsTask(candidate, { exclusionStatement: EXCLUSION_STATEMENT }),
    assigneeAgentId: engineConfig.assigneeAgentId,
    parentIssueId: env.DOCS_PARENT_ISSUE_ID ?? engineConfig.parentIssueId,
    bodyBudget: engineConfig.bodyBudget,
    titleBudget: engineConfig.titleBudget,
    context: {
      repoRoot,
      trees: engineConfig.trees,
      profile: profile.profile,
      targetsPath,
      watermarkPath,
      maxOpenTasks,
      minOverage,
      dryRun: options.dryRun,
      scanned,
    },
  };
}
