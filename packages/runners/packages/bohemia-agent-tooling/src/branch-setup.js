/**
 * Abstracted branch and workspace setup utility for Paperclip agents.
 *
 * Prepares a clean repository workspace and branch before an agent is woken,
 * ensuring agents never run manual git checkout, pull, or branch management themselves.
 */

import { callBohemia } from "../../bohemia-pr-mcp/src/client.mjs";

/**
 * Normalizes a topic string into a safe, valid git branch slug.
 */
export function slugifyBranchTopic(topic) {
  if (!topic) return "task-work";
  return String(topic)
    .toLowerCase()
    .replace(/[^a-z0-9_\-\/]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

/**
 * Formats a topic into the standard user branch format (user/<username>/<slug>).
 */
export function formatAgentBranch(topic, user = "calebzearing") {
  const slug = slugifyBranchTopic(topic);
  if (slug.startsWith(`user/${user}/`)) return slug;
  if (slug.startsWith("user/")) return slug;
  return `user/${user}/${slug}`;
}

/**
 * Prepares a clean branch and workspace for an agent.
 */
export async function setupAgentBranch({
  repoRoot,
  branch,
  baseBranch = "master",
  user = "calebzearing",
  runSetup = true,
  runBuild = true,
  sourceCommit,
  mode = sourceCommit ? "checkout" : "create",
  reset = false,
  call = callBohemia,
}) {
  if (!repoRoot) throw new Error("setupAgentBranch requires repoRoot");
  if (!branch) throw new Error("setupAgentBranch requires branch or topic");

  const fullBranch = formatAgentBranch(branch, user);
  const result = await call("bohemia_prepare", {
    repoRoot, operation: "branch", branch: fullBranch, baseBranch, mode, reset, runSetup, runBuild,
    ...(sourceCommit ? { sourceCommit, mergeMaster: false } : {}),
  });
  if (!result?.ready || result.branch !== fullBranch || !result.commit) throw new Error("Bohemia did not confirm the requested agent branch");
  if (sourceCommit && result.commit.toLowerCase() !== sourceCommit.toLowerCase()) {
    throw new Error("Bohemia did not confirm the requested source revision");
  }
  return result;
}
