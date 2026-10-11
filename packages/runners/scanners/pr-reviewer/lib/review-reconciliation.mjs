import { reviewTaskKey } from "./reviewer-status.mjs";

// A queued review may be withdrawn, but an in-flight one must never be killed. Cancelling a `reviewing`
// task aborts the agent's turn mid-tool-call, which strands the side effects it already performed on the
// PR (votes, comments) and destroys the Discord notification it was sending. A running review costs one
// short turn to finish and report; a killed one loses the result entirely.
const CANCELLABLE = ["waiting"];

export async function cancelIneligibleReviews(config, detected, reviewTasks, cancelTask) {
  const states = new Map();
  for (const pr of detected) {
    if (pr.eligible) continue;
    const key = reviewTaskKey(pr.id, pr.sourceCommit);
    const task = reviewTasks.get(key);
    if (!task) continue;
    if (task.status === "cancelled") {
      states.set(key, "cancelled");
      continue;
    }
    if (!CANCELLABLE.includes(task.status)) continue;
    await cancelTask(config, task.taskId);
    states.set(key, "cancelled_now");
  }
  return states;
}

export async function cancelStaleRevisionReviews(config, detected, reviewTasks, cancelTask) {
  const currentRevisions = new Map(detected.map((pr) => [String(pr.id), pr.sourceCommit]));
  const states = new Map();
  for (const [key, task] of reviewTasks) {
    const separator = key.indexOf(":");
    const prId = key.slice(0, separator);
    const sourceCommit = key.slice(separator + 1);
    const currentCommit = currentRevisions.get(prId);
    if (!currentCommit || sourceCommit === currentCommit) continue;
    if (!CANCELLABLE.includes(task.status)) continue;
    await cancelTask(config, task.taskId);
    states.set(key, "cancelled_now");
  }
  return states;
}

export async function cancelRemovedReviewerAssignments(config, removedPrIds, reviewTasks, cancelTask) {
  const removed = new Set(removedPrIds.map(String));
  const states = new Map();
  for (const [key, task] of reviewTasks) {
    const prId = key.slice(0, key.indexOf(":"));
    if (!removed.has(prId) || !CANCELLABLE.includes(task.status)) continue;
    await cancelTask(config, task.taskId);
    states.set(key, "cancelled_now");
  }
  return states;
}
