import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { writeJsonAtomic } from "../pr-updater/lib/state.mjs";
import { getPullRequest, listThreads, listBuilds } from "../pr-updater/lib/azure-devops.mjs";
import { buildSummary } from "../pr-updater/lib/merge-readiness.mjs";
import { isHumanComment, isOpenThread } from "../pr-updater/lib/review-trigger.mjs";
import * as telemetry from "../pr-updater/lib/telemetry.mjs";
import { assertPreparationCapacity, isCapacityError } from "../../packages/bohemia-pr-mcp/src/preparation-capacity.mjs";
import { preparationEvidence } from "./preparation-evidence.mjs";
import { preparationProcessAlive } from "../../packages/bohemia-pr-mcp/src/preparation-process.mjs";

const FINISHED = new Set(["succeeded", "failed", "cancelled", "timed_out", "expired"]);
const STOPPED = new Set(["paused", "disabled", "error", "terminated", "pending_approval"]);

// Paperclip's markdown validator expands literal \n/\r, even inside JSON strings.
export function serializePaperclipJson(value) {
  return JSON.stringify(value, null, 2).replace(/\\(\\|n|r)/g, (_, escaped) =>
    escaped === "\\" ? "\\u005c" : escaped === "n" ? "\\u000a" : "\\u000d");
}

