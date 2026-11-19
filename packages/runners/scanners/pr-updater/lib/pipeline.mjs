/**
 * One pass over the operator's open pull requests: decide, prepare, dispatch, record.
 *
 * Split from the process entry point so the whole pipeline can be driven in a test with fake
 * Azure DevOps and harness calls and a fake clock, which is the only way the five trigger
 * scenarios are ever actually verified rather than asserted about in isolation.
 *
 * No regular expressions are used.
 */
import { existsSync } from "node:fs";
import { stepTimings } from "../../lib/preparation-telemetry.mjs";
import { getPullRequest, listBuilds, listOwnPullRequests, listThreads, requeuePolicy, updateThreadStatus } from "./azure-devops.mjs";
import { alreadySent, recentlyFailed, recentPreparationFailure } from "./dispatch-guards.mjs";
import { survey } from "./survey.mjs";
import * as telemetry from "./telemetry.mjs";
import { BUILD, CONFLICT } from "./triggers.mjs";
import { callBohemia } from "../../../packages/bohemia-pr-mcp/src/client.mjs";
import { assertPreparationCapacity } from "../../../packages/bohemia-pr-mcp/src/preparation-capacity.mjs";
import { PREPARATION_BLOCKED } from "../../../packages/bohemia-pr-mcp/src/resume-state.mjs";

export { survey };

export function submissionId(projectId, prId, fingerprint, attempt = 0) {
  const safe = String(fingerprint).split(":").join("-");
  return `${projectId}:pr-updater:${prId}:${safe}:${attempt}`;
}

/**
 * Position the clone for one job.
 *
 * Injectable so the pipeline can be exercised without a checkout: the default is the shared
 * preparation sequence bound to the real clone, and a test supplies its own.
 */
export async function defaultPrepare({ config, pr, verdict, call = callBohemia }) {
  const codespace = config.repositoryProfile === "1js";
  if (!codespace) assertPreparationCapacity(config, config.repoRoot);
  const mergeMaster = verdict.trigger === CONFLICT || verdict.trigger === BUILD;
  const freshIsolated = !codespace && config.creatorWorkspaceSeed && !existsSync(config.repoRoot);
  await config.preparationCheckpoint?.({ stage: "bohemia_prepare", state: "started", at: Date.now() });
  const prepared = await call("bohemia_prepare", {
    repoRoot: config.repoRoot, operation: "branch", branch: pr.branch,
    mode: codespace || config.checkoutExistingBranch ? "checkout" : config.preservePreparedBranch && !freshIsolated ? "resume" : "checkout",
    reset: codespace || (config.checkoutExistingBranch ? false : !config.preservePreparedBranch),
    ...(pr.sourceCommit ? { expectedHead: pr.sourceCommit } : {}),
    ...(!codespace && config.creatorWorkspaceSeed ? { seedRoot: config.creatorWorkspaceSeed } : {}),
    ...(config.creatorMinimumFreeGiB !== undefined ? { minimumFreeGiB: config.creatorMinimumFreeGiB } : {}),
    mergeMaster, allowConflicts: mergeMaster,
    runSetup: true,
    runBuild: verdict.trigger !== BUILD && verdict.trigger !== CONFLICT,
  });
  if (!prepared?.ready || prepared.branch !== pr.branch || !prepared.commit) throw new Error("Bohemia did not confirm the updater checkout");
  await config.preparationCheckpoint?.({ stage: "bohemia_prepare", state: "completed", at: Date.now(), result: prepared });
  return { ...prepared, installed: true, server: null };
}

/**
 * Run one job end to end.
 *
 * Telemetry is written before preparation starts, so a pull request that entered the queue is
 * visible even if everything after it fails. Distinguishing "never queued" from "queued and
 * stuck" without reading code is the whole point of the record.
 */
