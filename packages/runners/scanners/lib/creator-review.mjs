import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { buildSummary } from "../pr-updater/lib/merge-readiness.mjs";
import { isHumanComment, isOpenThread } from "../pr-updater/lib/review-trigger.mjs";

export function productMatchesPr(product, pr) {
  if (product.type !== "pull_request") return false;
  const candidate = product.url || product.metadata?.url;
  if (!candidate || !pr.url) return false;
  const canonical = (value) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || (url.hostname !== "dev.azure.com" && !/^[^.]+\.visualstudio\.com$/.test(url.hostname))) {
      throw new Error("Not an Azure DevOps PR URL");
    }
    const parts = url.pathname.toLowerCase().split("/").filter(Boolean);
    const organization = url.hostname === "dev.azure.com" ? parts.shift() : url.hostname.replace(".visualstudio.com", "");
    return `${organization}/${parts.join("/")}`.replace(/\/$/, "");
  };
  try { return canonical(candidate) === canonical(pr.url); }
  catch { return false; }
}

export function reviewFindings(threads, config) {
  return threads.filter(isOpenThread).flatMap((thread) => {
    const comments = (thread.comments || []).filter((comment) => isHumanComment(comment, {
      botAccounts: config.botAccounts, authorAccount: config.authorAccount,
      agencyAuthorId: config.agencyAuthorId, selfAccount: config.agentAccount,
    }));
    return comments.length ? [{
      threadId: String(thread.id),
      file: thread.threadContext?.filePath || null,
      comments: comments.map((comment) => ({
        id: comment.id, at: comment.lastUpdatedDate || comment.publishedDate,
        author: comment.author?.displayName, body: comment.content,
      })),
    }] : [];
  });
}

export function reviewReplyRequired(thread, config = {}) {
  return !!thread && !thread.isDeleted && (thread.comments || []).some(comment =>
    isHumanComment(comment, { ...config, selfAccount: config.agentAccount }) &&
    (!config.agencyAuthorId || comment.author?.id !== config.agencyAuthorId) &&
    String(comment.author?.displayName || "").toLowerCase() !== "agency");
}

export function verifiedThreadReply(contract, row, pr, thread) {
  if (typeof row?.reply !== "string" || !row.reply.trim() || !pr.author) return false;
  const reply = thread?.comments?.find(comment => String(comment.id) === String(row.responseCommentId));
  return !!reply && !reply.isDeleted && reply.commentType === "text" &&
    reply.content?.trim() === row.reply.trim() &&
    reply.author?.uniqueName?.toLowerCase() === pr.author.toLowerCase() &&
    Date.parse(reply.publishedDate || reply.lastUpdatedDate) >= Date.parse(contract.at);
}

export function requiresThreadReply(contract, row) {
  return contract.responseMode === "pr_thread" && contract.replyThreadIds?.includes(row.threadId) &&
    (contract.replyPolicy !== "when_needed" || row.disposition !== "fixed" ||
      row.reply !== undefined || row.responseCommentId !== undefined);
}

