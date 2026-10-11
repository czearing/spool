/**
 * Why a pull request needs the updater, and why it does not.
 *
 * Pure and exhaustively testable: this is the decision that spends an agent turn under the
 * operator's identity, and a wrong answer is silent in both directions. Too eager and a reviewer
 * is answered mid-sentence; too lazy and a person waits a day and concludes nothing works.
 *
 * Measured over 40 office-bohemia pull requests: 168 comments, of which 57 were TFS system rows,
 * 49 office-fluid posts with no commentType, 27 Agency, and 8 genuine human comments. So the
 * filtering is the feature. No regular expressions are used.
 */
import { DEFAULT_QUIET_MINUTES, humanReviewActivity, isAgencyFeedback } from "./review-trigger.mjs";
import { classifyFailures } from "./build-failures.mjs";

export const CONFLICT = "conflict";
export const BUILD = "build";
export const REVIEW = "review";
export const AGENCY = "agency";

/**
 * Agency writes its findings and severity either into legacy bold markers (**Blocking**, **Suggestion**)
 * or modern code review swarm reports (Verdict: Request changes, 2 HIGH, 🟠/🔴, etc.).
 * Suggestions are worth a turn: they are specific, technical, and sometimes right, so they are
 * triaged like any other reviewer's note rather than discarded unread.
 *
 * An informational summary with no issues or 0 findings is excluded.
 */
function severityOf(body) {
  if (!body) return null;
  const text = String(body).trim();
  if (text.length === 0) return null;
  if (
    text.includes("**No issues found**") ||
    text.includes("No issues found") ||
    text.includes("0 findings") ||
    text.includes("0 issues found") ||
    (text.includes("0 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW") && !text.includes("Verdict: Request changes"))
  ) {
    return null;
  }
  if (
    text.includes("**Blocking**") ||
    text.includes("Verdict: Request changes") ||
    text.includes("CRITICAL") ||
    text.includes("🔴") ||
    text.includes("HIGH") ||
    text.includes("🟠")
  ) {
    return "**Blocking**";
  }
  if (
    text.includes("**Suggestion**") ||
    text.includes("Verdict: Approve with suggestions") ||
    text.includes("Verdict: Comment") ||
    text.includes("MEDIUM") ||
    text.includes("LOW") ||
    text.includes("🟡") ||
    text.includes("Finding") ||
    text.includes("Findings")
  ) {
    return "**Suggestion**";
  }
  if (isAgencyFeedback({ content: text })) {
    return "**Suggestion**";
  }
  return null;
}

/** Merge states that mean the branch cannot land until somebody edits it. */
const CONFLICTED = ["conflicts", "failure"];

/** A thread nobody has resolved. Fixed, closed and wontFix are each somebody's answer. */
function isOpen(thread) {
  return thread?.isDeleted !== true && String(thread?.status || "active") === "active";
}

function timeOf(comment) {
  const at = Date.parse(comment?.publishedDate || comment?.lastUpdatedDate || "");
  return Number.isFinite(at) ? at : null;
}

