/**
 * Acceptance check. Reads the result channel: the issue status and the after number recorded on it.
 * No status report exists and none is asked for.
 */

const AFTER_PATTERN = /^\s*after:\s*(-?\d+(?:\.\d+)?)\s*$/im;
const CLOSED_STATUSES = new Set(["done", "cancelled", "failed"]);

export function readAfterNumber(sources) {
  const texts = Array.isArray(sources) ? sources : [sources];
  for (const text of texts) {
    if (typeof text !== "string") continue;
    const match = text.match(AFTER_PATTERN);
    if (match) return Number(match[1]);
  }
  return null;
}

export function checkAcceptance(task, issue, comments = []) {
  if (!issue) {
    return { issueId: task.issueId, transition: "missing", verdict: "unknown", after: null };
  }

  const status = issue.status;
  const after = readAfterNumber([issue.description, ...comments.map((comment) => comment?.body)]);

  if (!CLOSED_STATUSES.has(status)) {
    return { issueId: task.issueId, transition: "open", verdict: "pending", status, after };
  }

  if (status === "cancelled") {
    return { issueId: task.issueId, transition: "closed", verdict: "cancelled", status, after };
  }
  if (status === "failed") {
    return { issueId: task.issueId, transition: "closed", verdict: "failed", status, after };
  }

  if (after === null) {
    return { issueId: task.issueId, transition: "closed", verdict: "no_after_number", status, after: null };
  }

  const direction = task.direction ?? "lower_is_better";
  const met = direction === "higher_is_better" ? after >= task.acceptance : after <= task.acceptance;
  return {
    issueId: task.issueId,
    transition: "closed",
    verdict: met ? "met" : "not_met",
    status,
    after,
    acceptance: task.acceptance,
    delta: task.current === undefined ? null : after - task.current,
  };
}
