/**
 * Configuration loader and CLI argument parser for the slop engine.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export function fromHere(value) {
  return isAbsolute(value) ? value : resolve(here, value);
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") options.repoRoot = argv[++index];
    else if (arg === "--trees") options.trees = argv[++index].split(",").map((s) => s.trim());
    else if (arg === "--targets") options.targetsPath = argv[++index];
    else if (arg === "--min-score") options.minSlopScore = Number(argv[++index]);
    else if (arg === "--max-files") options.maxRankedFiles = Number(argv[++index]);
    else if (arg === "--max-open") options.maxOpenTasks = Number(argv[++index]);
    else if (arg === "--todo") options.todoPath = argv[++index];
    else if (arg === "--todo-json") options.todoJsonPath = argv[++index];
    else if (arg === "--telemetry") options.telemetryPath = argv[++index];
    else if (arg === "--dispatch") options.dispatch = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--all") options.all = true;
    else if (!arg.startsWith("--")) {
      if (!options.paths) options.paths = [];
      options.paths.push(arg);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export function loadEngineConfig(path = resolve(here, "engine.config.json")) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function buildSlopConfig({ argv = [], env = process.env, engineConfig = loadEngineConfig() } = {}) {
  const options = parseArgs(argv);
  const repoRoot = options.repoRoot ?? env.SLOP_REPO_ROOT ?? engineConfig.repoRoot ?? process.cwd();
  if (!repoRoot) throw new Error("the slop engine needs a repository root, set SLOP_REPO_ROOT or pass --repo");

  const trees = options.trees ?? (env.SLOP_TREES ? env.SLOP_TREES.split(",").map((s) => s.trim()) : engineConfig.trees);
  const targetsPath = fromHere(options.targetsPath ?? engineConfig.targetsPath ?? "./targets.json");
  const todoPath = fromHere(options.todoPath ?? engineConfig.todoPath ?? "./telemetry/slop-todo.md");
  const todoJsonPath = fromHere(options.todoJsonPath ?? engineConfig.todoJsonPath ?? "./telemetry/slop-todo.json");
  const telemetryPath = fromHere(options.telemetryPath ?? engineConfig.telemetryPath ?? "./telemetry/slop-cycles.jsonl");
  const minSlopScore = options.minSlopScore ?? engineConfig.minSlopScore ?? 60;
  const maxRankedFiles = options.maxRankedFiles ?? engineConfig.maxRankedFiles ?? 50;
  const maxOpenTasks = options.maxOpenTasks ?? (env.SLOP_MAX_OPEN_TASKS ? Number(env.SLOP_MAX_OPEN_TASKS) : engineConfig.maxOpenTasks ?? 2);
  const assigneeAgentId = engineConfig.assigneeAgentId ?? "f833b5c8-7703-4d35-beb3-f89cd3deb4e7";
  const projectId = options.projectId ?? engineConfig.projectId ?? null;
  const companyId = env.PAPERCLIP_COMPANY_ID ?? engineConfig.companyId ?? "b15271fe-75c2-4273-b08e-08c41b2101c2";
  const agentWorkspaceRoot = engineConfig.agentWorkspaceRoot ?? "C:\\Code\\bohemia\\office-bohemia-tech-writter";

  return {
    repoRoot,
    agentWorkspaceRoot,
    trees,
    targetsPath,
    todoPath,
    todoJsonPath,
    telemetryPath,
    minSlopScore,
    maxRankedFiles,
    maxOpenTasks,
    assigneeAgentId,
    projectId,
    companyId,
    paths: options.paths ?? null,
    all: Boolean(options.all),
    dispatch: Boolean(options.dispatch),
    dryRun: Boolean(options.dryRun),
  };
}
