/**
 * Reading a pull request's build gate: which failures are the pipeline's and which are the code's.
 *
 * Split from the trigger logic because it answers a different question. Triggers decide whether to
 * spend an agent turn; this decides whether a red gate is even evidence of anything. Getting it
 * wrong cost a live pull request several hours: an obvious lint break was assumed transient,
 * requeued repeatedly, and never escalated to anyone.
 *
 * No regular expressions are used.
 */

/** Build outcomes that mean the pipeline reached a verdict and the verdict was bad. */
export const FAILED = ["failed", "canceled"];

export function infrastructureFailure(build, records) {
  if (build.status !== "completed" || build.result !== "canceled") return null;
  if (!Array.isArray(records)) throw new Error("Invalid build timeline");
  if (records.some(record => record.result === "failed")) return null;
  const canceled = records.filter(record => record.type === "Job" && record.result === "canceled");
  if (!canceled.length || canceled.some(record => record.startTime)) return null;
  const errors = records.flatMap(record => (record.issues || [])
    .filter(issue => issue.type === "error").map(issue => String(issue.message || "")));
  if (!errors.length || errors.some(message => !message.includes("Remote machine provider issue:") ||
      !message.includes("The agent did not connect"))) return null;
  return [...new Set(errors)].join(" ");
}

/**
 * Whether a gate needs attention of any kind.
 *
 * An expired evaluation counts even though its status is still `queued`. Azure DevOps leaves the
 * overnight expiry in that state, and reading only the result skipped it entirely: the nightly
 * requeue never fired because the build did not look failed. Observed live on three gates at once.
 */
export function needsAttention(build) {
  return FAILED.includes(String(build?.result || "")) || build?.timedOut === true;
}

/**
 * Which policies are failing across more than one pull request right now.
 *
 * This is the only honest transient signal available. A failure is worth retrying when the same
 * gate is red on unrelated branches, because that is the pipeline being broken rather than the
 * code. Anything red on one branch alone is that branch's problem, and retrying it merely delays
 * the fix by a full pipeline run.
 *
 * Expired builds are excluded: they say something about the clock, not about the code, and
 * counting them would make an idle night look like a broken pipeline.
 */
export function transientPolicies(buildsByPr) {
  const seen = new Map();
  for (const builds of Object.values(buildsByPr || {})) {
    const names = new Set();
    for (const build of builds || []) {
      if (build.failureKind !== "unavailable" && FAILED.includes(String(build?.result || ""))) names.add(build.name || String(build.id));
    }
    for (const name of names) seen.set(name, (seen.get(name) || 0) + 1);
  }
  return new Set([...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name));
}

/** The policy identity, which survives a requeue. The build id does not. */
export function policyKey(build) {
  return String(build?.evaluationId || build?.name || build?.id || "");
}

/**
 * Split the gates needing attention into the ones to retry and the ones to escalate.
 *
 * `retried` maps a policy to the build id already requeued on this revision, keyed on the policy
 * rather than the build because a requeue produces a new build with a new id. Keying on the build
 * id was a live bug: every retry looked like a first sighting, so a deterministic failure was
 * requeued forever and never reached an agent.
 *
 * A failure escalates immediately unless there is a specific reason to think it is not about this
 * branch: the build expired, or the same gate is red elsewhere. Assuming transience by default is
 * what let an obvious lint break sit unaddressed through several pipeline runs.
 *
 * An expired gate is the one case the ledger does not govern. It is requeued however many times it
 * expires, because a build that never ran cannot become attributable by being seen twice.
 */
export function classifyFailures(builds, options = {}) {
  const retried = options.retried || {};
  const transient = options.transientNames || new Set();
  const requeue = [];
  const escalate = [];

  for (const build of builds || []) {
    if (build.failureKind === "unavailable") continue;
    if (!needsAttention(build)) continue;
    const previous = retried[policyKey(build)];
    if (build.failureKind === "infrastructure") {
      if (previous === undefined) requeue.push(build);
      continue;
    }

    /*
     * An expiry is never evidence about the branch: the gate ran out of clock before it reached a
     * verdict, so there is nothing for an agent to fix and the only useful answer is another run.
     * This is checked before the retry ledger because that ledger assumes a verdict: it escalates
     * the second sighting of a policy, which turned a pull request whose gates expired twice into
     * agent work against a build that had never actually failed. The one case still skipped is a
     * requeue whose new build has not appeared yet, seen as the same id, which would otherwise be
     * requeued again every pass.
     */
    if (build.timedOut === true) {
      if (previous !== build.id) requeue.push(build);
      continue;
    }

    if (previous !== undefined) {
      // Already retried on this revision. A different build id means the retry ran and failed
      // again, which is attributable. The same id means the new build has not appeared yet.
      if (previous !== build.id) escalate.push(build);
      continue;
    }

    if (transient.has(build.name || String(build.id))) requeue.push(build);
    else escalate.push(build);
  }
  return { requeue, escalate };
}
