// When a human review comment should wake the agent that owns a pull request.
//
// This is shared because every runner that gives an agent a pull request needs the same
// decision, and it is the one place where getting it wrong is expensive in both directions:
// too eager and the agent is woken mid-sentence by a reviewer who is still typing, too lazy
// and a person waits an hour for an answer and concludes the automation is broken.
//
// Everything here is pure. Callers fetch threads however they like and pass them in, so the
// policy can be tested exhaustively without the network. No regular expressions are used.

/** Thread states that still expect somebody to act. */
const OPEN_THREAD_STATES = ["active", "pending"];

/** Identity descriptor prefix used by Azure DevOps service-to-service principals. */
const SERVICE_PREFIX = "s2s.";

/**
 * How long a reviewer must be silent before their burst is treated as finished.
 *
 * Measured over the last 120 office-bohemia pull requests: of 133 consecutive comment gaps by
 * the same author, 66% are under 5 minutes and 72% under 10, then the distribution jumps to
 * hours (p90 148 min, max 19 h). So a window past 10 minutes buys almost nothing - 45 minutes
 * reaches only 80% - while charging its full length to every review. The long tail is separate
 * review sessions, which are a new burst and should wake the agent again rather than be
 * swallowed by a longer timer.
 */
export const DEFAULT_QUIET_MINUTES = 10;

/**
 * Decide whether an Agency comment is actionable review feedback.
 *
 * Agency posts text comments from an s2s identity. An informational summary with no findings, or
 * an explicit "No issues found", is not feedback asking for a change. Inline comments, findings,
 * suggestions, and verdict reports requesting changes or offering suggestions are treated as
 * review feedback.
 */
export function isAgencyFeedback(comment) {
  const content = String(comment?.content || "").trim();
  if (content.length === 0) return false;
  if (content.includes("**No issues found**") || content.includes("No issues found")) return false;
  if (content.includes("0 findings") || content.includes("0 issues found")) return false;
  if (content.includes("0 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW") && !content.includes("Verdict: Request changes")) return false;
  const isSummary =
    content.includes("<!-- post-pr-review:v1 type=summary -->") ||
    content.includes("<!-- review-swarm-report/v1 -->") ||
    content.includes("**PR Review**") ||
    content.includes("# Code Review Report");
  if (
    isSummary &&
    !content.includes("**Blocking**") &&
    !content.includes("**Suggestion**") &&
    !content.includes("Finding") &&
    !content.includes("Findings") &&
    !content.includes("Verdict: Request changes") &&
    !content.includes("Verdict: Approve with suggestions") &&
    !content.includes("🔴") &&
    !content.includes("🟠") &&
    !content.includes("🟡")
  ) {
    return false;
  }
  return true;
}

/**
 * Decide whether a comment is a human reviewer asking for a change.
 *
 * Measured against 25 real office-bohemia pull requests. Three traps drove this shape:
 *   - "system" comments ("Policy status has been updated", "X voted 10") carry a real
 *     person's displayName, so filtering on the name would read them as human review.
 *   - The GitOps and other automation reviewers post commentType "text" from "s2s." identities
 *     with an empty uniqueName, so both are dropped by that rule.
 *   - Agency is an S2S principal that conducts code reviews; when it leaves actionable feedback,
 *     it is considered a human reviewer.
 *   - office-fluid posts commentType "text" from a normal "aad." identity with a real
 *     @microsoft.com uniqueName, so it is structurally identical to a person. No
 *     heuristic separates it; it has to be named in config.botAccounts.
 */
