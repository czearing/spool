import { paperclipReviewerTasks } from "./task-source.mjs";

/**
 * Read back every review task this runner has handed to the reviewer agent.
 *
 * The transport moved to the live queue when the previous one stopped existing, so this is a thin
 * adapter over an injected source. Every decision made from the returned map is unchanged: the same
 * keys, the same normalized statuses, and the same rule that the newest receipt for a revision wins.
 */
export async function queryReviewerTasks(config, source = paperclipReviewerTasks) {
  return source(config);
}

export function reviewTaskKey(prId, sourceCommit) {
  return `${prId}:${sourceCommit || "unversioned"}`;
}

export function reviewAdmission(pr, tasks) {
  const current = tasks.get(reviewTaskKey(pr.id, pr.sourceCommit));
  if (current) return { admitted: true, reason: null };
  const activeReview = [...tasks].some(([key, task]) => (
    key.startsWith(`${pr.id}:`) && ["waiting", "reviewing"].includes(task.status)
  ));
  if (activeReview) return { admitted: false, reason: "Waiting for the active review to finish" };
  return { admitted: true, reason: null };
}

export function failedReviewRetry(pr, tasks, now = Date.now()) {
  const task = tasks.get(reviewTaskKey(pr.id, pr.sourceCommit));
  const failedAt = Date.parse(task?.updatedAt);
  return task?.status === "blocked" && task.taskId && Number.isFinite(failedAt)
    && now - failedAt >= 60_000
    ? { retryOf: task.taskId, retryUpdatedAt: task.updatedAt } : null;
}

export function continuationEligibility(report, tasks, enabled) {
  if (!enabled) return report;
  const detected = report.detected.map(pr => {
    const task = tasks.get(reviewTaskKey(pr.id, pr.sourceCommit));
    if (!["blocked", "waiting", "reviewing"].includes(task?.status) ||
        !pr.reasons?.length || pr.reasons.some(reason => !/^reviewer vote is -?\d+$/.test(reason))) return pr;
    return { ...pr, eligible: true, reasons: [], preserveExistingVote: true };
  });
  return { ...report, detected, eligible: detected.filter(pr => pr.eligible) };
}

export function queueableReviews(candidates, tasks, { retry = false, now = Date.now() } = {}) {
  return candidates.filter((pr) => {
    const status = tasks.get(reviewTaskKey(pr.id, pr.sourceCommit))?.status;
    if (retry && failedReviewRetry(pr, tasks, now)) return true;
    return !["waiting", "reviewing", "completed", "blocked"].includes(status);
  });
}

export function reviewPhase(pr, tasks) {
  const reviewedEarlierRevision = [...tasks].some(([key, task]) => (
    key.startsWith(`${pr.id}:`)
    && key !== reviewTaskKey(pr.id, pr.sourceCommit)
    && task.status === "completed"
  ));
  return reviewedEarlierRevision ? "revision" : "initial";
}

export function observeReviewRevisions(pullRequests, previous = {}, now = Date.now(), maxGapMs = 180_000) {
  return Object.fromEntries(pullRequests.map((pr) => {
    const old = previous[pr.id];
    const continuous = old?.sourceCommit === pr.sourceCommit
      && Number.isFinite(old.firstSeenAt) && Number.isFinite(old.lastSeenAt)
      && old.firstSeenAt <= old.lastSeenAt && old.lastSeenAt <= now
      && now - old.lastSeenAt <= maxGapMs;
    return [pr.id, {
      sourceCommit: pr.sourceCommit,
      firstSeenAt: continuous ? old.firstSeenAt : now,
      lastSeenAt: now,
    }];
  }));
}

export function revisionAdmission(pr, tasks, observation, now = Date.now(), settleMs = 120_000) {
  const admission = reviewAdmission(pr, tasks);
  if (!admission.admitted || tasks.has(reviewTaskKey(pr.id, pr.sourceCommit))) return admission;
  const hasEarlierRevision = [...tasks.keys()].some((key) => key.startsWith(`${pr.id}:`));
  if (hasEarlierRevision && (!observation || now - observation.firstSeenAt < settleMs)) {
    return { admitted: false, reason: `Waiting for the new source revision to remain stable for ${settleMs / 1000} seconds` };
  }
  return admission;
}
