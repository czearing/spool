import { mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";

import { HANDOFF_TRANSITIONS, isRunContextRefusal } from "../../../packages/bohemia-agent-tooling/src/index.js";

import { createQueue } from "./queue.mjs";
import { taskPullRequestId, taskSourceCommit, reviewTasksFromIssues } from "./task-source.mjs";
import { failedReviewRetry, reviewAdmission, reviewPhase, reviewTaskKey } from "./reviewer-status.mjs";
import { deferReview, queuedReviews, retryAttempt, taskBody } from "./work-queue.mjs";
import { prepareReviewWorkspace } from "./workspace.mjs";
import { needsDependencyRepair } from "./dependency-repair.mjs";

/**
 * Delivery.
 *
 * The queue folder is unchanged: the scan still writes one file per review it decided to hand over,
 * atomically, and that file is still what makes a duplicate impossible. What changed is who picks the
 * file up. The previous consumer was a local process that is no longer running, so files accumulated
 * and the reviewer was never told anything, while every scan reported success.
 *
 * So delivery is now part of the runner and it is observable. A file becomes an issue assigned to the
 * reviewer agent, and only then is it moved out of the queue folder. A delivery that fails leaves the
 * file where it is, records a refusal, and is retried on the next scan.
 */

const DELIVERED = "delivered";

export function taskTitle(body) {
  const first = String(body).split("\n", 1)[0].trim();
  return first.length > 0 ? first : "Review Azure DevOps pull request";
}

/**
 * Hand every queued review to the reviewer agent.
 *
 * Returns false when the queue folder was empty, which keeps the caller's existing distinction
 * between a scan that delivered something and a scan that had nothing to deliver.
 */
export async function deliverQueuedWork(config, options = {}) {
  const queue = options.queue || createQueue(config);
  const ledger = options.ledger || null;
  const files = await queuedReviews(config.workFolder);
  if (files.length === 0) return false;

  const archive = path.join(config.workFolder, DELIVERED);
  await mkdir(archive, { recursive: true });
  const failures = [];
  let delivered = false;

  for (const name of files) {
    const file = path.join(config.workFolder, name);
    const body = await readFile(file, "utf8");
    const taskKey = reviewTaskKey(taskPullRequestId(body) || name, taskSourceCommit(body));
    try {
      let description = body;
      const retry = retryAttempt(body);
      if (retry && (!config.repoRoot || typeof queue.retryIssue !== "function")) {
        throw new Error("Review retry requires prepared same-task continuation support");
      }
      if (config.repoRoot) {
        if (!Array.isArray(options.pullRequests) || !Array.isArray(options.admittedPullRequests)
          || typeof options.isReviewerBusy !== "function" || typeof options.isPullRequestCurrent !== "function") {
          throw new Error("Prepared review delivery requires current eligibility and reviewer liveness checks");
        }
        const issues = await queue.listIssues();
        const tasks = reviewTasksFromIssues(issues, config.agentId);
        const current = tasks.get(taskKey);
        const pr = options.pullRequests.find((entry) => reviewTaskKey(entry.id, entry.sourceCommit) === taskKey);
        const eligibleRetry = pr && failedReviewRetry(pr, tasks);
        const retryMatches = retry && eligibleRetry?.retryOf === retry.retryOf
          && eligibleRetry.retryUpdatedAt === retry.retryUpdatedAt;
        if (!pr || (current && !retryMatches) || (retry && !retryMatches)) {
          await mkdir(path.join(config.workFolder, "withdrawn"), { recursive: true });
          await rename(file, path.join(config.workFolder, "withdrawn", name));
          ledger?.append(HANDOFF_TRANSITIONS.CLOSED, {
            taskKey, agent: config.agentName || config.agentId,
            issueId: current?.taskId || null,
            detail: current ? "Review already has a durable issue; not republished" : "Queued revision is no longer eligible",
          });
          continue;
        }
        if (!reviewAdmission(pr, tasks).admitted
          || !options.admittedPullRequests.some((entry) => reviewTaskKey(entry.id, entry.sourceCommit) === taskKey)) continue;
        const busyIssue = issues.some((issue) => issue.assigneeAgentId === config.agentId
          && ["todo", "in_progress", "in_review"].includes(issue.status));
        if (busyIssue || await options.isReviewerBusy()) break;
        let workspace;
        try {
          workspace = await (options.prepareWorkspace || prepareReviewWorkspace)({
            repoRoot: config.repoRoot, prId: pr.id, sourceCommit: pr.sourceCommit,
            ...(retry ? { eventAttempt: retry.retryUpdatedAt } : {}),
            ...(retry && needsDependencyRepair(current?.error) ? { repairDependencies: true } : {}),
          });
        } catch (error) {
          if (error.code === "WORKFLOW_FILTERED") throw error;
          await options.activity?.("workspace_prep_failed", { pr: `${pr.repository}#${pr.id}`, error: error.message });
          throw error;
        }
        if (!workspace?.branch || workspace.repoRoot !== config.repoRoot || workspace.sourceCommit !== pr.sourceCommit) {
          throw new Error("Reviewer preparation did not confirm the requested workspace and source revision");
        }
        await options.activity?.("workspace_prepared", {
          pr: `${pr.repository}#${pr.id}`, branch: workspace.branch, repoRoot: workspace.repoRoot,
        });
        if (await options.isReviewerBusy()) break;
        const latestIssues = await queue.listIssues();
        if (latestIssues.some((issue) => issue.assigneeAgentId === config.agentId
          && ["todo", "in_progress", "in_review"].includes(issue.status))) break;
        if (!await options.isPullRequestCurrent(pr)) {
          await options.activity?.("review_dispatch_deferred", {
            pr: `${pr.repository}#${pr.id}`, reason: "PR revision or eligibility changed during preparation",
          });
          break;
        }
        description = taskBody(pr, { phase: reviewPhase(pr, tasks), transport: config.transport, ...retry }, workspace);
      }
      const payload = {
        title: taskTitle(body),
        description,
        projectId: config.paperclipProjectId || undefined,
        assigneeAgentId: config.agentId,
        priority: config.priority || "medium",
        status: "todo",
      };
      const issue = retry
        ? await queue.retryIssue(retry.retryOf, payload, retry.retryUpdatedAt)
        : await queue.createIssue(payload);
      if (!issue?.id || !["todo", "in_progress", "in_review", "done"].includes(issue.status)) {
        throw new Error("Paperclip did not confirm a durable review issue");
      }
      ledger?.append(HANDOFF_TRANSITIONS.HANDED, {
        taskKey,
        agent: config.agentName || config.agentId,
        issueId: issue?.id || null,
        identifier: issue?.identifier || null,
        title: taskTitle(body),
        detail: name,
      });
      await rename(file, path.join(archive, name));
      delivered = true;
      if (config.repoRoot) break;
    } catch (error) {
      if (error.code === "WORKFLOW_FILTERED") {
        await options.activity?.("event_filtered", { taskKey, reason: error.message }); continue;
      }
      ledger?.append(HANDOFF_TRANSITIONS.REFUSED, {
        taskKey,
        agent: config.agentName || config.agentId,
        title: taskTitle(body),
        detail: error.message,
      });
      failures.push(`${name}: ${error.message}`);
      await deferReview(file);
      if (config.repoRoot) break;
    }
  }

  if (failures.length > 0) {
    throw new Error(`the reviewer was not given ${failures.length} queued review(s): ${failures.join("; ")}`);
  }
  return delivered;
}

/**
 * Withdraw a review that should not happen. The task is cancelled rather than deleted, so the record
 * that it was asked for and called off survives.
 */
export async function cancelReviewTask(config, taskId, options = {}) {
  const queue = options.queue || createQueue(config);
  try {
    const cancelled = await queue.cancelIssue(taskId, options.reason || "The pull request is no longer eligible for review");
    if (cancelled === false) return false;
    options.ledger?.append(HANDOFF_TRANSITIONS.CLOSED, {
      taskKey: options.taskKey || taskId,
      agent: config.agentName || config.agentId,
      issueId: taskId,
      detail: options.reason || "cancelled",
    });
  } catch (error) {
    if (isRunContextRefusal(error)) {
      return false;
    }
    throw error;
  }
}