function newestAuthorCommentAt(thread, authorAccount) {
  const author = String(authorAccount || "").toLowerCase();
  if (author.length === 0) return null;
  let newest = null;
  for (const comment of thread?.comments || []) {
    if (comment?.isDeleted === true || comment?.commentType !== "text") continue;
    if (String(comment.author?.uniqueName || "").toLowerCase() !== author) continue;
    const at = Date.parse(comment.publishedDate || comment.lastUpdatedDate || "");
    if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/**
 * Unresolved findings from Agency, at any severity it assigned.
 *
 * Identity, not shape, separates Agency from the reporting bots: both post commentType text from
 * an s2s principal with an empty uniqueName, so no structural rule can tell them apart.
 */
export function agencyFindings(threads, options = {}) {
  const authorId = options.agencyAuthorId || "";
  const authorAccount = options.authorAccount || "";
  const findings = [];
  for (const thread of threads || []) {
    if (!isOpen(thread)) continue;
    for (const comment of thread.comments || []) {
      if (comment?.isDeleted === true || comment?.commentType !== "text") continue;
      const author = comment.author || {};
      const isAgency = authorId
        ? author.id === authorId
        : String(author.displayName || "") === "Agency";
      if (!isAgency) continue;
      const severity = severityOf(String(comment.content || ""));
      if (!severity) continue;

      const commentAt = timeOf(comment);
      const repliedAt = newestAuthorCommentAt(thread, authorAccount);
      if (!options.creatorRouting && !options.requireDisposition &&
          repliedAt !== null && commentAt !== null && repliedAt > commentAt) continue;

      findings.push({ threadId: thread.id, at: commentAt, severity });
    }
  }
  return findings;
}

/**
 * A human reviewer's burst, once they have stopped typing.
 *
 * The window is measured from the newest comment, so a second thought nine minutes into the first
 * restarts the clock and both are answered together.
 */
function reviewVerdict(threads, at, config) {
  const activity = humanReviewActivity(threads, {
    botAccounts: config.botAccounts || [],
    authorAccount: config.authorAccount || "",
    selfAccount: config.agentAccount || "",
    agencyAuthorId: config.agencyAuthorId || "",
    requireDisposition: config.creatorRouting === true || config.requireDisposition === true,
  });
  if (activity.count === 0 || activity.newestAt === null) return null;

  const isOnlyAgency = activity.authors.length === 1 && activity.authors[0] === "Agency";
  const quietMinutes = isOnlyAgency ? 0 : (config.quietMinutes ?? DEFAULT_QUIET_MINUTES);
  if ((at - Date.parse(activity.newestAt)) / 60_000 < quietMinutes) return null;

  return {
    trigger: REVIEW,
    reason: `${activity.count} comment(s) from ${activity.authors.join(", ")}`,
    fingerprint: `review:${activity.newestAt}`,
  };
}

/**
 * The single reason this pull request needs the updater now, or null.
 *
 * Ordered by what blocks the pull request hardest. A conflict makes every other signal moot since
 * nothing can merge until it is resolved; a reproduced build failure blocks the gate; a person
 * waiting on an answer outranks a machine's finding.
 *
 * Each verdict carries a fingerprint identifying the evidence rather than the moment, so the same
 * cause is never sent twice while a genuinely new one always gets through.
 */
export function evaluate({ pr, threads = [], builds = [], now, config = {}, retried = {}, transientNames }) {
  const at = Date.parse(now);
  if (!Number.isFinite(at)) return null;

  if (CONFLICTED.includes(String(pr?.mergeStatus || ""))) {
    return { trigger: CONFLICT, reason: "merge conflict", fingerprint: `conflict:${pr.sourceCommit || ""}` };
  }

  const { escalate } = classifyFailures(builds, { retried, transientNames });
  if (escalate.length > 0) {
    return {
      trigger: BUILD,
      reason: `build failed: ${escalate.map((build) => build.name || build.id).join(", ")}`,
      fingerprint: `build:${pr.sourceCommit || ""}:${escalate.map((build) => build.id).join(",")}`,
    };
  }

  const review = reviewVerdict(threads, at, config);
  if (review) return review;

  const findings = agencyFindings(threads, config);
  if (findings.length > 0) {
    const blocking = findings.filter((finding) => finding.severity === "**Blocking**").length;
    const mix = blocking === findings.length ? "blocking" : blocking > 0 ? "blocking and suggestion" : "suggestion";
    return {
      trigger: AGENCY,
      reason: `${findings.length} unresolved ${mix} finding(s)`,
      fingerprint: `agency:${findings.map((finding) => finding.threadId).sort().join(",")}`,
    };
  }

  return null;
}

/**
 * Whether a verdict should be delivered, given what was already sent for this pull request.
 *
 * The record is a rate limiter, never a record of completion. A cause still unresolved after the
 * retry window is offered again, because a wake that failed, or an agent that worked and never
 * replied, would otherwise bury a reviewer's comment forever.
 */
export function shouldSend(verdict, entry, now, config = {}) {
  if (!verdict) return null;
  if (entry?.fingerprint !== verdict.fingerprint) return { ...verdict, retry: false };

  const at = Date.parse(now);
  const sentAt = entry?.lastSentAt ? Date.parse(entry.lastSentAt) : null;
  if (!Number.isFinite(sentAt) || !Number.isFinite(at)) return null;
  if ((at - sentAt) / 60_000 < (config.retryMinutes ?? 120)) return null;
  return { ...verdict, retry: true };
}
