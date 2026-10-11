import { reviewTaskKey } from "./reviewer-status.mjs";
import { createQueue } from "./queue.mjs";

/**
 * Where the runner reads its own history back from.
 *
 * The previous source was a local process that no longer runs, and a source that cannot answer is
 * indistinguishable from a reviewer that has never been given anything: every scan then looks like a
 * first scan, and the same pull request is handed over again on every pass. So the source is now the
 * live queue, which is the same place the work is written to.
 *
 * The shape returned here is the contract the review policy is written against and is unchanged: a
 * map from `prId:sourceCommit` to a receipt carrying a status, a task id and a submission time.
 */

const TITLE_PREFIX = "Review Azure DevOps pull request #";

/** Statuses a task can be in, expressed in the vocabulary the review policy already speaks. */
export function normalizeStatus(status) {
  if (status === "done") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "in_progress" || status === "in_review") return "reviewing";
  if (status === "blocked" || status === "failed") return "blocked";
  return "waiting";
}

/** Read the pull request number out of a task without a regular expression. */
export function taskPullRequestId(text) {
  const line = String(text || "").split("\n", 1)[0].trim();
  if (!line.toLowerCase().startsWith(TITLE_PREFIX.toLowerCase())) return null;
  const rest = line.slice(TITLE_PREFIX.length);
  const separator = rest.indexOf(":");
  const digits = separator === -1 ? rest : rest.slice(0, separator);
  const id = digits.trim();
  if (id.length === 0) return null;
  for (const character of id) {
    if (character < "0" || character > "9") return null;
  }
  return id;
}

/** Read the source commit a task was written for, so a superseded revision is never confused. */
export function taskSourceCommit(text) {
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith("source commit:")) continue;
    const value = trimmed.slice("source commit:".length).trim();
    if (value.length > 0) return value;
  }
  return "unversioned";
}

function isNewer(candidate, existing) {
  if (!candidate) return !existing;
  if (!existing) return true;
  return Date.parse(candidate) >= Date.parse(existing);
}

/**
 * Reduce queue issues to review receipts. Pure, so every status decision is testable without a
 * network, which is what the previous transport made impossible.
 */
export function reviewTasksFromIssues(issues, agentId) {
  const tasks = new Map();
  for (const issue of issues || []) {
    if (issue?.assigneeAgentId !== agentId) continue;
    const text = [issue.title, issue.description].filter(Boolean).join("\n");
    const prId = taskPullRequestId(text);
    if (!prId) continue;
    const key = reviewTaskKey(prId, taskSourceCommit(issue.description));
    const receipt = {
      status: normalizeStatus(issue.status),
      taskId: issue.id,
      identifier: issue.identifier || null,
      submittedAt: issue.createdAt || null,
      updatedAt: issue.updatedAt || issue.createdAt || null,
      ...(issue.error ? { error: issue.error } : {}),
    };
    const existing = tasks.get(key);
    if (!existing || isNewer(receipt.submittedAt, existing.submittedAt)) tasks.set(key, receipt);
  }
  return tasks;
}

/**
 * A task whose description was shortened for the collection view cannot be read for its revision, so
 * the full record is fetched. This is the only place a per issue read happens, and only for the few
 * that need it.
 */
async function withFullDescriptions(queue, issues, agentId) {
  const filled = [];
  for (const issue of issues) {
    if (issue?.assigneeAgentId !== agentId) continue;
    if (!taskPullRequestId([issue.title, issue.description].filter(Boolean).join("\n"))) continue;
    if (issue.descriptionTruncated !== true) {
      filled.push(issue);
      continue;
    }
    const full = await queue.getIssue(issue.id);
    filled.push(full ? { ...issue, ...full } : issue);
  }
  return filled;
}

export async function paperclipReviewerTasks(config, queue = createQueue(config)) {
  const issues = await queue.listIssues();
  return reviewTasksFromIssues(await withFullDescriptions(queue, issues, config.agentId), config.agentId);
}
