#!/usr/bin/env node
/**
 * CLI helper for agents and scripts to mark PR review threads as resolved in Azure DevOps.
 *
 * Resolving a thread is a claim that a commit fixes what it flagged, so this tool only accepts
 * that claim when it can verify it: the caller must name the commit, and that commit must be the
 * pull request's current pushed source commit (checked fresh against Azure DevOps, not against
 * anything the caller believes). An agent that fixed something locally without pushing, or pushed
 * to the wrong branch, gets a refusal and no threads are touched. See lib/resolve-guard.mjs.
 *
 * Usage:
 *   node resolve-thread.mjs <prId> <commitSha> <threadId1> [threadId2...]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCommit, getPullRequest, listThreads, updateThreadStatus } from "./lib/azure-devops.mjs";
import { resolveAnsweredThreads, resolveThreads } from "./lib/resolve-guard.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(path.join(directory, "config.json"), "utf8"));

const [prId, commit, ...threadIds] = process.argv.slice(2);
if (!prId || !commit || threadIds.length === 0) {
  console.error("Usage: node resolve-thread.mjs <prId> <commitSha> <threadId1> [threadId2...]");
  console.error("<commitSha> must be the pull request's current pushed source commit — push before resolving.");
  process.exit(1);
}

const result = commit === "--answer" ? await (async () => {
  const [contractFile, resultFile, ...answeredIds] = threadIds;
  if (!contractFile || !resultFile || !answeredIds.length) {
    throw new Error("Usage: resolve-thread.mjs <prId> --answer <contract.json> <result.json> <threadId...>");
  }
  return resolveAnsweredThreads({
    config, prId, contract: JSON.parse(await readFile(contractFile, "utf8")),
    result: JSON.parse(await readFile(resultFile, "utf8")), threadIds: answeredIds,
    ado: { getPullRequest, listThreads, updateThreadStatus },
  });
})() : await resolveThreads({
  config,
  prId,
  commit,
  threadIds,
  ado: { getPullRequest, getCommit, listThreads, updateThreadStatus },
  log: (message) => console.log(message),
});
console.log(JSON.stringify(result));

// exitCode rather than exit(): forcing an immediate exit here has been observed to abort the
// process while the token/fetch transport still has an async handle open, which crashes on
// Windows rather than reporting the refusal this line exists to report. Setting exitCode lets
// the event loop drain on its own and still fails the calling job.
if (result.refused || result.failed.length > 0) process.exitCode = 1;