export async function runJob({ config, pr, verdict, now, harness, log, prepare = defaultPrepare }) {
  const file = config.telemetryFile;
  const attempt = verdict.retry ? Date.now() : 0;
  const jobId = submissionId(config.harnessProjectId, pr.id, verdict.fingerprint, attempt);

  // The same evidence must never be dispatched twice, whatever this runner believes about its own
  // state. The rate limiter that used to be the only guard lived in a file two processes wrote in
  // turn, so each overwrote the other's record and one comment was sent nine times in 40 minutes.
  // The durable job log cannot be lost that way, so the check belongs against it.
  const recorded = alreadySent(config, jobId);
  const submission = !recorded && await harness?.findSubmission?.(jobId);
  if (recorded || submission) {
    await log("job_skipped", { pr: pr.id, jobId, reason: "already dispatched for this evidence" });
    const previous = telemetry.readJobs(config.telemetryFile, 200).find((job) => job.jobId === jobId);
    return { jobId, dispatched: false, skipped: true,
      lastSentAt: submission?.at || previous?.dispatchedAt || previous?.queuedAt || previous?.at };
  }

  const failedPreparation = recentPreparationFailure(config, jobId, now);
  if (failedPreparation) {
    await log("job_skipped", { pr: pr.id, jobId, reason: "preparation failed recently, cooling down" });
    return { jobId, dispatched: false, skipped: true, reason: failedPreparation.error };
  }

  telemetry.jobQueued(file, { jobId, prId: pr.id, prUrl: pr.url, trigger: verdict.trigger, reason: verdict.reason, at: now, agent: config.agentId });
  await log("job_queued", { pr: pr.id, trigger: verdict.trigger, reason: verdict.reason });

  let prepared = null;
  try {
    telemetry.jobStarted(file, { jobId, at: new Date().toISOString() });
    prepared = await prepare({ config, pr, verdict });
    telemetry.jobPrepared(file, {
      jobId,
      at: new Date().toISOString(),
      ms: prepared.ms,
      steps: stepTimings(prepared.steps),
      branch: prepared.branch,
      conflicts: prepared.merge?.files || [],
    });
    await log("job_prepared", { pr: pr.id, ms: prepared.ms });
  } catch (error) {
    if (error.code === PREPARATION_BLOCKED || error.code === "WORKFLOW_FILTERED" ||
        error.code === "CODESPACE_WORKSPACE_BUSY") {
      telemetry.jobBlocked(file, { jobId, at: new Date().toISOString(), reason: error.message });
      await log("job_skipped", { pr: pr.id, reason: error.message });
      return { jobId, dispatched: false, skipped: true, reason: error.message };
    }
    telemetry.jobFailed(file, { jobId, at: new Date().toISOString(), phase: "prepare", error,
      preparationEvidence: config.preparationEvidence });
    await log("job_prepare_failed", { pr: pr.id, error: String(error).split("\n")[0] });
    return { jobId, dispatched: false, reason: error.message || String(error) };
  }

  try {
    await harness.submitAgentTask(config, config.agentId, undefined, jobId, { pr, verdict });
  } catch (error) {
    if (error.code === "WORKFLOW_FILTERED") {
      telemetry.jobBlocked(file, { jobId, at: new Date().toISOString(), reason: error.message });
      await log("job_skipped", { pr: pr.id, reason: error.message }); return { jobId, dispatched: false, skipped: true };
    }
    telemetry.jobFailed(file, { jobId, at: new Date().toISOString(), phase: "dispatch", error });
    await log("job_dispatch_failed", { pr: pr.id, error: String(error).split("\n")[0] });
    return { jobId, dispatched: false, reason: error.message || String(error) };
  }

  telemetry.jobDispatched(file, { jobId, at: new Date().toISOString(), agent: config.agentId, submissionId: jobId });
  await log("job_dispatched", { pr: pr.id, agent: config.agentId, submissionId: jobId });
  return { jobId, dispatched: true };
}

/** Dispatch guards live next door; re-exported so existing callers and tests keep working. */
export { RETRY_COOLDOWN_MS } from "./dispatch-guards.mjs";
export { alreadySent, recentlyFailed };

/**
 * Close out jobs the agent has finished with.
 *
 * The harness records a conversation only once a turn completes, so its appearance is the signal
 * that agent work ended. Without this a dispatched job stays "running" forever and the dashboard
 * reports a stall that is not happening.
 */
export async function reconcile({ config, state, harness, log }) {
  const recorded = telemetry.readJobs(config.telemetryFile, 200);
  for (const entry of Object.values(state?.pullRequests || {})) {
    const previous = recorded.find((job) => job.jobId === entry.jobId && job.state === telemetry.DONE);
    const sentAt = previous?.dispatchedAt;
    if (sentAt && Date.parse(entry.lastSentAt) > Date.parse(sentAt)) entry.lastSentAt = sentAt;
  }
  const jobs = recorded.filter((job) => job.state === telemetry.DISPATCHED && !job.creatorOwned);
  if (jobs.length === 0) return 0;
  let closed = 0;
  for (const job of jobs) {
    const conversation = await harness.getConversations(config, job.submissionId);
    if (!conversation?.completedAt) continue;
    telemetry.jobDone(config.telemetryFile, {
      jobId: job.jobId,
      at: conversation.completedAt,
      // Measured from dispatch, not from the row's last activity: `at` moves with every state
      // change, so using it would report the gap since the previous line rather than agent time.
      agentMs: Date.parse(conversation.completedAt) - Date.parse(job.dispatchedAt || job.at),
      updateMs: Date.parse(conversation.completedAt) - Date.parse(job.queuedAt || job.at),
      outcome: conversation.outcome || "completed",
      conversation: conversation.text || null,
    });
    if (conversation.outcome !== "completed" && state?.pullRequests?.[job.prId]) {
      state.pullRequests[job.prId].lastSentAt = job.dispatchedAt || conversation.completedAt;
    }
    await log("job_done", { pr: job.prId, jobId: job.jobId });
    closed += 1;
  }
  return closed;
}

