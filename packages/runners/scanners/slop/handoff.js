/**
 * Handoff and task dispatch module for the slop engine.
 * Hands off prioritized slop cleanup items to the TechWriter agent with a strict max-open-tasks cap (default 2 PRs).
 */

import { slugifyBranchTopic, assertAgentWorkspaceIdle } from "../../packages/bohemia-agent-tooling/src/index.js";
import { reproductionCommand } from "./metrics.js";

/**
 * Renders the markdown task description for the TechWriter issue.
 */
export function renderSlopTask(candidateOrOptions) {
  const candidate = candidateOrOptions.candidate || candidateOrOptions;
  const files = candidate.files || (candidate.path ? [candidate.path] : []);
  const clusterId = candidate.clusterId || candidate.directory || candidate.path || "codebase";
  const reproduction =
    candidateOrOptions.reproduction ||
    candidate.reproduction ||
    reproductionCommand(files);

  const fileSlug = slugifyBranchTopic(clusterId.replace(/\.[a-zA-Z0-9]+$/, "").replace(/\//g, "-"));
  const branchName = candidate.branchName || `user/calebzearing/docs-${fileSlug}`;
  const branchTopic = candidate.branchTopic || `docs-${fileSlug}`;
  const repoRoot = candidateOrOptions.repoRoot || candidate.repoRoot || null;
  const totalSlopLines = candidate.totalSlopLines ?? candidate.slopLines ?? 0;
  const totalSlopComments = candidate.totalSlopComments ?? candidate.slopComments ?? 0;
  const totalCodeLines = candidate.totalCodeLines ?? candidate.codeLines ?? 0;
  const slopDensity = candidate.slopDensity ?? (totalCodeLines > 0 ? totalSlopLines / totalCodeLines : 0);

  const title =
    candidate.title ||
    (files.length === 1
      ? `docs(comments): clean up redundant and verbose comments in ${files[0]}`
      : `docs(comments): clean up redundant and verbose comments in ${clusterId}`);

  const lines = [
    "### Background",
    `Code quality audit identified redundant, verbose, and tautological commentary across ${files.length} file${files.length > 1 ? "s" : ""} in \`${clusterId}\`.`,
    `- Redundant comment lines: ${totalSlopLines} lines across ${totalSlopComments} comment blocks`,
    `- Total file lines: ${totalCodeLines} (comment ratio: ${(slopDensity * 100).toFixed(1)}%)`,
    `- Target files:`,
  ];

  for (const f of files) {
    lines.push(`  - \`${f}\``);
  }

  const repoText = repoRoot ? ` in \`${repoRoot}\`` : "";
  lines.push(
    "",
    `The branch \`${branchName}\` is checked out${repoText} and verified clean. The workspace and dependencies are already set up for you. Do not run git checkout, fetch, reset, or clean; proceed directly to your edits.`,
    "",
    `- Reproduction command: \`${reproduction}\``,
    "",
    "### Findings to Address",
    "",
  );

  const findings = candidate.findings || [];
  for (const item of findings.slice(0, 15)) {
    const fileLabel = item.filePath ? `\`${item.filePath}\` ` : "";
    lines.push(`- ${fileLabel}**Line ${item.startLine}${item.endLine > item.startLine ? `-${item.endLine}` : ""}** (${item.category}):`);
    for (const r of item.reasons || []) lines.push(`  - Reason: ${r}`);
    if (item.targetCodeLine) lines.push(`  - Target code: \`${item.targetCodeLine.slice(0, 80)}\``);
    if (item.snippet) {
      lines.push("  ```ts");
      for (const l of item.snippet.split("\n")) lines.push(`  ${l}`);
      lines.push("  ```");
    }
    lines.push("");
  }

  lines.push(
    "### Acceptance Criteria",
    "- Remove redundant, tautological echo comments, conversational filler, and bloated JSDoc tags across all files in this task.",
    "- Keep function signatures, types, logic, and runtime behavior completely unchanged.",
    `- Re-verify with \`${reproduction}\` to confirm 0 redundant comment overage across all target files.`,
    "- Push via `bohemia push` and create PR using `bohemia_pr` with `action: \"create\"`.",
    "- Write standard, professional engineering PR descriptions and commit messages describing the documentation/comment clarity improvements. Never mention internal automation tools, scripts, paperclip, auto-assign, or audit engines in PR titles, PR bodies, or commit messages.",
    "- Record the pull request URL on this Spool task before completing it.",
  );

  const body = lines.join("\n");

  return {
    title,
    body,
    description: body,
    branchName,
    branchTopic,
  };
}

/**
 * Attempts to dispatch the highest-priority slop task to TechWriter.
 */
export async function dispatchNextSlopTask({
  candidate,
  agentId,
  projectId = null,
  repoRoot,
  maxOpenTasks = 2,
  queue,
  prepare,
  dryRun = false,
}) {
  if (!queue) throw new Error("Slop dispatch requires the runner's queue");

  if (!candidate) {
    return { dispatched: false, reason: "no_candidate" };
  }

  const active = (await queue.listIssues({ assigneeAgentId: agentId }))
    .filter(task => ["todo", "in_progress", "in_review", "blocked"].includes(task.status));
  if (active.length >= maxOpenTasks) {
    return {
      dispatched: false,
      reason: "max_open_tasks_reached",
      activeCount: active.length,
      openTasks: active.length,
      maxOpenTasks,
      activeIssues: active.map((i) => ({ id: i.id, identifier: i.identifier, title: i.title, status: i.status })),
    };
  }

  // Check if candidate already has an active issue
  const files = candidate.files || (candidate.path ? [candidate.path] : []);
  const clusterId = candidate.clusterId || candidate.directory || candidate.path;
  const alreadyQueued = active.find((i) => {
    if (!i.title) return false;
    if (i.title.includes(clusterId)) return true;
    return files.some((f) => i.title.includes(f));
  });

  if (alreadyQueued) {
    return {
      dispatched: false,
      reason: "already_queued",
      activeCount: active.length,
      issueId: alreadyQueued.id,
      identifier: alreadyQueued.identifier,
    };
  }

  // 1. Prepare agent branch in agent workspace
  let branchResult = null;
  const initialTask = renderSlopTask(candidate);
  if (!dryRun && repoRoot) {
    if (active.length) return { dispatched: false, reason: "workspace_owned_by_unfinished_work" };
    if (typeof prepare !== "function") throw new Error("Slop dispatch requires shared runner preparation");
    await assertAgentWorkspaceIdle(queue, agentId);
    branchResult = await prepare({ repoRoot, branch: initialTask.branchTopic, baseBranch: "master" });
    await assertAgentWorkspaceIdle(queue, agentId);
  }
  if (!dryRun && !branchResult?.ready) throw new Error("Slop dispatch requires a prepared agent workspace");

  const effectiveBranch = branchResult?.branch || initialTask.branchName;
  const taskContent = renderSlopTask({
    ...candidate,
    branchName: effectiveBranch,
    repoRoot,
  });

  if (dryRun) {
    return {
      dispatched: true,
      dryRun: true,
      activeCount: active.length,
      branch: taskContent.branchName,
      title: taskContent.title,
      task: taskContent,
      body: taskContent.body,
    };
  }

  const payload = {
    title: taskContent.title,
    description: taskContent.body,
    assigneeAgentId: agentId,
    projectId: projectId || undefined,
    status: "todo",
    priority: "medium",
  };

  const issue = await queue.createIssue(payload);
  return {
    dispatched: true,
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    branch: branchResult?.branch ?? taskContent.branchName,
    status: issue.status,
    activeCount: active.length + 1,
    openTasksAfter: active.length + 1,
    maxOpenTasks,
  };
}
