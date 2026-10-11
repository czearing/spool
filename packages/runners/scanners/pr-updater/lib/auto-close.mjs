/**
 * Close the automated threads that are holding a finished pull request open.
 *
 * The branch policy on master requires every comment to be resolved, so once two reviewers have
 * approved and every person has been answered, the only thing left between the pull request and
 * the merge button is a stack of pipeline chatter that nobody will ever close by hand.
 *
 * The preconditions are strict and all of them are required, because this writes to somebody
 * else's review surface. Two approvals mean the change was genuinely looked at; zero unresolved
 * human threads mean nobody is still waiting; and only threads with positive automation evidence
 * are touched, since anything unclassified is treated as a person.
 *
 * No regular expressions are used.
 */
import { classifyThreads } from "./authorship.mjs";
import { approvalSummary } from "./merge-readiness.mjs";

/** Approvals required before automated chatter is cleared away. */
export const REQUIRED_APPROVALS = 2;

/**
 * Decide what, if anything, should be closed on one pull request.
 *
 * Returns the reason it declined as well as the threads it would close, so a pull request that
 * stays open can be explained from the dashboard without reading this file.
 */
export function autoCloseTargets({ pr, threads, approvals, options = {} }) {
  const required = options.requiredApprovals ?? REQUIRED_APPROVALS;
  const { human, automated } = classifyThreads(threads, options);

  if (approvals < required) {
    return { close: [], reason: `${approvals} of ${required} approvals` };
  }
  if (human.length > 0) {
    return { close: [], reason: `${human.length} unresolved human thread(s)` };
  }
  if (automated.length === 0) {
    return { close: [], reason: "no automated threads to close" };
  }
  return {
    close: automated.map((entry) => ({ threadId: entry.thread.id, reason: entry.reason })),
    reason: `${automated.length} automated thread(s) with ${approvals} approvals and no human feedback outstanding`,
  };
}

/**
 * Apply the decision.
 *
 * Each closure is logged individually with the evidence that justified it. A thread closed with no
 * recorded reason is indistinguishable from a thread closed by mistake, and this runs unattended.
 */
export async function closeAutomatedThreads({ config, pr, threads, approvals, ado, log = async () => {}, options = {} }) {
  let decision = autoCloseTargets({ pr, threads, approvals, options });
  if (decision.close.length === 0) return { closed: 0, reason: decision.reason };
  if (ado.getPullRequest) {
    pr = await ado.getPullRequest(config, pr.id);
    approvals = approvalSummary(pr).approvals;
    decision = autoCloseTargets({ pr, threads, approvals, options });
    if (decision.close.length === 0) return { closed: 0, reason: decision.reason };
  }
  // Cached survey evidence must not close a thread after fresh human feedback arrived.
  if (ado.listThreads) {
    const fresh = await ado.listThreads(config, pr.id, { fresh: true });
    decision = autoCloseTargets({ pr, threads: fresh, approvals, options });
  }

  let closed = 0;
  for (const target of decision.close) {
    try {
      await ado.updateThreadStatus(config, pr.id, target.threadId, "closed");
      closed += 1;
      await log("thread_closed", { pr: pr.id, thread: target.threadId, why: target.reason });
    } catch (error) {
      await log("thread_close_failed", { pr: pr.id, thread: target.threadId, error: String(error.message || error) });
    }
  }
  return { closed, reason: decision.reason };
}
