/**
 * Tell a pipeline apart from a person, without knowing either by name.
 *
 * Naming the bots works until the next project, and substring tests on "bot" or "service" are a
 * correlation trap: the noisiest automated commenter in this repository is called `office-fluid`,
 * which contains neither. So identity shape is tested first, and what cannot be settled by shape
 * is settled by behaviour that no person exhibits.
 *
 * Measured over 40 office-bohemia pull requests: 168 comments, of which 57 were system rows, 49
 * were office-fluid, 27 were Agency, and 8 were genuine human review. Roughly 95% of comment
 * traffic is machine-made, and one machine identity is structurally indistinguishable from a
 * person: `office-fluid` posts commentType "text" from a normal `aad.` identity with a real
 * @microsoft.com address. Shape alone provably cannot catch it.
 *
 * The behavioural rule that does: a reviewer who comments votes, and an identity that comments on
 * several different pull requests while never once appearing as a reviewer on any of them is
 * posting from a pipeline. That is learned from whatever pull requests the caller already
 * surveyed, so it carries to another project with no configuration at all.
 *
 * Unknown always resolves to human. Every consumer of this module either spends an agent turn or
 * closes somebody's thread, and both are worse when done to a person than skipped for a machine.
 *
 * No regular expressions are used.
 */

import { isAgencyFeedback } from "./review-trigger.mjs";

/** Azure DevOps identity descriptor prefixes that only non-interactive principals carry. */
const MACHINE_PREFIXES = ["s2s.", "svc."];

/** How many distinct pull requests an identity must appear on before behaviour is conclusive. */
export const LEARNING_THRESHOLD = 2;

/** A stable key for an identity across pull requests, preferring the immutable id. */
export function identityKey(author) {
  const id = String(author?.id || "").trim();
  if (id.length > 0) return `id:${id}`;
  const uniqueName = String(author?.uniqueName || "").trim().toLowerCase();
  if (uniqueName.length > 0) return `name:${uniqueName}`;
  return `display:${String(author?.displayName || "unknown").trim().toLowerCase()}`;
}

/**
 * Machine evidence visible in a single comment, with no history required.
 *
 * Returned as a list of reasons rather than a boolean so a decision to close somebody's thread can
 * always say what convinced it.
 */
export function machineSignals(comment) {
  const author = comment?.author || {};
  const reasons = [];
  // Azure DevOps writes its own thread events as a non-text commentType. Nobody types these.
  if (comment?.commentType && comment.commentType !== "text") reasons.push(`system comment (${comment.commentType})`);
  if (author.isContainer === true) reasons.push("identity is a group, not a person");
  const descriptor = String(author.descriptor || "").toLowerCase();
  for (const prefix of MACHINE_PREFIXES) {
    if (descriptor.startsWith(prefix)) reasons.push(`service principal descriptor (${prefix})`);
  }
  // An interactive account always has a sign-in address; a pipeline identity frequently has none.
  if (String(author.uniqueName || "").trim().length === 0 && String(author.displayName || "").length > 0) {
    reasons.push("identity has no sign-in address");
  }
  return reasons;
}

/**
 * Build the behavioural census from pull requests the caller already fetched.
 *
 * `prs` supply the reviewer rosters and `threadsByPr` the commenters. Nothing extra is requested
 * from the server: this is derived entirely from what a survey pass already holds.
 */
export function observeIdentities(prs, threadsByPr) {
  const seen = new Map();
  const entry = (key) => {
    if (!seen.has(key)) seen.set(key, { key, pullRequests: new Set(), reviewedOn: new Set(), displayName: "" });
    return seen.get(key);
  };

  for (const pr of prs || []) {
    for (const reviewer of pr.reviewers || []) {
      const record = entry(identityKey(reviewer));
      record.reviewedOn.add(String(pr.id));
      if (!record.displayName) record.displayName = String(reviewer.displayName || "");
    }
    for (const thread of threadsByPr?.[pr.id] || []) {
      for (const comment of thread?.comments || []) {
        const record = entry(identityKey(comment?.author));
        record.pullRequests.add(String(pr.id));
        if (!record.displayName) record.displayName = String(comment?.author?.displayName || "");
      }
    }
  }
  return seen;
}

