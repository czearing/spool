import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHandoffLedger, runManagedRunner } from "../../packages/bohemia-agent-tooling/src/index.js";

import { createActivityLog } from "./lib/activity-log.mjs";
import { observationChanges, scanActivityDecision } from "./lib/activity-policy.mjs";
import { applyReviewerAssignmentPolicy } from "./lib/assignment-policy.mjs";
import { assignmentKey } from "./lib/assignments.mjs";
import { scanAssignedPullRequests } from "./lib/azure-devops.mjs";
import { readAdoMetrics } from "../lib/ado-transport.mjs";
import { cancelReviewTask, deliverQueuedWork } from "./lib/delivery.mjs";
import { createQueue, reviewerIsBusy } from "./lib/queue.mjs";
import {
  cancelIneligibleReviews,
  cancelRemovedReviewerAssignments,
  cancelStaleRevisionReviews,
} from "./lib/review-reconciliation.mjs";
import {
  queryReviewerTasks,
  queueableReviews,
  observeReviewRevisions,
  revisionAdmission,
  reviewPhase,
  reviewTaskKey,
  failedReviewRetry,
  continuationEligibility,
} from "./lib/reviewer-status.mjs";
import { readState, writeJsonAtomic } from "./lib/state.mjs";
import { enqueueReview, taskFileName } from "./lib/work-queue.mjs";

