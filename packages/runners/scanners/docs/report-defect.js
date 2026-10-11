#!/usr/bin/env node
/**
 * The defect channel. One child issue to the owner of the surface that is broken, and nothing else.
 * A defect in this engine goes to its owner. A defect in the shared scaffold goes to the tooling
 * engineer, which is the default here.
 *
 *   node report-defect.js --surface watermark --summary "the diff read the wrong clone"
 */

import { pathToFileURL } from "node:url";
import { createMemoryQueue, writeDefectIssue } from "../../packages/bohemia-agent-tooling/src/index.js";
import { loadEngineConfig } from "./config.js";

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--surface") options.surface = argv[++index];
    else if (arg === "--summary") options.summary = argv[++index];
    else if (arg === "--detail") options.detailPath = argv[++index];
    else if (arg === "--owner") options.ownerAgentId = argv[++index];
    else if (arg === "--parent") options.parentIssueId = argv[++index];
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.summary) throw new Error("a defect needs a summary");
  if (!options.surface) throw new Error("a defect needs the surface it is on");
  return options;
}

export async function reportDefect({ options, engineConfig = loadEngineConfig(), queue: suppliedQueue }) {
  const queue = options.dryRun
    ? createMemoryQueue()
    : suppliedQueue;
  if (!queue) throw new Error("Report scanner defects through the Spool runner queue");

  return writeDefectIssue({
    queue,
    defect: {
      tool: engineConfig.tool,
      surface: options.surface,
      summary: options.summary,
      detailPath: options.detailPath,
    },
    ownerAgentId: options.ownerAgentId ?? engineConfig.defectOwnerAgentId,
    parentIssueId: options.parentIssueId ?? engineConfig.parentIssueId ?? undefined,
    bodyBudget: engineConfig.bodyBudget,
    titleBudget: engineConfig.titleBudget,
  });
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  try {
    const created = await reportDefect({ options: parseArgs(process.argv.slice(2)) });
    process.stdout.write(`${JSON.stringify({ issueId: created.id, identifier: created.identifier ?? null }, null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error.message }, null, 2)}\n`);
    process.exit(1);
  }
}
