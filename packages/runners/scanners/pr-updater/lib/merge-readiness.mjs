/**
 * Whether a pull request is actually ready to merge, and what its gate is doing.
 *
 * Separate from the trigger logic on purpose: triggers answer "does this need an agent", which is
 * a different question from "can this land". A pull request with nothing outstanding is not the
 * same as one that is ready, and conflating them would report a pull request as finished while its
 * gate was still running.
 *
 * No regular expressions are used.
 */

/** Policy outcomes that mean the gate reached a verdict and the verdict was bad. */
const FAILED = ["failed", "canceled"];

/** Policy outcomes that mean the gate is satisfied. */
const PASSED = ["succeeded", "approved"];

/**
 * Reduce the build policies to a line a person can read at a glance.
 *
 * Failing builds are named because that is the only part anyone acts on; passing ones are counted,
 * because their names carry no information once they are green.
 */
export function buildSummary(builds) {
  const rows = builds || [];
  const infrastructure = rows.filter(build => build.failureKind === "infrastructure");
  const failed = rows.filter((build) => FAILED.includes(String(build.result || "")) && build.failureKind !== "infrastructure");
  const passed = rows.filter((build) => PASSED.includes(String(build.result || "")));
  const running = rows.filter(
    (build) => !FAILED.includes(String(build.result || "")) && !PASSED.includes(String(build.result || "")),
  );

  let state = "none";
  if (rows.length === 0) state = "none";
  else if (failed.length > 0) state = "failed";
  else if (infrastructure.length > 0) state = "blocked";
  else if (running.length > 0) state = "running";
  else state = "passed";

  return {
    state,
    total: rows.length,
    passed: passed.length,
    failed: failed.length,
    blocked: infrastructure.length,
    running: running.length,
    failing: failed.map((build) => build.name || String(build.id)),
    label: state === "blocked" ? `CI infrastructure blocked: ${infrastructure.map(build => build.name || String(build.id)).join(", ")}`
      : label(state, rows.length, passed.length, failed.map((build) => build.name || String(build.id))),
  };
}

function label(state, total, passed, failing) {
  if (state === "none") return "no builds";
  if (state === "failed") return `failing: ${failing.join(", ")}`;
  if (state === "running") return `${passed}/${total} passed, rest running`;
  return `${passed}/${total} passed`;
}

/**
 * Who has signed off, and who is blocking.
 *
 * Vote values are Azure DevOps' own: 10 approved, 5 approved with suggestions, 0 no vote yet,
 * -5 waiting for the author, -10 rejected. Both positive values count as an approval because the
 * branch policy counts them the same way; the distinction is advice, not a gate.
 */
export function approvalSummary(pr) {
  const allReviewers = pr?.reviewers || [];
  const reviewers = allReviewers.filter((reviewer) => reviewer.isContainer !== true);
  const totalCount = reviewers.length > 0 ? reviewers.length : allReviewers.length;
  const votes = reviewers.length > 0 ? reviewers.map((reviewer) => reviewer.vote) : pr?.votes || [];
  const approvals = votes.filter((vote) => vote >= 5).length;
  const rejections = votes.filter((vote) => vote <= -5).length;
  return {
    approvals,
    rejections,
    reviewers: totalCount,
    approvers: reviewers.filter((reviewer) => reviewer.vote >= 5).map((reviewer) => reviewer.displayName || reviewer.uniqueName),
    label: rejections > 0 ? `${approvals} approved, ${rejections} blocking` : String(approvals),
  };
}

/**
 * Whether nothing stands between this pull request and the merge button.
 *
 * Deliberately strict. A pull request with no builds at all is not ready, because an absent gate
 * means the policies have not been evaluated yet rather than that they passed, and reporting that
 * as ready would be the one mistake worth catching here. An approval is required for the same
 * reason: a green build says the code compiles, not that anyone has agreed to take it.
 */
export function readyToMerge({ pr, builds, verdict }) {
  if (verdict) return false;
  if (String(pr?.mergeStatus || "") !== "succeeded") return false;
  if (pr?.isDraft) return false;
  const votes = pr?.votes || [];
  if (votes.some((vote) => vote < 0)) return false;
  if (!votes.some((vote) => vote > 0)) return false;
  return buildSummary(builds).state === "passed";
}