export function isHumanComment(comment, options = {}) {
  const bots = options.botAccounts || [];
  const self = options.selfAccount || "";
  const author = options.authorAccount || "";
  const agencyAuthorId = options.agencyAuthorId || "";

  const commenter = comment?.author || {};
  const uniqueName = String(commenter.uniqueName || "").toLowerCase();
  const displayName = String(commenter.displayName || "").trim().toLowerCase();

  if (comment?.isDeleted === true) return false;
  if (comment?.commentType !== "text") return false;
  if (commenter.isContainer === true) return false;

  const isAgency = (agencyAuthorId && commenter.id === agencyAuthorId) || displayName === "agency";
  if (isAgency) {
    return isAgencyFeedback(comment);
  }

  if (String(commenter.descriptor || "").startsWith(SERVICE_PREFIX)) return false;
  if (uniqueName.length === 0) return false;
  if (self && uniqueName === self.toLowerCase()) return false;
  // The author is not a reviewer of their own pull request. Every agent here pushes and comments
  // under the operator's identity, so without this its own reply reads as fresh review feedback
  // and it wakes itself for answering.
  if (author && uniqueName === author.toLowerCase()) return false;
  for (const bot of bots) {
    if (uniqueName === String(bot).toLowerCase()) return false;
  }
  return true;
}

/**
 * When the author last spoke in a thread.
 *
 * Bot and system comments are ignored, so a policy update posted after a reply cannot be mistaken
 * for the author answering. Returns null when `authorAccount` is not configured, which leaves
 * answered-detection off rather than guessing.
 */
function newestAuthorCommentAt(thread, authorAccount) {
  const author = String(authorAccount || "").toLowerCase();
  if (author.length === 0) return null;
  let newest = null;
  for (const comment of thread?.comments || []) {
    if (comment?.isDeleted === true) continue;
    if (comment?.commentType !== "text") continue;
    if (String(comment.author?.uniqueName || "").toLowerCase() !== author) continue;
    const at = Date.parse(comment.publishedDate || comment.lastUpdatedDate || "");
    if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/** True when a thread still expects a response from the pull request author. */
export function isOpenThread(thread) {
  if (thread?.isDeleted === true) return false;
  const status = String(thread?.status || "active");
  return OPEN_THREAD_STATES.includes(status);
}

/**
 * Reduce raw thread payloads to the single fact a caller needs: the newest human
 * comment that is still waiting on the author, and how many there are.
 *
 * "Still waiting" is read from the thread, not from any record of what we did. A thread whose
 * author has replied after the newest reviewer comment is answered and is dropped here, which is
 * what lets the caller be level triggered: a wake that never produced a reply leaves the thread
 * unanswered, so it is offered again instead of being buried by our own bookkeeping.
 */
export function humanReviewActivity(threads, options = {}) {
  let newest = null;
  let count = 0;
  const authors = new Set();
  const unknown = new Set();

  for (const thread of threads || []) {
    if (!isOpenThread(thread)) continue;

    let threadNewest = null;
    let threadCount = 0;
    const threadAuthors = new Set();
    for (const comment of thread.comments || []) {
      if (!isHumanComment(comment, options)) {
        recordUnknown(comment, options, unknown);
        continue;
      }
      threadCount++;
      threadAuthors.add(String(comment.author?.displayName || "unknown"));
      const at = Date.parse(comment.publishedDate || comment.lastUpdatedDate || "");
      if (Number.isFinite(at) && (threadNewest === null || at > threadNewest)) threadNewest = at;
    }
    if (threadCount === 0) continue;

    // Answered: the author spoke after the newest reviewer comment in this thread.
    const repliedAt = newestAuthorCommentAt(thread, options.authorAccount);
    if (!options.requireDisposition && repliedAt !== null && threadNewest !== null && repliedAt > threadNewest) continue;

    count += threadCount;
    for (const name of threadAuthors) authors.add(name);
    if (threadNewest !== null && (newest === null || threadNewest > newest)) newest = threadNewest;
  }
  return {
    count,
    newestAt: newest === null ? null : new Date(newest).toISOString(),
    authors: [...authors],
    unknownAuthors: [...unknown],
  };
}

/**
 * Surface human-looking accounts we filtered out only because of the denylist, so the
 * roster can be reviewed rather than silently drifting out of date.
 */
function recordUnknown(comment, options, unknown) {
  if (comment?.commentType !== "text") return;
  const author = comment.author || {};
  if (String(author.descriptor || "").startsWith(SERVICE_PREFIX)) return;
  const uniqueName = String(author.uniqueName || "");
  if (uniqueName.length === 0) return;
  const bots = (options.botAccounts || []).map((bot) => String(bot).toLowerCase());
  if (bots.includes(uniqueName.toLowerCase())) unknown.add(uniqueName);
}