export async function runReviewer(entryUrl, options = {}) {
return runManagedRunner(entryUrl, async lifecycle => {
  options.onLifecycle?.(lifecycle);
  const { directory, runtime } = lifecycle;
  const config = options.config || JSON.parse(await readFile(path.join(directory, "config.json"), "utf8"));
  const revisionSettleSeconds = config.revisionSettleSeconds ?? 120;
  if (!Number.isFinite(revisionSettleSeconds) || revisionSettleSeconds < 0) {
    throw new Error("revisionSettleSeconds must be a non-negative number");
  }
  const stateFile = path.join(runtime, "state.json");
  const once = options.once ?? process.argv.includes("--once");
  const activity = createActivityLog(runtime);
  const ledger = createHandoffLedger({ path: path.join(runtime, "handoffs.jsonl"), tool: "pr-reviewer" });
  let lastStatus = {};
  let observedPullRequests = {};
  let lastScanActivitySignature = null;
  let lastScanActivityAt = 0;
  let scanFailurePendingRecovery = false;

  // The queue is opened once, at startup, so a runner without credentials stops here rather than
  // polling for hours and reporting success while nothing is ever given to the reviewer.
  const queue = options.queue || createQueue(config);
  const scanPullRequests = options.scanAssignedPullRequests || scanAssignedPullRequests;
  const cancelTask = (runnerConfig, taskId) => cancelReviewTask(runnerConfig, taskId, { queue, ledger });

  await activity("runner_started", {
    pid: process.pid,
    reviewer: config.reviewer,
    agent: config.agentName || config.agentId,
    pollSeconds: config.pollSeconds,
    maxAgeDays: config.maxAgeDays,
  });

  await lifecycle.poll({
    scan: options.wrapScan ? () => options.wrapScan(scan) : scan,
    once, intervalMs: config.pollSeconds * 1000,
    async onError(error) {
      scanFailurePendingRecovery = true;
      await activity("scan_failed", { error: error.message });
      try {
        await writeStatus({ lastError: error.message });
      } catch (statusError) {
        await activity("status_write_failed", { error: statusError.message });
      }
    },
  });

  await activity("runner_stopped", { pid: process.pid });

  async function scan() {
    await queue.recoverPendingRetries?.();
    const state = await readState(stateFile);
    const scanned = await scanPullRequests(config);
    const reviewTasks = await queryReviewerTasks(config, options.taskSource);
    const retryEnabled = config.transport === "spool";
    const report = continuationEligibility(applyReviewerAssignmentPolicy(scanned.detected, state), reviewTasks, retryEnabled);
    const observations = observationChanges(observedPullRequests, report.detected);
    observedPullRequests = observations.current;
    for (const pr of observations.changed) {
      await activity("pr_detected", {
        pr: `${pr.repository}#${pr.id}`,
        title: pr.title,
        eligible: pr.eligible,
        sourceCommit: pr.sourceCommit,
        reason: pr.eligible ? "pending review" : pr.reasons.join(", "),
      });
    }
    const removedStates = await cancelRemovedReviewerAssignments(
      config,
      report.removedReviewerAssignments,
      reviewTasks,
      cancelTask,
    );
    for (const [key] of removedStates) {
      await activity("pr_review_cancelled", {
        pr: key,
        taskId: reviewTasks.get(key)?.taskId,
        reason: "reviewer assignment was removed or PR closed",
      });
    }
    const staleStates = await cancelStaleRevisionReviews(
      config,
      report.detected,
      reviewTasks,
      cancelTask,
    );
    for (const [key] of staleStates) {
      await activity("pr_review_cancelled", {
        pr: key,
        taskId: reviewTasks.get(key)?.taskId,
        reason: "source revision was replaced",
      });
    }
    const observedAt = Date.now();
    const revisionObservations = observeReviewRevisions(
      report.eligible, state.revisionObservations, observedAt,
      Math.max(config.pollSeconds * 3_000, revisionSettleSeconds * 2_000),
    );
    const admissions = new Map(report.eligible.map((pr) => [
      reviewTaskKey(pr.id, pr.sourceCommit),
      revisionAdmission(pr, reviewTasks, revisionObservations[pr.id], observedAt, revisionSettleSeconds * 1000),
    ]));
    const assigned = report.eligible.filter((pr) => admissions.get(reviewTaskKey(pr.id, pr.sourceCommit)).admitted);
    const cancellationStates = await cancelIneligibleReviews(
      config,
      report.detected,
      reviewTasks,
      cancelTask,
    );
    for (const pr of report.detected) {
      const taskKey = reviewTaskKey(pr.id, pr.sourceCommit);
      if (cancellationStates.get(taskKey) !== "cancelled_now") continue;
      await activity("pr_review_cancelled", {
        pr: `${pr.repository}#${pr.id}`,
        taskId: reviewTasks.get(taskKey)?.taskId,
        reason: pr.reasons.join(", "),
      });
    }
    const additions = queueableReviews(assigned, reviewTasks, { retry: retryEnabled });
    const queueStates = new Map();
    for (const pr of additions) {
      const attempt = {
        phase: reviewPhase(pr, reviewTasks),
        transport: config.transport,
        ...(retryEnabled ? failedReviewRetry(pr, reviewTasks) : null),
      };
      const created = await enqueueReview(config.workFolder, pr, attempt);
      queueStates.set(assignmentKey(pr), created ? "queued_now" : "already_queued");
      await activity(created ? "pr_queued" : "pr_already_queued", {
        pr: `${pr.repository}#${pr.id}`,
        file: path.join(config.workFolder, taskFileName(pr, attempt)),
      });
    }
    const active = assigned.map(assignmentKey).sort();
    await writeJsonAtomic(stateFile, {
      active,
      reviewerAssignments: report.reviewerAssignments,
      ageExemptReviewerAssignments: report.ageExemptReviewerAssignments,
      revisionObservations,
      updatedAt: new Date().toISOString(),
    });
    const delivered = await deliverQueuedWork(config, {
      queue, ledger, activity,
      prepareWorkspace: options.prepareWorkspace,
      pullRequests: report.eligible,
      admittedPullRequests: assigned,
      isReviewerBusy: () => options.isBusy ? options.isBusy() : reviewerIsBusy(config),
      isPullRequestCurrent: async (pr) => {
        const fresh = await scanPullRequests(config, { fresh: true });
        const current = continuationEligibility(applyReviewerAssignmentPolicy(fresh.detected, {
          reviewerAssignments: report.reviewerAssignments,
          ageExemptReviewerAssignments: report.ageExemptReviewerAssignments,
        }), await queryReviewerTasks(config, options.taskSource), retryEnabled);
        return current.eligible.some((entry) => entry.id === pr.id && entry.sourceCommit === pr.sourceCommit);
      },
    });
    if (delivered || additions.length > 0) {
      await activity(delivered ? "reviews_delivered" : "delivery_deferred", {
        newAssignments: additions.length,
      });
    }
    const nextScan = new Date(Date.now() + config.pollSeconds * 1000).toISOString();
    const pullRequests = report.detected.map((pr) => {
      const taskKey = reviewTaskKey(pr.id, pr.sourceCommit);
      const task = reviewTasks.get(taskKey);
      const admission = admissions.get(taskKey);
      const queueState = pr.eligible && admission?.admitted
        ? queueStates.get(assignmentKey(pr)) || task?.status || "submitted"
        : cancellationStates.get(taskKey) || (pr.eligible ? "waiting_for_admission" : "ignored");
      return {
        id: pr.id,
        repository: pr.repository,
        title: pr.title,
        url: pr.url,
        sourceCommit: pr.sourceCommit,
        eligible: pr.eligible,
        queueState,
        taskId: task?.taskId || null,
        identifier: task?.identifier || null,
        reason: queueReason(queueState, admission?.reason ? [admission.reason] : pr.reasons),
      };
    });
    const queuedNow = pullRequests.filter((pr) => pr.queueState === "queued_now").length;
    const completed = pullRequests.filter((pr) => pr.queueState === "completed").length;
    const reviewing = pullRequests.filter((pr) => pr.queueState === "reviewing").length;
    const waiting = assigned.length - queuedNow - completed - reviewing;
    const waitingForAdmission = pullRequests.filter((pr) => pr.queueState === "waiting_for_admission").length;
    await writeStatus({
      detected: report.detected.length,
      assigned: assigned.length,
      queued: queuedNow,
      tracked: waiting + waitingForAdmission,
      reviewing,
      completed,
      waitingForCi: 0,
      waitingForAdmission,
      ignored: report.detected.filter((pr) => !pr.eligible).length,
      delivered,
      agent: config.agentName || config.agentId,
      nextScan,
      pollSeconds: config.pollSeconds,
      pullRequests,
      lastError: null,
    });
    const scanSummary = {
      detected: report.detected.length,
      eligible: assigned.length,
      newAssignments: queuedNow,
      reviewing,
      completed,
    };
    const decision = scanActivityDecision(
      lastScanActivitySignature,
      lastScanActivityAt,
      scanSummary,
      Date.now(),
      600_000,
      scanFailurePendingRecovery,
    );
    lastScanActivitySignature = decision.signature;
    lastScanActivityAt = decision.lastLoggedAt;
    if (decision.log) {
      await activity("scan_completed", { ...scanSummary, nextScan });
    }
    scanFailurePendingRecovery = false;
  }

  function queueReason(queueState, reasons) {
    if (queueState === "queued_now") return "Added to the pr-reviewer work queue on this scan";
    if (queueState === "already_queued") return "Work was already waiting; no duplicate was added";
    if (queueState === "waiting") return "Waiting for the PR Reviewer to claim the task";
    if (queueState === "reviewing") return "The PR Reviewer is working on this task";
    if (queueState === "completed") return "The queue confirms the review task completed";
    if (queueState === "blocked") return "Review failed; retry waits for idle ownership and repairs dependency blockers before resuming";
    if (queueState === "waiting_for_admission") return reasons.join(", ");
    if (queueState === "cancelled_now") return "Cancelled because the PR is no longer eligible";
    if (queueState === "cancelled") return "Review work was cancelled after the PR became ineligible";
    if (queueState === "submitted") return "Sent earlier; waiting for a queue status receipt";
    return reasons.join(", ");
  }

  async function writeStatus(update) {
    lastStatus = {
      ...lastStatus,
      pid: process.pid,
      lastScan: new Date().toISOString(),
      ado: await readAdoMetrics().catch((error) => ({ error: error.message })),
      ...update,
    };
    lifecycle.publish(lastStatus);
  }

});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runReviewer(import.meta.url);
}