/**
 * Identities whose behaviour is only explicable as automation.
 *
 * Commenting widely while never being asked to review is the tell. A person who comments on a
 * pull request was added to it; a pipeline posts to every pull request it is pointed at and is on
 * none of their reviewer lists.
 */
export function learnedMachines(census, threshold = LEARNING_THRESHOLD) {
  const machines = new Map();
  for (const record of census.values()) {
    if (record.reviewedOn.size > 0) continue;
    if (record.pullRequests.size < threshold) continue;
    machines.set(record.key, `commented on ${record.pullRequests.size} pull requests without ever being a reviewer`);
  }
  return machines;
}

/**
 * Classify one comment's author.
 *
 * `options.machines` is the learned map, `options.knownMachines` an optional configured roster for
 * an identity seen too rarely for behaviour to speak, and `options.selfAccount` the operator, whose
 * own replies are neither review nor automation.
 */
export function classifyAuthor(comment, options = {}) {
  const author = comment?.author || {};
  const key = identityKey(author);
  const uniqueName = String(author.uniqueName || "").toLowerCase();
  const displayName = String(author.displayName || "").trim().toLowerCase();
  const agencyAuthorId = options.agencyAuthorId || "";

  const self = String(options.selfAccount || "").toLowerCase();
  if (self && uniqueName === self) return { kind: "self", key, reason: "the operator's own account" };

  const isAgency = (agencyAuthorId && author.id === agencyAuthorId) || displayName === "agency";
  if (isAgency) {
    if (isAgencyFeedback(comment)) {
      return { kind: "human", key, reason: "Agency review feedback", confidence: "agency" };
    }
    return { kind: "machine", key, reason: "Agency informational/summary comment", confidence: "agency" };
  }

  const signals = machineSignals(comment);
  if (signals.length > 0) return { kind: "machine", key, reason: signals.join("; "), confidence: "shape" };

  const learned = options.machines?.get(key);
  if (learned) return { kind: "machine", key, reason: learned, confidence: "behaviour" };

  for (const known of options.knownMachines || []) {
    if (uniqueName && uniqueName === String(known).toLowerCase()) {
      return { kind: "machine", key, reason: "listed as a known automation account", confidence: "configured" };
    }
  }
  return { kind: "human", key, reason: "no automation evidence", confidence: "default" };
}

/**
 * A thread that is genuinely an unresolved discussion.
 *
 * The missing status is the trap. Azure DevOps returns pull request timeline events - "the
 * reference was updated", "Nate Tan voted 10", "Caleb Zearing added a reviewer" - through the same
 * threads endpoint as review comments, and they carry no status property at all. Defaulting an
 * absent status to active counted 13 of them as outstanding on a pull request whose comments were
 * all long since resolved, and would have had the auto-close write to every one of them.
 *
 * So open means explicitly open. Fixed, closed and wontFix are each somebody's answer, and no
 * status at all means the row was never a question.
 */
export function isOpenThread(thread) {
  if (thread?.isDeleted === true) return false;
  const status = String(thread?.status || "");
  return ["active", "pending"].includes(status);
}

/**
 * Split the unresolved threads on a pull request into the ones a person is waiting on and the
 * ones a pipeline left behind.
 *
 * A thread is human the moment any live comment in it is human, so a pipeline replying to a person
 * never launders their thread into an automated one.
 */
export function classifyThreads(threads, options = {}) {
  const human = [];
  const automated = [];
  for (const thread of threads || []) {
    if (!isOpenThread(thread)) continue;
    const live = (thread.comments || []).filter((comment) => comment?.isDeleted !== true);
    if (live.length === 0) continue;
    // A thread carrying nothing but system rows is a record of something that happened, not a
    // question anyone can answer, so it is neither waiting on a person nor worth closing.
    if (live.every((comment) => comment?.commentType === "system")) continue;
    const kinds = live.map((comment) => classifyAuthor(comment, options));
    if (kinds.some((kind) => kind.kind === "human")) human.push(thread);
    else if (kinds.some((kind) => kind.kind === "machine")) {
      automated.push({ thread, reason: kinds.find((kind) => kind.kind === "machine").reason });
    }
  }
  return { human, automated, unresolved: human.length + automated.length };
}
