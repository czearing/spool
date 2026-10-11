/**
 * Guard against resolving a review thread that no pushed commit actually addresses.
 *
 * Marking a thread "fixed" is a promise to a reviewer that the flagged code changed. That promise
 * is worthless if it is not backed by a commit that is actually live on the pull request: local,
 * uncommitted, or unpushed work leaves the review surface saying "resolved" while the branch a
 * reviewer diffs still has the original bug. Observed live on PR 5678017 (office-bohemia): an
 * agent implemented a fix, never pushed it ("preserved unstaged... no push requested"), and
 * called the resolve tool anyway. The thread showed fixed; the pushed commit never changed.
 *
 * This makes the promise checkable: resolving requires naming the commit that fixes it, and that
 * commit must be the pull request's current pushed source commit as Azure DevOps reports it,
 * and that commit must have been authored/committed after the review comment was published. No
 * regular expressions are used.
 */

import { isDeepStrictEqual } from "node:util";
import { reviewFindings, verifiedDescriptionAnswer } from "../../lib/creator-review.mjs";

/** Shortest commit prefix trusted to identify one commit rather than coincidentally matching. */
const MIN_SHA_LENGTH = 7;

/**
 * Whether `commit` is the pull request's current pushed head.
 *
 * Compared against `pr.sourceCommit` (Azure DevOps' `lastMergeSourceCommit`), which only advances
 * once a push actually lands on the source branch — a local commit, an amended-but-unpushed
 * commit, or a commit pushed to some other branch all fail this. Either value may be a short
 * prefix of the other, since callers and `git rev-parse` do not agree on how many characters of a
 * sha to print.
 */
export function commitIsPushed(pr, commit) {
  const expected = String(pr?.sourceCommit || "").toLowerCase();
  const actual = String(commit || "").toLowerCase();
  if (actual.length < MIN_SHA_LENGTH) return false;
  if (expected.length < MIN_SHA_LENGTH) return false;
  return expected === actual || expected.startsWith(actual) || actual.startsWith(expected);
}

/**
 * The timestamp of the newest review feedback in a thread.
 *
 * Ignores system events, deleted comments, and comments authored by the pull request author,
 * so the author's own reply does not make a thread appear newer than the fix commit.
 */