export async function readReviewProcedure(spoolRoot) {
  if (typeof spoolRoot !== "string" || !path.isAbsolute(spoolRoot)) {
    throw new Error("PR updater requires an absolute Spool project root for its canonical agent prompt");
  }
  const text = await readFile(path.join(spoolRoot, "agents", "pr-updater.md"), "utf8");
  const procedure = text.replace(/^\uFEFF/, "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  if (!procedure.trim()) throw new Error("Canonical PRUpdater review procedure is empty; handoff refused");
  return procedure;
}

export function withSpoolReviewTools(contract) {
  if (contract.resolutionMode !== "runner") throw new Error("PR updates require Spool runner-owned resolution");
  if (!contract.contractFile || !contract.creatorRoleFile || !contract.resultFile) {
    throw new Error("Spool PR update requires exact contract, creator instructions, and result file paths");
  }
  if (!contract.prId || !contract.submissionId) throw new Error("Spool PR update requires PR and submission identity");
  return { ...contract, completionInstructions: [
    "Read creatorRoleFile and preserve the original creator, task, session, branch, and publication protections.",
    "The runner owns repository preparation; use the prepared checkout. Run builds, tests, focused reproductions, browser benchmarks, screenshots and application servers directly using the repository's existing commands and authenticated browser harness. Agent MCP access is publication-only: use bohemia_pr for Bohemia or repo_pr for 1JS. Do not publish through shell commands or change the runner-owned branch/setup.",
    "Complete your builds and tests before publication. Do not run competing operations on the same checkout; preserve any real external owner and its workspace lock. Report the exact commands and observed results; publication does not execute tests for you.",
    "Before publishing, call spool_get_task and require its current contract submissionId and fingerprint to match this assignment.",
    "Never post PR comments or replies. Publish clarification evidence through the repository MCP PR-description update, not by editing it directly.",
    "When fixBaselineHead is present, the original task already published the fixes listed in fixBaselineThreadIds before this follow-up. Reproduce those fixes against the current head; do not manufacture another commit. Preserve any carried description evidence; otherwise answers require new published description evidence. New or changed feedback still requires its own repair.",
    "Use JSON.stringify to write resultFile with submissionId, fingerprint, pushed head, and one findings entry per thread: threadId, disposition (fixed, disproved, answered, or blocked), evidence, and verification (command, expected, actual). For answered, disproved, or fixed explicitly marked PR-description findings, include descriptionEvidence with an exact new published description excerpt; description repairs do not require a manufactured code commit. For build/conflict repairs include repair.evidence (a non-empty string or non-empty array of non-empty strings) and repair.verification (one object or a non-empty array of objects, each with non-empty command, expected and actual strings).",
    "The runner owns guarded thread resolution and independent fresh PR, feedback, build, and pushed-head verification. Do not look for a remote resolver or invent a resolution. Save resultFile, then call spool_update_task_status with completed; use failed with the actual error for unfinished work. Completion records your verified work, not PR merge or runner acceptance.",
  ].join("\n\n") };
}

export function reviewPrompt(contract, procedure, { transport = "spool" } = {}) {
  if (transport !== "spool") throw new Error("Unknown PR update delivery transport; only Spool is supported");
  if (typeof procedure !== "string" || !procedure.trim()) throw new Error("Canonical PRUpdater review procedure is required");
  const completed = withSpoolReviewTools(contract);
  const contractFile = contract.remoteArtifacts?.contractFile || completed.contractFile;
  return [
    procedure,
    [
      "Continue this existing PR on its original task/session.",
      `Read "${contractFile}" for the PR, branch, checkout, creator instructions, feedback, and completion details.`,
      "Switch branches.",
    ].join("\n"),
  ].join("\n\n");
}

export function verifiedReviewCoverage(contract, result, pr, threads, builds, findings) {
  if (!contract || !findings.length || !validateReviewResult(contract, result, pr, threads, builds).ok) return false;
  return findings.every(finding => contract.findings.some(previous => isDeepStrictEqual(previous, finding)));
}

export function pendingReviewCoverage(contract, result, pr, threads, builds, findings) {
  if (contract?.resolutionMode !== "runner" ||
      (!findings.length && !["build", "conflict"].includes(contract.repair?.type)) ||
      buildSummary(builds).state !== "running" ||
      !reviewResult(contract, result, pr, threads, builds, true).ok) return false;
  return findings.every(finding => contract.findings.some(previous => isDeepStrictEqual(previous, finding)));
}

function verifiedDescriptionEvidence(contract, row, pr) {
  return contract.responseMode === "pr_description"
    && typeof contract.descriptionBaseline === "string" && typeof pr.description === "string"
    && typeof row.descriptionEvidence === "string" && row.descriptionEvidence.trim().length > 0
    && pr.description.includes(row.descriptionEvidence)
    && !contract.descriptionBaseline.includes(row.descriptionEvidence);
}

export function verifiedDescriptionAnswer(contract, row, pr) {
  return ["answered", "disproved"].includes(row?.disposition) && verifiedDescriptionEvidence(contract, row, pr);
}

export function descriptionReviewFinding(finding) {
  return finding && !finding.file && finding.comments?.some(comment =>
    typeof comment.body === "string" && comment.body.includes("<!-- unslop-review v1 kind:description -->"));
}

export function verifiedDescriptionFix(contract, row, pr) {
  return row?.disposition === "fixed" &&
    descriptionReviewFinding(contract.findings?.find(finding => finding.threadId === row.threadId)) &&
    verifiedDescriptionEvidence(contract, row, pr);
}

export function reviewFixBaseline(contract, threadId) {
  const previous = contract.previousFixSubmissionId || contract.previousAnswerSubmissionId;
  return /^[a-f0-9]{40}$/.test(contract.fixBaselineHead || "") &&
    typeof previous === "string" && previous.trim() && previous !== contract.submissionId &&
    (threadId === undefined || !Array.isArray(contract.fixBaselineThreadIds) ||
      contract.fixBaselineThreadIds.includes(threadId))
    ? contract.fixBaselineHead : contract.head;
}

export function reuseDescriptionAnswerBaseline(contract, previous, result, pr) {
  if (contract.responseMode === "pr_thread") {
    return previous && result && result.submissionId === previous.submissionId &&
      result.fingerprint === contract.fingerprint && previous.fingerprint === contract.fingerprint &&
      result.head === pr.sourceCommit && previous.head !== pr.sourceCommit &&
      previous.prId === contract.prId && previous.branch === contract.branch &&
      contract.findings.length && isDeepStrictEqual(previous.findings, contract.findings)
      ? { ...contract, head: previous.head, previousAnswerSubmissionId: previous.submissionId } : contract;
  }
  if (!previous || previous.responseMode !== "pr_description" || !result ||
       !Array.isArray(result.findings) || result.findings.length !== previous.findings?.length ||
       result.submissionId !== previous.submissionId ||
      result.fingerprint !== previous.fingerprint || result.head !== pr.sourceCommit ||
      previous.prId !== contract.prId || previous.branch !== contract.branch || !contract.findings.length) return contract;
  const matching = contract.findings.every(finding => {
    const rows = result.findings?.filter(row => row.threadId === finding.threadId) || [];
    const row = rows[0];
    return isDeepStrictEqual(finding, previous.findings.find(old => old.threadId === finding.threadId)) &&
      rows.length === 1 && [row.evidence, row.verification?.command, row.verification?.expected, row.verification?.actual]
        .every(value => typeof value === "string" && value.trim()) &&
      ["fixed", "answered", "disproved"].includes(row.disposition);
  });
  if (!matching) return contract;
  const fixes = contract.findings.filter(finding => result.findings.some(row =>
    row.threadId === finding.threadId && row.disposition === "fixed" && !descriptionReviewFinding(finding) &&
      pr.sourceCommit !== reviewFixBaseline(previous, finding.threadId))).map(finding => finding.threadId);
  const proof = fixes.length ? { fixBaselineHead: reviewFixBaseline(previous, fixes[0]),
    fixBaselineThreadIds: fixes, previousFixSubmissionId: previous.submissionId } : {};
  const reusable = contract.findings.every(finding => {
    const row = result.findings.find(row => row.threadId === finding.threadId);
    return row.disposition === "fixed" ? fixes.includes(finding.threadId) || verifiedDescriptionFix(previous, row, pr)
      : verifiedDescriptionAnswer(previous, row, pr);
  });
  return reusable ? { ...contract, ...proof, descriptionBaseline: previous.descriptionBaseline,
    previousAnswerSubmissionId: previous.submissionId } : fixes.length ? { ...contract, ...proof } : contract;
}

export function validateReviewResult(contract, result, pr, threads, builds = []) {
  return reviewResult(contract, result, pr, threads, builds);
}

function reviewResult(contract, result, pr, threads, builds = [], pending = false) {
  const text = (value) => typeof value === "string" && value.trim().length > 0;
  const resolved = thread => thread?.status === "fixed" ||
    (pending && ["active", "pending"].includes(thread?.status));
  if (!result || result.submissionId !== contract.submissionId || result.head !== pr.sourceCommit) {
    return { ok: false, reason: "Missing or stale review result/head" };
  }
  if (contract.version >= 2 && result.fingerprint !== contract.fingerprint) return { ok: false, reason: "Result omits newer feedback on this work item" };
  if (contract.repair) {
    const evidence = Array.isArray(result.repair?.evidence)
      ? result.repair.evidence : [result.repair?.evidence];
    const verifications = Array.isArray(result.repair?.verification)
      ? result.repair.verification : [result.repair?.verification];
    if (!evidence.length || evidence.some(value => !text(value)) || !verifications.length || verifications.some(verification =>
      !text(verification?.command) || !text(verification?.expected) || !text(verification?.actual))) {
      return { ok: false, reason: "PR repair lacks scoped verification evidence" };
    }
    if (contract.repair.type === "conflict" && pr.mergeStatus !== "succeeded") return { ok: false, reason: "PR merge conflict is not resolved" };
    if (contract.repair.type === "build" && buildSummary(builds).state !== "passed" &&
        !(pending && buildSummary(builds).state === "running"))
      return { ok: false, reason: "Current PR build policies have not passed" };
  }
  if (!Array.isArray(result.findings) || result.findings.length !== contract.findings.length) {
    return { ok: false, reason: "Every triggering finding requires exactly one disposition" };
  }
  if (contract.responseMode === "pr_thread" && (!Array.isArray(contract.replyThreadIds) ||
      contract.replyThreadIds.some(id => !contract.findings.some(finding => finding.threadId === id)))) {
    return { ok: false, reason: "Missing or invalid human-thread reply contract" };
  }
  const seen = new Set();
  for (const finding of contract.findings) {
    const rows = result.findings.filter((row) => row && row.threadId === finding.threadId);
    const row = rows[0];
    if (rows.length !== 1 || seen.has(row.threadId)) return { ok: false, reason: `Duplicate/missing disposition for ${finding.threadId}` };
    seen.add(row.threadId);
    if (!text(row.evidence) || !text(row.verification?.command)
      || !text(row.verification?.expected) || !text(row.verification?.actual)) {
      return { ok: false, reason: `Finding ${finding.threadId} lacks reproduction evidence` };
    }
    if (row.disposition === "blocked") return { ok: false, reason: `Finding ${finding.threadId} blocked: ${row.owner || "missing owner"}; ${row.evidence}` };
    if (requiresThreadReply(contract, row) &&
        !verifiedThreadReply(contract, row, pr, threads.find(thread => String(thread.id) === finding.threadId))) {
      return { ok: false, reason: `Finding ${finding.threadId} has no verified reply on its review thread` };
    }
    if (row.disposition === "fixed") {
      const thread = threads.find((value) => String(value.id) === finding.threadId);
      if (!thread || thread.isDeleted || !resolved(thread) ||
          (descriptionReviewFinding(finding) ? !verifiedDescriptionFix(contract, row, pr)
            : pr.sourceCommit === reviewFixBaseline(contract, finding.threadId))) {
        return { ok: false, reason: `Finding ${finding.threadId} has no pushed and resolved fix` };
      }
    } else if (row.disposition === "answered" || row.disposition === "disproved") {
      const thread = threads.find(value => String(value.id) === finding.threadId);
      if (!thread || thread.isDeleted || !resolved(thread)) {
        return { ok: false, reason: `Finding ${finding.threadId} was ${row.disposition} but its thread is still unresolved` };
      }
      if (contract.responseMode === "pr_description") {
        if (!verifiedDescriptionAnswer(contract, row, pr)) {
          return { ok: false, reason: `Finding ${finding.threadId} has no verified new PR-description evidence` };
        }
        continue;
      }
      if (contract.responseMode === "pr_thread") continue;
      if (row.disposition === "disproved") continue;
      const reply = thread?.comments?.find((comment) => String(comment.id) === String(row.responseCommentId));
      if (!reply || reply.isDeleted || !text(reply.content) || !pr.author ||
          reply.author?.uniqueName?.toLowerCase() !== pr.author.toLowerCase() ||
          !(Date.parse(reply.publishedDate || reply.lastUpdatedDate) >= Date.parse(contract.at))) {
        return { ok: false, reason: `Finding ${finding.threadId} has no new verified clarification reply` };
      }
    } else {
      return { ok: false, reason: `Invalid disposition for ${finding.threadId}` };
    }
  }
  return { ok: true, reason: "Every triggering finding has a verified disposition" };
}