export async function paperclipJson(config, route, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${config.paperclipApiUrl}/api${route}`, {
    signal: AbortSignal.timeout(15_000),
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  if (!response.ok) throw new Error(`Paperclip ${options.method || "GET"} ${route}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function root(config) {
  if (!config.creatorStateDirectory) throw new Error("creatorStateDirectory must be shared by all PR dispatchers");
  return path.resolve(config.creatorStateDirectory);
}

function prKey(config, pr) {
  return `${config.paperclipCompanyId}:${config.organization}:${config.project}:${config.repository}:${pr.id}`.toLowerCase();
}

function recordFile(config, pr) {
  return path.join(root(config), `${createHash("sha256").update(prKey(config, pr)).digest("hex")}.json`);
}

function matchesEvidence(record, pr, verdict) {
  return record && verdict &&
    record.state !== "capacity_held" &&
    !(record.state === "preparation_blocked" && isCapacityError({ message: record.reason })) &&
    (record.state === "completed" ? record.resultHead || record.head : record.head) === pr.sourceCommit &&
    record.fingerprint === verdict.fingerprint;
}

async function ownershipEvidence(config, pr) {
  const registry = await readJson(config.creatorProvenanceFile || new URL("../pr-creator-provenance.json", import.meta.url), { version: 1, records: [] });
  return createHash("sha256").update(JSON.stringify([
    registry.records.filter((record) => record.companyId === config.paperclipCompanyId && productMatchesPr({ type: "pull_request", url: record.prUrl }, pr)),
    config.creatorBindings?.[pr.id] || null,
  ])).digest("hex");
}

async function holdStillApplies(config, record, pr, verdict, fetchImpl = fetch) {
  if (!matchesEvidence(record, pr, verdict)) return false;
  if (record.state === "ownership_held") {
    if (record.ownershipEvidence) return record.ownershipEvidence === await ownershipEvidence(config, pr);
    const issue = await paperclipJson(config, `/issues/${record.issueId}`, {}, fetchImpl);
    return !!(issue.assigneeUserId || issue.executionState?.currentStageId);
  }
  if (record.state === "preparation_blocked") {
    if ((record.preparationAttempts || 0) >= 3) return true;
    return record.preparationEvidence === await preparationEvidence(config, record.cwd);
  }
  return true;
}

export async function applyCreatorReviewOutcomes(config, surveyed) {
  const held = await Promise.all(surveyed.map(async (entry) => {
    if (!entry.verdict || (config.shard && Number(entry.pr.id) % config.shard.total !== config.shard.index)) return null;
    const record = await readJson(recordFile(config, entry.pr), null);
    if (!await holdStillApplies(config, record, entry.pr, entry.verdict) ||
        !["completed", "blocked", "preparation_blocked", "ownership_held"].includes(record.state)) return null;
    entry.send = null;
    entry.holdingReason = record.state === "completed"
      ? "Feedback update completed; awaiting new feedback"
      : `Update blocked: ${record.reason}`;
    return record.state === "completed" ? null : `PR ${entry.pr.id}: ${entry.holdingReason}`;
  }));
  return held.filter(Boolean);
}

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

export async function resolveCreator(config, pr, fetchImpl = fetch) {
  const get = (route) => paperclipJson(config, route, {}, fetchImpl);
  const registry = await readJson(config.creatorProvenanceFile || new URL("../pr-creator-provenance.json", import.meta.url), { version: 1, records: [] });
  if (registry.version !== 1 || !Array.isArray(registry.records)) throw new Error("Invalid original PR provenance registry");
  const bindings = registry.records.filter((record) => record.companyId === config.paperclipCompanyId &&
    productMatchesPr({ type: "pull_request", url: record.prUrl }, pr));
  if (bindings.length > 1) throw new Error(`PR ${pr.id}: ambiguous verified original ownership`);
  const explicit = bindings[0] || config.creatorBindings?.[pr.id];
  if (explicit?.originKind === "copilot_cli") {
    throw Object.assign(new Error(`PR ${pr.id} was created in external Copilot CLI session ${explicit.sourceSessionId}; no original Paperclip task exists`), { code: "CREATOR_OWNERSHIP_UNVERIFIED" });
  }
  let issue;
  let run;
  if (explicit) {
    if (!explicit.issueId || !explicit.creationRunId || explicit.branch !== pr.branch) {
      throw new Error(`PR ${pr.id}: incomplete or mismatched verified creator binding`);
    }
    [issue, run] = await Promise.all([
      get(`/issues/${explicit.issueId}`), get(`/heartbeat-runs/${explicit.creationRunId}`),
    ]);
  } else {
    // Search is only candidate discovery. Incidental mentions never establish ownership.
    const candidates = await get(`/companies/${config.paperclipCompanyId}/issues?q=${encodeURIComponent(pr.id)}`);
    if (!Array.isArray(candidates)) throw new Error("Paperclip returned an invalid issue list");
    const matches = [];
    for (const candidate of candidates) {
      const products = await get(`/issues/${candidate.id}/work-products`);
      for (const product of products) {
        if (productMatchesPr(product, pr) && product.createdByRunId) {
          matches.push({ issue: candidate, runId: product.createdByRunId });
        }
      }
    }
    const issueIds = new Set(matches.map((match) => match.issue.id));
    if (issueIds.size !== 1) throw Object.assign(new Error(`PR ${pr.id}: expected one exact originating issue, found ${issueIds.size}; verified binding required`), { code: "CREATOR_OWNERSHIP_UNVERIFIED" });
    if (new Set(matches.map((match) => match.runId)).size !== 1) throw Object.assign(new Error(`PR ${pr.id}: multiple creation runs require a verified binding`), { code: "CREATOR_OWNERSHIP_UNVERIFIED" });
    const first = matches[0];
    [issue, run] = await Promise.all([get(`/issues/${first.issue.id}`), get(`/heartbeat-runs/${first.runId}`)]);
  }
  if (issue.companyId !== config.paperclipCompanyId || run.companyId !== config.paperclipCompanyId
    || run.contextSnapshot?.issueId !== issue.id || !run.agentId ||
    (explicit?.agentId && run.agentId !== explicit.agentId)) {
    throw new Error(`PR ${pr.id}: creation run is not owned by the originating issue/company`);
  }
  const agent = await get(`/agents/${run.agentId}`);
  if (agent.companyId !== config.paperclipCompanyId || STOPPED.has(agent.status)) {
    throw new Error(`PR ${pr.id}: creator ${agent.name || agent.id} is not invokable`);
  }
  if (/^pr[\s-]*updater/i.test(agent.name || "")) throw new Error(`PR ${pr.id}: legacy updater is not an original creator; ownership recovery required`);
  return { issue, agent, creationRunId: run.id };
}

export function creatorCheckout(config, issue, pr) {
  if (config.creatorWorkspaces?.[pr.id]) return config.creatorWorkspaces[pr.id];
  if (!config.creatorWorkspaceRoot || !path.isAbsolute(config.creatorWorkspaceRoot)) throw new Error("creatorWorkspaceRoot must name the shared issue-checkout directory");
  if (![config.paperclipCompanyId, issue.id].every((value) => typeof value === "string" && /^[a-z0-9-]+$/i.test(value))) {
    throw new Error("Invalid company or issue identity for a dedicated checkout");
  }
  return path.join(config.creatorWorkspaceRoot, config.paperclipCompanyId, issue.id);
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

export async function readReviewProcedure() {
  const procedure = await readFile(new URL("../pr-updater/review-mode.md", import.meta.url), "utf8");
  if (!procedure.trim()) throw new Error("Canonical PRUpdater review procedure is empty; handoff refused");
  return procedure;
}

export function reviewPrompt(contract, procedure, { transport = "paperclip", roleInstructions } = {}) {
  if (!["paperclip", "spool"].includes(transport)) throw new Error("Unknown PR update delivery transport");
  if (typeof procedure !== "string" || !procedure.trim()) throw new Error("Canonical PRUpdater review procedure is required");
  const spool = transport === "spool";
  const resolver = fileURLToPath(new URL("../pr-updater/resolve-thread.mjs", import.meta.url));
  return [
    "# PR update mode",
    "Continue only this work item's PR. These review instructions apply to this run, not your other assignments.",
    "You are the original implementation owner. Do not delegate this revision to PRUpdater, another agent, or a new issue. Continue on this same work item.",
    `Executing agent: ${contract.agentName || contract.agent || contract.agentId}. Preserve this creator's identity and session.`,
    `Issue: ${contract.identifier}; PR: ${contract.prId}; branch: ${contract.branch}; reviewed head: ${contract.head}.`,
    `Prepared checkout: ${contract.cwd}. Use this path, not a standing prompt's default checkout.`,
    "The runner owns setup. Do not switch/reset branches, create worktrees, or install dependencies.",
    "COMMIT_MESSAGE_POLICY is recoverable message validation: remove prohibited attribution/session footer lines and retry the commit with the hook enabled. Do not weaken policy or request an exception to follow it. If CLI defaults reintroduce metadata, report the runner configuration defect rather than asking to relax repository policy.",
    contract.workspaceHead && contract.workspaceHead !== contract.head
      ? `The checkout preserves an unpushed continuation at ${contract.workspaceHead}. Inspect and validate that existing commit before adding changes; do not discard or duplicate it. Earlier run evidence remains on this issue.`
      : "",
    "Resume this issue's conversation if available. A fresh session is a recovery, not restored context.",
    "Earlier completion summaries do not dispose of the outstanding findings below.",
    procedure,
    roleInstructions ? `## Current creator instructions\n\n${roleInstructions}` : "",
    `Guarded thread resolver: node "${resolver}" <prId> <pushedCommit> <threadId>. This changes thread status only; never post PR comments or replies.`,
    `For a published clarification answer, save the exact contract and PR_UPDATE_RESULT JSON to local files, then run node "${resolver}" <prId> --answer <contract.json> <result.json> <threadId>. This verifies the unchanged feedback, published description evidence and resolution without requiring a manufactured code commit.`,
    contract.repair ? `Also repair ${contract.repair.type}: ${contract.repair.reason}. Include a top-level repair result with evidence and verification.command/expected/actual. Do not create a new task or PR.` : "",
    "",
    "## Exact review contract",
    !spool && contract.documentKey
      ? `Read GET /api/issues/${contract.issueId}/documents/${contract.documentKey} before touching code. Its JSON body contains the full, untruncated finding text. Require submissionId ${contract.submissionId}; do not use an older revision.`
      : JSON.stringify(contract, null, 2),
    "",
    spool
      ? contract.resultFile
        ? `Before finishing, use JSON.stringify to write ONLY the following result object to "${contract.resultFile}". Then call spool_add_comment with exactly "PR_UPDATE_RESULT_FILE: ${contract.submissionId}". This local artifact transport preserves Windows paths and newlines without nesting JSON in a comment. Never hand-inline the result JSON into the comment.`
        : "Before finishing, call spool_add_comment with PR_UPDATE_RESULT: followed by ONLY one JSON object. This is local work-item history, not a PR comment:"
      : "Before finishing, PUT the issue document `pr-update-result` with format `markdown` and body containing ONLY a JSON object:",
    '{"submissionId":"<exact submissionId>","fingerprint":"<current contract fingerprint>","head":"<current pushed full SHA>","findings":[{"threadId":"<id>","disposition":"fixed|disproved|answered|blocked","evidence":"<concrete explanation>","verification":{"command":"<executed targeted reproduction>","expected":"<expected behavior>","actual":"<observed behavior>"},"descriptionEvidence":"<exact new PR-description excerpt required for answered>","owner":"<required if blocked>"}]}',
    spool
      ? "Call spool_get_task again before publishing and require the current submissionId and fingerprint. Put additional prose in a separate local task comment; do not mix prose into PR_UPDATE_RESULT JSON."
      : "Read the current contract again before publishing. New feedback can extend this same submission; the result fingerprint must match its latest fingerprint.",
    !spool ? "Read the existing result document for baseRevisionId before updating it. Include X-Paperclip-Run-Id on writes." : "",
    !spool && contract.resultPublisher
      ? `Publish safely using the runner helper: write valid result JSON to a local file, then run node "${contract.resultPublisher}" "<result-file>". It preserves JSON newlines and Windows paths, checks the submission, supplies run-scoped authentication and verifies the stored document. Do not hand-inline JSON into a shell command.`
      : "",
    "Fixed requires a pushed change and the thread resolved through the guarded resolver. Disproved requires an actual reproduction, not green unrelated tests.",
    "Never post PR comments or reply to PR threads. Answer clarification/evidence questions by updating the PR description with concrete reproduction/measurement evidence through bohemia_pr with action=update. For answered, include descriptionEvidence as an exact new excerpt from the updated description that was absent from the contract's descriptionBaseline. Answered is not valid for a confirmed defect. Do not manufacture code changes just to answer a question.",
    "An unresolved confirmed defect, missing validation, or refused resolution is blocked, never done. Name the repair owner and action.",
    "Mark done only when every finding is fixed, disproved, or answered with the required evidence. The runner independently checks this contract.",
    "Done means this feedback update is complete, not that the PR merged. The feedback watcher reopens this same item for new comments; do not schedule another PR monitor. Preserve any explicitly assigned human or typed approval path.",
    spool
      ? "Use spool_update_task_status completed only after publishing the required result for every finding and repair. If blocked, use status failed with the exact cause. Do not reassign the work item. No Paperclip API calls are needed; PR comments are prohibited."
      : "Post at most one concise Paperclip update with new evidence. PR comments are prohibited.",
  ].join("\n\n");
}

export function reviewIssueDescription(contract) {
  const prefix = contract.identifier.split("-")[0];
  return [
    `# Current work: update existing PR ${contract.prId}`,
    `Continue [${contract.identifier}](/${prefix}/issues/${contract.identifier}) as ${contract.agentName}. Do not implement the original feature again or create another PR/task.`,
    `PR: ${contract.url}\nBranch: ${contract.branch}\nPrepared checkout: ${contract.cwd}`,
    `Address the outstanding feedback in [the current review contract](/${prefix}/issues/${contract.identifier}#document-pr-review-contract). Read that document before touching code; it contains the exact findings and head.`,
    "You own this revision. Do not delegate to PRUpdater or another agent. The runner owns checkout/dependencies; use the prepared workspace.",
    `The [original implementation brief](/${prefix}/issues/${contract.identifier}#document-pr-original-brief) is preserved as lossless JSON, along with the existing comments and run history.`,
    "Record the actual repair or clarification evidence on this same item and update the existing PR. Never post a generic no-op reply.",
  ].join("\n\n");
}

export function verifiedReviewCoverage(contract, result, pr, threads, builds, findings) {
  if (!contract || !findings.length || !validateReviewResult(contract, result, pr, threads, builds).ok) return false;
  return findings.every(finding => contract.findings.some(previous => isDeepStrictEqual(previous, finding)));
}

export function verifiedDescriptionAnswer(contract, row, pr) {
  return contract.responseMode === "pr_description" && ["answered", "disproved"].includes(row?.disposition)
    && typeof contract.descriptionBaseline === "string" && typeof pr.description === "string"
    && typeof row.descriptionEvidence === "string" && row.descriptionEvidence.trim().length > 0
    && pr.description.includes(row.descriptionEvidence)
    && !contract.descriptionBaseline.includes(row.descriptionEvidence);
}

export function reuseDescriptionAnswerBaseline(contract, previous, result, pr) {
  if (!previous || !result || result.submissionId !== previous.submissionId ||
      result.fingerprint !== previous.fingerprint || result.head !== pr.sourceCommit ||
      previous.prId !== contract.prId || previous.branch !== contract.branch || !contract.findings.length) return contract;
  const reusable = contract.findings.every(finding =>
    isDeepStrictEqual(finding, previous.findings.find(old => old.threadId === finding.threadId))
    && verifiedDescriptionAnswer(previous, result.findings?.find(row => row.threadId === finding.threadId), pr));
  return reusable ? { ...contract, descriptionBaseline: previous.descriptionBaseline,
    previousAnswerSubmissionId: previous.submissionId } : contract;
}

export function validateReviewResult(contract, result, pr, threads, builds = []) {
  const text = (value) => typeof value === "string" && value.trim().length > 0;
  if (!result || result.submissionId !== contract.submissionId || result.head !== pr.sourceCommit) {
    return { ok: false, reason: "Missing or stale review result/head" };
  }
  if (contract.version >= 2 && result.fingerprint !== contract.fingerprint) return { ok: false, reason: "Result omits newer feedback on this work item" };
  if (contract.repair) {
    if (!text(result.repair?.evidence) || !text(result.repair?.verification?.command) ||
        !text(result.repair?.verification?.expected) || !text(result.repair?.verification?.actual)) {
      return { ok: false, reason: "PR repair lacks scoped verification evidence" };
    }
    if (contract.repair.type === "conflict" && pr.mergeStatus !== "succeeded") return { ok: false, reason: "PR merge conflict is not resolved" };
    if (contract.repair.type === "build" && buildSummary(builds).state !== "passed") return { ok: false, reason: "Current PR build policies have not passed" };
  }
  if (!Array.isArray(result.findings) || result.findings.length !== contract.findings.length) {
    return { ok: false, reason: "Every triggering finding requires exactly one disposition" };
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
    if (row.disposition === "fixed") {
      const thread = threads.find((value) => String(value.id) === finding.threadId);
      if (!thread || thread.isDeleted || thread.status !== "fixed" || pr.sourceCommit === contract.head) {
        return { ok: false, reason: `Finding ${finding.threadId} has no pushed and resolved fix` };
      }
    } else if (row.disposition === "answered" || row.disposition === "disproved") {
      const thread = threads.find(value => String(value.id) === finding.threadId);
      if (!thread || thread.isDeleted || thread.status !== "fixed") {
        return { ok: false, reason: `Finding ${finding.threadId} was ${row.disposition} but its thread is still unresolved` };
      }
      if (contract.responseMode === "pr_description") {
        if (!verifiedDescriptionAnswer(contract, row, pr)) {
          return { ok: false, reason: `Finding ${finding.threadId} has no verified new PR-description evidence` };
        }
        continue;
      }
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

async function lock(config, key, recoverDeadOwner = false) {
  const directory = path.join(root(config), `${createHash("sha256").update(key.toLowerCase()).digest("hex")}.lock`);
  await mkdir(root(config), { recursive: true });
  try { await mkdir(directory); }
  catch (error) {
    if (error.code === "EEXIST") {
      if (recoverDeadOwner) {
        const guard = `${directory}.reclaim`;
        let guarded = false;
        try { await mkdir(guard); guarded = true; }
        catch (guardError) { if (guardError.code !== "EEXIST") throw guardError; }
        if (guarded) {
          try {
            const owner = await readJson(path.join(directory, "owner.json"), null);
            if (owner?.key?.toLowerCase() === key.toLowerCase() && !preparationProcessAlive(owner.pid)) {
              await rm(directory, { recursive: true });
              await mkdir(directory);
              await writeFile(path.join(directory, "owner.json"), JSON.stringify({ key, pid: process.pid, at: new Date().toISOString() }));
              return async () => rm(directory, { recursive: true });
            }
          } finally { await rm(guard, { recursive: true }); }
        }
      }
      const busy = new Error(`Creator review resource is leased: ${key}`);
      busy.code = "CREATOR_RESOURCE_BUSY";
      throw busy;
    }
    throw error;
  }
  try { await writeFile(path.join(directory, "owner.json"), JSON.stringify({ key, pid: process.pid, at: new Date().toISOString() })); }
  catch (error) { await rm(directory, { recursive: true }); throw error; }
  return async () => rm(directory, { recursive: true });
}

async function releaseResources(config, record) {
  for (const key of [`workspace:${path.resolve(record.cwd)}`, `issue:${config.paperclipCompanyId}:${record.issueId}`]) {
    const directory = path.join(root(config), `${createHash("sha256").update(key.toLowerCase()).digest("hex")}.lock`);
    try { await rm(directory, { recursive: true }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

async function assertIdleIssue(config, issue, fetchImpl) {
  const runs = await paperclipJson(config, `/issues/${issue.id}/runs`, {}, fetchImpl);
  if (issue.activeRun || runs.some((run) => !FINISHED.has(run.status))) {
    throw new Error(`Issue ${issue.identifier} already has active or queued execution; feedback remains pending`);
  }
}

export async function trackCreatorRecovery({ config, prId, runId, fetchImpl = fetch }) {
  const releasePr = await lock(config, prKey(config, { id: prId }), true);
  let releaseIssue;
  let releaseWorkspace;
  let tracked = false;
  try {
    const file = recordFile(config, { id: prId });
    const record = await readJson(file, null);
    if (!record || record.state !== "blocked" || !record.leasesReleased) {
      throw new Error("Recovery requires a settled blocked original-item review");
    }
    const run = await paperclipJson(config, `/heartbeat-runs/${runId}`, {}, fetchImpl);
    if (run.contextSnapshot?.issueId !== record.issueId || run.agentId !== record.agentId ||
        !["running", "queued"].includes(run.status)) {
      throw new Error("Recovery must track a live run of the same original issue and agent");
    }
    releaseIssue = await lock(config, `issue:${config.paperclipCompanyId}:${record.issueId}`);
    releaseWorkspace = await lock(config, `workspace:${path.resolve(record.cwd)}`);
    const at = new Date().toISOString();
    const telemetryJobId = `${record.submissionId}:recovery:${runId}`;
    const updated = {
      ...record, state: "dispatched", leasesReleased: false, resumeRunId: runId, resumedAt: at, telemetryJobId,
      previousCompletion: { state: record.state, reason: record.reason, completedAt: record.completedAt },
      reason: null, completedAt: null,
    };
    await writeJsonAtomic(file, updated);
    tracked = true;
    telemetry.jobQueued(record.telemetryFile, {
      jobId: telemetryJobId, prId: record.prId, prUrl: record.url, trigger: record.repair?.type || "review",
      reason: `Explicit recovery of ${record.identifier}`, at,
      issueId: record.issueId, identifier: record.identifier, agentId: record.agentId, agent: record.agentName,
    });
    telemetry.jobDispatched(record.telemetryFile, {
      jobId: telemetryJobId, at, agent: record.agentName, agentId: record.agentId,
      issueId: record.issueId, identifier: record.identifier, creatorOwned: true,
      submissionId: record.submissionId,
    });
    return updated;
  } finally {
    if (!tracked) {
      if (releaseWorkspace) await releaseWorkspace();
      if (releaseIssue) await releaseIssue();
    }
    await releasePr();
  }
}

export async function runCreatorJob({ config, pr, verdict, now, prepare, log, fetchImpl = fetch, ado = { getPullRequest, listThreads } }) {
  const releasePr = await lock(config, prKey(config, pr), true);
  let releaseWorkspace;
  let releaseIssue;
  let handedOff = false;
  let releasePreparation;
  let dispatchAttempted = false;
  let jobId;
  let preparationRecord;
  try {
    const file = recordFile(config, pr);
    const prior = await readJson(file, null);
    if (prior?.state === "dispatched" || prior?.state === "dispatching") {
      if (prior.state === "dispatched" && prior.fingerprint !== verdict.fingerprint) {
        const currentIssue = await paperclipJson(config, `/issues/${prior.issueId}`, {}, fetchImpl);
        if (currentIssue.assigneeAgentId !== prior.agentId) throw new Error("Original item has changed assignee; preserve active work and recover ownership before delivering feedback");
        const findings = reviewFindings(await ado.listThreads(config, pr.id, { refresh: true }), config);
        if (!findings.length) return { dispatched: false, skipped: true, reason: "No actionable review findings remain" };
        const merged = new Map(prior.findings.map((finding) => [finding.threadId, finding]));
        for (const finding of findings) merged.set(finding.threadId, finding);
        const updatedContract = { ...prior, findings: [...merged.values()], fingerprint: verdict.fingerprint };
        const documentPath = `/issues/${prior.issueId}/documents/${prior.documentKey}`;
        const previousDocument = await paperclipJson(config, documentPath, {}, fetchImpl);
        const body = serializePaperclipJson(updatedContract);
        const saved = await paperclipJson(config, documentPath, {
          method: "PUT", body: JSON.stringify({ title: `PR ${pr.id} review contract`, format: "markdown", body, baseRevisionId: previousDocument.latestRevisionId }),
        }, fetchImpl);
        if (saved.body !== body) throw new Error("Updated review contract was not confirmed");
        const updated = await paperclipJson(config, `/issues/${prior.issueId}`, {
          method: "PATCH", body: JSON.stringify({
            ...(["done", "cancelled"].includes(currentIssue.status) ? { status: "todo" } : {}),
            comment: `Additional PR feedback on this same work item. Do not delegate to PRUpdater or create a competing assignment.\n\nRead the updated pr-review-contract document; submission ${prior.submissionId}, fingerprint ${verdict.fingerprint}.\n\n${findings.flatMap((finding) => finding.comments.map((comment) => `${comment.author}: ${comment.body}`)).join("\n\n")}`,
          }),
        }, fetchImpl);
        if (updated.id !== prior.issueId) throw new Error("Additional feedback delivery was not confirmed");
        await writeJsonAtomic(file, updatedContract);
        await log("creator_feedback_queued", { pr: pr.id, issue: prior.identifier, agent: prior.agentName });
        return { dispatched: false, skipped: true, feedbackQueued: true, reason: `Additional feedback delivered to ${prior.identifier}` };
      }
      return { dispatched: false, skipped: true, reason: `PR ${pr.id} has a live or unconfirmed handoff` };
    }
    if (await holdStillApplies(config, prior, pr, verdict, fetchImpl)) {
      return {
        dispatched: false, skipped: true, settled: prior.state === "completed",
        reason: `Same evidence already ${prior.state}: ${prior.reason || "explicit recovery or new evidence required"}`,
      };
    }
    const { issue, agent, creationRunId } = await resolveCreator(config, pr, fetchImpl);
    if (issue.assigneeUserId || issue.executionState?.currentStageId) {
      await writeJsonAtomic(file, {
        prId: String(pr.id), head: pr.sourceCommit, fingerprint: verdict.fingerprint,
        state: "ownership_held", issueId: issue.id, identifier: issue.identifier, leasesReleased: true,
        reason: "Original work item is assigned to a human or explicit review stage; preserving that ownership",
      });
      return { dispatched: false, skipped: true, reason: "Original work item awaits its assigned reviewer" };
    }
    releaseIssue = await lock(config, `issue:${config.paperclipCompanyId}:${issue.id}`);
    await assertIdleIssue(config, issue, fetchImpl);
    const cwd = creatorCheckout(config, issue, pr);
    if (!cwd || !path.isAbsolute(cwd)) throw new Error(`PR ${pr.id}: no dedicated prepared-workspace assignment`);
    if (Object.values(config.creatorWorkspaces || {}).filter((value) => path.resolve(value).toLowerCase() === path.resolve(cwd).toLowerCase()).length > 1) {
      throw new Error(`PR ${pr.id}: checkout is assigned to multiple PRs`);
    }
    if (!agent.adapterConfig?.cwd || path.resolve(agent.adapterConfig.cwd).toLowerCase() === path.resolve(cwd).toLowerCase()) {
      throw new Error("Review checkout must not be the creator's shared implementation checkout");
    }
    releaseWorkspace = await lock(config, `workspace:${path.resolve(cwd)}`);
    const current = await ado.getPullRequest(config, pr.id, { refresh: true });
    if (current.status !== "active" || current.branch !== pr.branch || current.sourceCommit !== pr.sourceCommit) {
      throw new Error(`PR ${pr.id} changed before preparation; survey again`);
    }
    const threads = await ado.listThreads(config, pr.id, { refresh: true });
    const findings = reviewFindings(threads, config);
    if (!["review", "agency", "build", "conflict"].includes(verdict.trigger)) {
      throw new Error(`Unsupported PR update trigger: ${verdict.trigger}`);
    }
    const repair = ["build", "conflict"].includes(verdict.trigger) ? { type: verdict.trigger, reason: verdict.reason } : null;
    if (!findings.length && !repair) return { dispatched: false, skipped: true, reason: "No actionable review findings remain" };
    if (config.creatorMinimumFreeGiB !== undefined) {
      releasePreparation = await lock(config, `preparation:${path.parse(path.resolve(cwd)).root}`);
      assertPreparationCapacity(config, cwd);
    }
    jobId = `creator:${pr.id}:${createHash("sha256").update(`${pr.sourceCommit}:${verdict.fingerprint}`).digest("hex").slice(0, 20)}:${randomUUID()}`;
    preparationRecord = {
      submissionId: jobId, prId: String(pr.id), head: pr.sourceCommit, fingerprint: verdict.fingerprint,
      issueId: issue.id, identifier: issue.identifier, agentId: agent.id, agentName: agent.name,
      cwd, branch: pr.branch, telemetryFile: config.telemetryFile, at: now,
      preparationAttempts: (matchesEvidence(prior, pr, verdict) ? prior.preparationAttempts || 0 : 0) + 1,
    };
    telemetry.jobQueued(config.telemetryFile, {
      jobId, prId: pr.id, prUrl: pr.url, trigger: verdict.trigger, reason: verdict.reason, at: now,
      issueId: issue.id, identifier: issue.identifier, agentId: agent.id, agent: agent.name,
    });
    telemetry.jobStarted(config.telemetryFile, { jobId, at: new Date().toISOString() });
    await writeJsonAtomic(file, { ...preparationRecord, state: "preparing", preparingPid: process.pid });
    const prepared = await prepare({ config: {
      ...config, repoRoot: cwd, creatorWorkspaceSeed: config.creatorWorkspaceSeed || config.repoRoot,
      preservePreparedBranch: true, preserveUnpushedCommits: true,
      preparationCheckpoint: async (stage) => {
        preparationRecord.preparationStage = stage;
        await writeJsonAtomic(file, { ...preparationRecord, state: "preparing", preparingPid: process.pid });
      },
    }, pr, verdict });
    if (releasePreparation) {
      await releasePreparation();
      releasePreparation = null;
    }
    telemetry.jobPrepared(config.telemetryFile, { jobId, at: new Date().toISOString(), ms: prepared.ms, steps: prepared.steps, branch: pr.branch });
    const preparedPr = await ado.getPullRequest(config, pr.id, { refresh: true });
    if (preparedPr.status !== "active" || preparedPr.branch !== pr.branch || preparedPr.sourceCommit !== pr.sourceCommit) {
      throw new Error(`PR ${pr.id} changed during preparation; refusing stale handoff`);
    }
    const freshIssue = await paperclipJson(config, `/issues/${issue.id}`, {}, fetchImpl);
    await assertIdleIssue(config, freshIssue, fetchImpl);
    const projectId = issue.projectId || config.paperclipProjectId;
    if (!projectId) throw new Error("Creator handoff requires a project");
    const workspaces = await paperclipJson(config, `/projects/${projectId}/workspaces`, {}, fetchImpl);
    let workspace = workspaces.find((entry) => entry.cwd && path.resolve(entry.cwd).toLowerCase() === path.resolve(cwd).toLowerCase());
    if (!workspace) {
      workspace = await paperclipJson(config, `/projects/${projectId}/workspaces`, {
        method: "POST", body: JSON.stringify({ name: `pr-${pr.id}`, sourceType: "local_path", cwd, isPrimary: false }),
      }, fetchImpl);
    }
    if (!workspace.id) throw new Error("Prepared workspace registration failed");
    const procedure = await readReviewProcedure();
    const contract = {
      version: 3, submissionId: jobId, prId: String(pr.id), url: pr.url, head: pr.sourceCommit,
      responseMode: "pr_description", descriptionBaseline: preparedPr.description || "",
      companyId: config.paperclipCompanyId, at: new Date().toISOString(),
      trigger: verdict.trigger, repair,
      branch: pr.branch, cwd, issueId: issue.id, identifier: issue.identifier, agentId: agent.id,
      creationRunId, fingerprint: verdict.fingerprint, findings, documentKey: "pr-review-contract",
      workspaceHead: prepared.commit || pr.sourceCommit, agentName: agent.name,
      resultPublisher: fileURLToPath(new URL("./publish-review-result.mjs", import.meta.url)),
    };
    const documents = await paperclipJson(config, `/issues/${issue.id}/documents`, {}, fetchImpl);
    if (!documents.some((document) => document.key === "pr-original-brief")) {
      const body = serializePaperclipJson({ description: freshIssue.description || "" });
      const saved = await paperclipJson(config, `/issues/${issue.id}/documents/pr-original-brief`, {
        method: "PUT", body: JSON.stringify({ title: "Original implementation brief (lossless JSON)", format: "markdown", body, baseRevisionId: null }),
      }, fetchImpl);
      if (saved.body !== body) throw new Error("Original implementation brief was not preserved");
    }
    const previousContract = documents.some((document) => document.key === contract.documentKey)
      ? await paperclipJson(config, `/issues/${issue.id}/documents/${contract.documentKey}`, {}, fetchImpl)
      : null;
    const savedContract = await paperclipJson(config, `/issues/${issue.id}/documents/${contract.documentKey}`, {
      method: "PUT", body: JSON.stringify({
        title: `PR ${pr.id} review contract`, format: "markdown",
        body: serializePaperclipJson(contract), baseRevisionId: previousContract?.latestRevisionId || null,
      }),
    }, fetchImpl);
    if (savedContract.body !== serializePaperclipJson(contract)) throw new Error("Review contract document was not confirmed");
    // Persist before the wake. An uncertain response is never retried as a new assignment.
    const record = { ...contract, state: "dispatching", at: new Date().toISOString(), telemetryFile: config.telemetryFile };
    await writeJsonAtomic(file, record);
    dispatchAttempted = true;
    const updated = await paperclipJson(config, `/issues/${issue.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        assigneeAgentId: agent.id, assigneeUserId: null, status: "todo",
        description: reviewIssueDescription(contract),
        projectId, projectWorkspaceId: workspace.id,
        executionWorkspaceId: freshIssue.assigneeAgentId === agent.id && freshIssue.projectWorkspaceId === workspace.id
          ? freshIssue.executionWorkspaceId || null : null,
        executionWorkspacePreference: "shared_workspace",
        executionWorkspaceSettings: { mode: "shared_workspace", sharedWorkspaceConcurrency: "serialize" },
        assigneeAdapterOverrides: {
          ...(freshIssue.assigneeAgentId === agent.id ? freshIssue.assigneeAdapterOverrides : {}), useProjectWorkspace: true,
          adapterConfig: {
            ...(freshIssue.assigneeAgentId === agent.id ? freshIssue.assigneeAdapterOverrides?.adapterConfig : {}),
            cwd, persistSession: true, exclusiveWorkspace: true,
          },
        },
        comment: reviewPrompt(contract, procedure),
      }),
    }, fetchImpl);
    if (updated.id !== issue.id || !["todo", "in_progress"].includes(updated.status)) throw new Error("Creator handoff was not confirmed");
    record.state = "dispatched";
    await writeJsonAtomic(file, record);
    handedOff = true;
    telemetry.jobDispatched(config.telemetryFile, {
      jobId, at: record.at, agent: agent.name, submissionId: jobId, body: `Creator-owned review on ${issue.identifier}`,
      creatorOwned: true, issueId: issue.id, identifier: issue.identifier, agentId: agent.id,
    });
    await log("creator_review_dispatched", { pr: pr.id, issue: issue.identifier, agent: agent.name, cwd });
    return { jobId, dispatched: true };
  } catch (error) {
    if (!jobId && error.code === "CREATOR_OWNERSHIP_UNVERIFIED") {
      await writeJsonAtomic(recordFile(config, pr), {
        prId: String(pr.id), head: pr.sourceCommit, fingerprint: verdict.fingerprint,
        state: "ownership_held", leasesReleased: true, reason: error.message,
        ownershipEvidence: await ownershipEvidence(config, pr), at: new Date().toISOString(),
      });
      await log("creator_ownership_held", { pr: pr.id, reason: error.message });
      return { dispatched: false, skipped: true, reason: error.message };
    }
    if (jobId && !dispatchAttempted) {
      telemetry.jobFailed(config.telemetryFile, { jobId, at: new Date().toISOString(), phase: "prepare", error });
      await writeJsonAtomic(recordFile(config, pr), {
        ...preparationRecord, state: isCapacityError(error) ? "capacity_held" : "preparation_blocked", reason: error.message, leasesReleased: true,
        preparationEvidence: await preparationEvidence(config, preparationRecord.cwd),
      });
      await log("creator_preparation_held", { pr: pr.id, issue: preparationRecord.identifier, reason: error.message });
      return { jobId, dispatched: false, skipped: true, reason: `Preparation blocked: ${error.message}` };
    }
    if (!dispatchAttempted && isCapacityError(error)) {
      await log("creator_capacity_held", { pr: pr.id, reason: error.message });
      return { dispatched: false, skipped: true, reason: error.message };
    }
    await log(dispatchAttempted ? "creator_handoff_unconfirmed" : "creator_review_refused", { pr: pr.id, error: error.message });
    throw error;
  } finally {
    if (releasePreparation) await releasePreparation();
    // The workspace lease survives process exit and is released only after Paperclip settles.
    if (!handedOff && !dispatchAttempted && releaseWorkspace) await releaseWorkspace();
    if (!handedOff && !dispatchAttempted && releaseIssue) await releaseIssue();
    await releasePr();
  }
}

export async function reconcileCreatorJobs({ config, log, fetchImpl = fetch, ado = { getPullRequest, listThreads, listBuilds } }) {
  if (config.telemetryFile) {
    for (const jobId of telemetry.reconcileSupersededPreparations(config.telemetryFile)) {
      await log("creator_preparation_reconciled", { jobId, reason: "Superseded exclusive preparation had no terminal record" });
    }
  }
  let files;
  try { files = await readdir(root(config)); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const name of files.filter((entry) => entry.endsWith(".json"))) {
    const file = path.join(root(config), name);
    const snapshot = await readJson(file, null);
    if (!snapshot || snapshot.leasesReleased) continue;
    const prId = snapshot.prId;
    if (!prId || file !== recordFile(config, { id: prId })) continue;
    let release;
    try { release = await lock(config, prKey(config, { id: prId }), true); }
    catch (error) {
      if (error.code !== "CREATOR_RESOURCE_BUSY") throw error;
      await log("creator_reconcile_busy", { pr: prId, reason: error.message });
      continue;
    }
    try {
      const record = await readJson(file, null);
      if (!record || record.leasesReleased) continue;
      if (record.state === "preparing") {
        if (preparationProcessAlive(record.preparingPid)) continue;
        const issue = await paperclipJson(config, `/issues/${record.issueId}`, {}, fetchImpl);
        const runs = await paperclipJson(config, `/issues/${record.issueId}/runs`, {}, fetchImpl);
        if (issue.activeRun || runs.some((run) => !FINISHED.has(run.status))) continue;
        for (const key of [
          `workspace:${path.resolve(record.cwd)}`, `issue:${config.paperclipCompanyId}:${record.issueId}`,
          `preparation:${path.parse(path.resolve(record.cwd)).root}`,
        ]) {
          const directory = path.join(root(config), `${createHash("sha256").update(key.toLowerCase()).digest("hex")}.lock`);
          const owner = await readJson(path.join(directory, "owner.json"), null);
          if (owner?.pid === record.preparingPid && owner.key.toLowerCase() === key.toLowerCase()) {
            await rm(directory, { recursive: true });
          } else if (owner && !key.startsWith("preparation:")) {
            throw new Error(`Interrupted preparation has a different live lease owner: ${key}`);
          }
        }
        record.state = "preparation_blocked";
        record.reason = `Preparation process ended during ${record.preparationStage?.stage || "provisioning"}; resume only after workspace preservation checks`;
        record.preparationEvidence = null;
        record.leasesReleased = true;
        await writeJsonAtomic(file, record);
        telemetry.jobFailed(record.telemetryFile, { jobId: record.submissionId, at: new Date().toISOString(), phase: "prepare", error: new Error(record.reason) });
        await log("creator_preparation_interrupted", { pr: prId, reason: record.reason });
        continue;
      }
      if (["completed", "blocked"].includes(record.state)) {
        await releaseResources(config, record);
        record.leasesReleased = true;
        await writeJsonAtomic(file, record);
        continue;
      }
      if (!["dispatched", "dispatching"].includes(record.state)) continue;
      const issue = await paperclipJson(config, `/issues/${record.issueId}`, {}, fetchImpl);
      const runs = await paperclipJson(config, `/issues/${record.issueId}/runs`, {}, fetchImpl);
      if (issue.activeRun || runs.some((run) => !FINISHED.has(run.status))) continue;
      const relevant = runs.filter((run) => run.agentId === record.agentId && Date.parse(run.startedAt) >= Date.parse(record.at));
      if (!relevant.length) continue;
      if (record.resumeRunId && !relevant.some((run) => (run.runId || run.id) === record.resumeRunId)) continue;
      let result = null;
      const documents = await paperclipJson(config, `/issues/${record.issueId}/documents`, {}, fetchImpl);
      if (documents.some((doc) => doc.key === "pr-update-result")) {
        const document = await paperclipJson(config, `/issues/${record.issueId}/documents/pr-update-result`, {}, fetchImpl);
        try { result = JSON.parse(document.body); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          await log("creator_result_invalid", { pr: prId, error: error.message });
        }
      }
      const pr = await ado.getPullRequest(config, prId, { refresh: true });
      const threads = await ado.listThreads(config, prId, { refresh: true });
      const builds = record.repair?.type === "build" ? await ado.listBuilds(config, prId, { refresh: true }) : [];
      const latest = relevant.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
      const verdict = latest.status === "succeeded"
        ? validateReviewResult(record, result, pr, threads, builds)
        : { ok: false, reason: `Latest creator execution ended ${latest.status}` };
      record.state = verdict.ok && ["done", "in_review"].includes(issue.status) ? "completed" : "blocked";
      if (record.state === "completed") record.resultHead = pr.sourceCommit;
      record.reason = verdict.reason;
      record.completedAt = new Date().toISOString();
      const monitor = issue.executionPolicy?.monitor;
      const redundantPrMonitor = monitor?.kind === "external_service" &&
        monitor.serviceName === "azure_devops_pr" && String(monitor.externalRef).includes(String(prId));
      if (record.state === "completed" && issue.status === "in_review" && !issue.assigneeUserId &&
          !issue.executionState?.currentStageId && !issue.blockedBy?.some((blocker) => blocker.status !== "done") &&
          (!monitor || redundantPrMonitor)) {
        const [interactions, approvals] = await Promise.all([
          paperclipJson(config, `/issues/${record.issueId}/interactions`, {}, fetchImpl),
          paperclipJson(config, `/issues/${record.issueId}/approvals`, {}, fetchImpl),
        ]);
        if (!interactions.some((interaction) => interaction.status === "pending") &&
            !approvals.some((approval) => ["pending", "revision_requested"].includes(approval.status))) {
          const updated = await paperclipJson(config, `/issues/${record.issueId}`, {
            method: "PATCH", body: JSON.stringify({
              status: "done",
              ...(issue.executionPolicy?.monitor ? { executionPolicy: { ...issue.executionPolicy, monitor: null } } : {}),
            }),
          }, fetchImpl);
          if (updated.status !== "done") throw new Error("Verified feedback update did not reach a terminal work-item state");
        }
      }
      if (record.state === "blocked" && !["blocked", "cancelled"].includes(issue.status)) {
        const updated = await paperclipJson(config, `/issues/${record.issueId}`, {
          method: "PATCH", body: JSON.stringify({
            status: "blocked",
            comment: `PR ${prId} completion refused: ${verdict.reason}. Owner: ${record.agentId}; provide the missing finding-specific evidence or repair the defect. Same-evidence automatic retries are held.`,
          }),
        }, fetchImpl);
        if (updated.status !== "blocked") throw new Error("Failed to record refused PR completion");
      }
      await writeJsonAtomic(file, record);
      telemetry.jobDone(record.telemetryFile, {
        jobId: record.telemetryJobId || record.submissionId, at: record.completedAt,
        agentMs: Date.parse(record.completedAt) - Date.parse(record.resumedAt || record.at),
        outcome: record.state === "completed" ? "completed" : "blocked",
        commit: pr.sourceCommit, conversation: record.reason,
      });
      await releaseResources(config, record);
      record.leasesReleased = true;
      await writeJsonAtomic(file, record);
      await log("creator_review_settled", { pr: prId, outcome: record.state, reason: record.reason });
    } finally { await release(); }
  }
}