export function threadFeedbackDate(thread, authorAccount = "") {
  const author = String(authorAccount || "").toLowerCase();
  let newest = null;

  for (const comment of thread?.comments || []) {
    if (comment?.isDeleted === true) continue;
    if (comment?.commentType && comment.commentType !== "text") continue;
    const commenter = String(comment?.author?.uniqueName || "").toLowerCase();
    if (author && commenter === author) continue;

    const dateStr = comment?.publishedDate || comment?.lastUpdatedDate;
    if (!dateStr) continue;
    const at = Date.parse(dateStr);
    if (Number.isFinite(at) && (newest === null || at > newest)) {
      newest = at;
    }
  }

  if (newest !== null) return new Date(newest).toISOString();

  const threadDateStr = thread?.publishedDate || thread?.lastUpdatedDate;
  if (threadDateStr) {
    const at = Date.parse(threadDateStr);
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  return null;
}

/**
 * Decide whether resolving these threads is allowed, and say why not when it isn't.
 *
 * Returns one verdict for the whole batch rather than per thread: a commit either is or is not
 * the pushed head, and must postdate any review feedback in the threads being resolved. Every
 * rejection names the exact commit(s) and timestamps compared, so a caller (or a person reading
 * the log) can tell a stale read from an actually-missing push without re-deriving it.
 */
export function resolveGuard({ pr, commit, commitDate = null, threads = [], threadIds = [] }) {
  if (!commit) {
    return { allowed: false, reason: "no commit sha was given; resolving a thread requires the commit that fixes it" };
  }
  if (!pr) {
    return { allowed: false, reason: "the pull request could not be read" };
  }
  if (!commitIsPushed(pr, commit)) {
    const known = pr.sourceCommit || "unknown";
    return {
      allowed: false,
      reason: `commit ${commit} is not pull request ${pr.id}'s current pushed source commit (${known}); push it before resolving`,
    };
  }

  const effectiveCommitDate = commitDate || pr.sourceCommitDate || null;
  if (effectiveCommitDate && threads && threads.length > 0) {
    const commitTime = Date.parse(effectiveCommitDate);
    if (Number.isFinite(commitTime)) {
      const targetThreadIds = threadIds.length > 0
        ? threadIds.map(String)
        : threads.map((t) => String(t.id));

      for (const threadId of targetThreadIds) {
        const thread = threads.find((t) => String(t.id) === String(threadId));
        if (!thread) continue;
        const feedbackDate = threadFeedbackDate(thread, pr.author);
        if (!feedbackDate) continue;
        const feedbackTime = Date.parse(feedbackDate);
        if (Number.isFinite(feedbackTime) && commitTime < feedbackTime) {
          return {
            allowed: false,
            reason: `commit ${commit} (${new Date(commitTime).toISOString()}) predates review feedback in thread ${threadId} (${new Date(feedbackTime).toISOString()}); author and push a new commit before resolving`,
          };
        }
      }
    }
  }

  return { allowed: true, reason: `commit ${commit} matches pull request ${pr.id}'s current pushed source commit` };
}

/**
 * Resolve a batch of threads, refusing the whole batch unless the guard passes.
 *
 * Takes `ado` as a dependency (rather than importing azure-devops.mjs directly) so the decision
 * and the writes it triggers can be exercised in a test with a fake client and no network. Reads
 * the pull request itself instead of trusting a caller-supplied one, so a stale read never lets
 * an unpushed "fix" through.
 */
export async function resolveThreads({ config, prId, commit, threadIds, ado, log = () => {} }) {
  const pr = await ado.getPullRequest(config, prId).catch((error) => {
    log(`Failed to read pull request ${prId}: ${error.message}`);
    return null;
  });

  let threads = [];
  let threadReadFailed = false;
  if (ado.listThreads) {
    threads = await ado.listThreads(config, prId, { fresh: true }).catch((error) => {
      threadReadFailed = true;
      log(`Failed to read threads on pull request ${prId}: ${error.message}`);
      return [];
    });
  }

  if (threadReadFailed) {
    return { resolved: [], failed: [], refused: true, reason: "fresh review feedback is unavailable; no threads were resolved" };
  }

  let commitDate = pr?.sourceCommitDate || null;
  if (!commitDate && ado.getCommit && pr?.sourceCommit) {
    const commitData = await ado.getCommit(config, pr.sourceCommit).catch(() => null);
    commitDate = commitData?.date || commitData?.committerDate || commitData?.authorDate || null;
  }

  const guard = resolveGuard({ pr, commit, commitDate, threads, threadIds });
  if (!guard.allowed) {
    log(`Refusing to resolve thread(s) on PR ${prId}: ${guard.reason}`);
    return { resolved: [], failed: [], refused: true, reason: guard.reason };
  }

  const resolved = [];
  const failed = [];
  for (const threadId of threadIds) {
    try {
      await ado.updateThreadStatus(config, prId, threadId, "fixed");
      log(`Thread ${threadId} marked as fixed on PR ${prId} (verified against commit ${commit})`);
      resolved.push(threadId);
    } catch (error) {
      log(`Failed to resolve thread ${threadId}: ${error.message}`);
      failed.push(threadId);
    }
  }
  return { resolved, failed, refused: false, reason: guard.reason };
}

export async function resolveAnsweredThreads({ config, prId, contract, result, threadIds, ado }) {
  const refuse = reason => ({ resolved: [], failed: [], refused: true, reason });
  if (String(contract?.prId) !== String(prId) || !result ||
      result.submissionId !== contract.submissionId || result.fingerprint !== contract.fingerprint ||
      !Array.isArray(threadIds) || !threadIds.length || new Set(threadIds.map(String)).size !== threadIds.length) {
    return refuse("A matching answer contract, result and unique thread IDs are required");
  }
  const pr = await ado.getPullRequest(config, prId);
  const threads = await ado.listThreads(config, prId, { fresh: true });
  if (pr.status !== "active" || pr.sourceCommit !== result.head || pr.branch !== contract.branch) {
    return refuse("The answered PR revision or branch changed");
  }
  const findingConfig = { ...config, authorAccount: pr.author || config.authorAccount };
  const currentFindings = reviewFindings(threads.map(thread => ({ ...thread, status: "active" })), findingConfig);
  for (const id of threadIds.map(String)) {
    const finding = contract.findings?.find(value => value.threadId === id);
    const rows = result.findings?.filter(value => value.threadId === id) || [];
    const row = rows[0];
    const thread = threads.find(value => String(value.id) === id);
    if (!thread || thread.isDeleted || !finding || rows.length !== 1 ||
        !isDeepStrictEqual(finding, currentFindings.find(value => value.threadId === id))) {
      return refuse(`Thread ${id} is missing or its feedback changed after the answer`);
    }
    if (!verifiedDescriptionAnswer(contract, row, pr) ||
        ![row.evidence, row.verification?.command, row.verification?.expected, row.verification?.actual]
          .every(value => typeof value === "string" && value.trim())) {
      return refuse(`Thread ${id} lacks a published, reproduced clarification answer`);
    }
  }
  const resolved = [], failed = [];
  for (const id of threadIds.map(String)) {
    const beforeWrite = await ado.getPullRequest(config, prId);
    if (beforeWrite.status !== "active" || beforeWrite.sourceCommit !== result.head ||
        beforeWrite.branch !== contract.branch) {
      failed.push(id);
      continue;
    }
    await ado.updateThreadStatus(config, prId, id, "fixed");
    const [readback, afterWrite] = await Promise.all([
      ado.listThreads(config, prId, { fresh: true }), ado.getPullRequest(config, prId),
    ]);
    const current = readback.find(thread => String(thread.id) === id);
    const finding = reviewFindings(readback.map(thread => ({ ...thread, status: "active" })), findingConfig)
      .find(value => value.threadId === id);
    if (afterWrite.status !== "active" || afterWrite.sourceCommit !== result.head || afterWrite.branch !== contract.branch ||
        !isDeepStrictEqual(finding, contract.findings.find(value => value.threadId === id))) {
      await ado.updateThreadStatus(config, prId, id, "active");
      failed.push(id);
    } else if (!current || current.status !== "fixed") {
      failed.push(id);
    } else {
      resolved.push(id);
    }
  }
  return { resolved, failed, refused: false, reason: failed.length
    ? "Answer resolution did not persist or feedback/revision changed"
    : "Published answer and thread resolution read back independently" };
}