/**
 * The job this runner believes is still open, if any.
 *
 * Kept as a second opinion rather than the decision. It covers the window between dispatching and
 * the harness reporting the agent as working, which is real: the task is queued before the turn
 * starts, and during that gap the harness still answers idle.
 */
export function inFlight(config) {
  return telemetry.readJobs(config.telemetryFile, 50).find(
    (job) => job.state === telemetry.DISPATCHED || job.state === telemetry.PREPARING,
  ) || null;
}

/**
 * Whether anything may be handed to the agent right now, and why not.
 *
 * The orchestrator is asked first because it is the only party that knows whether a run is in
 * flight. Deciding this from local telemetry alone is what caused the agent to be handed the same
 * pull request repeatedly: a finished turn cleared the local record while the agent was still
 * working, and a second runner process shared no record at all.
 *
 * The active Spool runner checks admission per original task and workspace.
 */
export async function availability({ config, options = {} }) {
  if (options.independentTasks) {
    return { free: true, reason: "Creator admission is checked per issue and workspace", status: "idle" };
  }
  const probe = options.agentState;
  if (!probe) return { free: false, status: "unknown", reason: "Spool original-task admission is required" };
  const state = await probe(config, options);
  if (state.busy) return { free: false, reason: state.reason, status: state.status };
  const local = inFlight(config);
  if (local) {
    return { free: false, reason: `job ${local.jobId} is still open locally`, status: "dispatched", prId: local.prId };
  }
  return { free: true, reason: state.reason, status: state.status };
}

/**
 * One full pass. Returns what it did so the caller can log a single line per cycle.
 *
 * The survey always runs, even when the agent is busy: requeuing a broken build and closing stale
 * automated threads cost the agent nothing, and the dashboard should stay honest about what is
 * waiting. Only the dispatch is gated.
 */
export async function pass({ config, state, now, ado, harness, log, prepare, options = {} }) {
  await reconcile({ config, state, harness, log });
  const surveyed = await survey({ config, state, now, ado, log });
  await options.onSurvey?.(surveyed);
  const held = [];
  const ready = surveyed.filter((entry) => entry.send);
  const latest = telemetry.readJobs(config.telemetryFile, 1)[0];
  if (latest?.state === telemetry.FAILED && latest.phase === "dispatch") {
    // Retry the last prepared checkout before paying to switch dependency trees again.
    const index = ready.findIndex((entry) => String(entry.pr.id) === String(latest.prId));
    if (index > 0) ready.unshift(ready.splice(index, 1)[0]);
  }

  const free = await availability({ config, options });
  if (!free.free) {
    await log("survey", { open: surveyed.length, actionable: ready.length, holding: free.reason });
    return { surveyed, job: null, busy: free };
  }

  await log("survey", { open: surveyed.length, actionable: ready.length });
  if (ready.length === 0) return {
    surveyed, job: null,
    busy: held.length ? { free: false, status: "blocked", reason: held.join(" | ") } : null,
  };

  let dispatchedJob = null;
  const dispatchedJobs = [];
  for (const chosen of ready) {
    let result;
    try {
      result = await (options.runJob || runJob)({ config, pr: chosen.pr, verdict: chosen.send, now, harness, log, prepare });
    } catch (error) {
      if (!options.independentTasks) throw error;
      await log("creator_review_held", { pr: chosen.pr.id, reason: error.message });
      result = { dispatched: false, skipped: true, reason: error.message };
    }
    chosen.holdingReason = result.reason || null;
    if (result.reason && !result.settled) held.push(`PR ${chosen.pr.id}: ${result.reason}`);
    if (result.dispatched) {
      state.pullRequests ??= {};
      state.pullRequests[chosen.pr.id] = { fingerprint: chosen.send.fingerprint, lastSentAt: now, jobId: result.jobId };
      dispatchedJob = result;
      dispatchedJobs.push(result);
      if (!options.independentTasks) break;
      continue;
    }
    if (result.skipped && result.lastSentAt) {
      state.pullRequests ??= {};
      state.pullRequests[chosen.pr.id] = { fingerprint: chosen.send.fingerprint, lastSentAt: result.lastSentAt, jobId: result.jobId };
      continue;
    }
  }
  return { surveyed, job: dispatchedJob, jobs: dispatchedJobs,
    busy: !dispatchedJob && held.length ? { free: false, status: "blocked", reason: held.join(" | ") } : null };
}

export const adoClient = { getPullRequest, listOwnPullRequests, listThreads, listBuilds, requeuePolicy, updateThreadStatus };
