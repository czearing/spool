import path from "node:path";
import { callBohemia as sharedCall } from "../packages/bohemia-pr-mcp/src/client.mjs";
import { engine } from "./sources.mjs";
import { readJson, writeJson } from "./spool-store.mjs";
import { resumeEvidence } from "../packages/bohemia-pr-mcp/src/resume-state.mjs";
import { assertCreatorWorkspaceReleased, recoverSpoolCreator, resolveSpoolCreator } from "./creator-routing.mjs";
import { withAdmission } from "./admission.mjs";
import { readCreatorResult, creatorResultHistory } from "./creator-result.mjs";
import { creatorTransportHold, creatorWorkflowEvidence, dispatchCreator } from "./updater-dispatch.mjs";
import { syncCreatorReview } from "../packages/repository-mcp/src/codespaces/creator-review.mjs";
import { setupDependency, setupDependencyAvailable } from "./setup-dependency.mjs";
import { resolveCreatorFindings } from "../scanners/pr-updater/lib/resolve-guard.mjs";
import { getCommit } from "../scanners/pr-updater/lib/azure-devops.mjs";
export { readCreatorResult } from "./creator-result.mjs";
export async function createUpdater({ store, config, agent, workspace, runtime, callBohemia = sharedCall, ado, observe,
  preparationEvidence = resumeEvidence, workflowEvidence = creatorWorkflowEvidence,
  transportHold = creatorTransportHold,
  dependencyAvailability = setupDependencyAvailable,
  assertMigrationSafe = assertCreatorWorkspaceReleased }) {
  const { pass, adoClient: originalAdo } = await engine("pr-updater/lib/pipeline.mjs");
  const { readState } = await engine("pr-updater/lib/state.mjs");
  const { surveyStatus } = await engine("pr-updater/lib/survey-status.mjs");
  const { createActivityLog } = await engine("pr-updater/lib/activity-log.mjs");
  const telemetry = await engine("pr-updater/lib/telemetry.mjs");
  const { reviewFindings, validateReviewResult, verifiedReviewCoverage, pendingReviewCoverage } =
    await engine("lib/creator-review.mjs");
  const client = ado || originalAdo;
  const activity = createActivityLog(runtime);
  const resolveCreator = async pr => {
    await recoverSpoolCreator(store, pr, client, config);
    return resolveSpoolCreator(store, pr);
  };
  const dispatchConfig = { ...config, harnessProjectId: "spool-creator" };
  const failures = [], holds = [];
  const log = async (event, detail) => {
    if (["job_prepare_failed", "job_dispatch_failed", "creator_verification_failed"].includes(event)) failures.push(detail.error);
    if (event === "job_skipped") holds.push(detail.reason);
    await activity(event, detail);
  };
  const harness = {
    async getConversations(_config, key) {
      const receipt = store.receipt(key), task = receipt && store.task(receipt.taskId);
      if (!receipt || !task) throw new Error(`Dispatched creator work ${key} is missing its durable ${receipt ? "task" : "receipt"}; verification held`);
      if (!["completed", "failed"].includes(task.status) || store.liveTasks([task]).length) return null;
      if (store.metadata(task.id)?.key !== key)
        return { completedAt: task.updated_at, outcome: "blocked", text: "A newer assignment owns this task" };
      if (!receipt.contract) return { completedAt: task.updated_at, outcome: "blocked", text: "Missing verified creator contract" };
      let result;
      try {
        if (receipt.contract.remoteArtifacts) await syncCreatorReview(receipt.contract);
        result = readCreatorResult(store, task, key);
      }
      catch (error) {
        const reason = `${task.error ? `${task.error}; ` : ""}Malformed creator result: ${error.message}`;
        writeJson(path.join(store.records, `verification-${task.id}.json`), {
          taskId: task.id, agent: task.agent, prId: receipt.prId, submissionId: key,
          ok: false, reason, checkedAt: new Date().toISOString(),
        });
        return { completedAt: task.updated_at, outcome: "blocked", text: reason };
      }
      const [initialPr, initialThreads, builds] = await Promise.all([
        client.getPullRequest(config, receipt.prId, { refresh: true }),
        client.listThreads(config, receipt.prId, { fresh: true }),
        client.listBuilds(config, receipt.prId, { refresh: true }),
      ]);
      let pr = initialPr, threads = initialThreads, resolutionError = null;
      if (task.status === "completed") {
        try {
          await resolveCreatorFindings({ config, contract: receipt.contract, result, pr, threads, builds,
            ado: { ...client, getCommit: client.getCommit || getCommit } });
          if (receipt.contract.resolutionMode === "runner")
            [pr, threads] = await Promise.all([
              client.getPullRequest(config, receipt.prId, { refresh: true }),
              client.listThreads(config, receipt.prId, { fresh: true }),
            ]);
        } catch (error) { resolutionError = error.message; }
      }
      if (task.status === "completed" && result?.submissionId === key &&
          result.fingerprint === receipt.contract.fingerprint && result.head === pr.sourceCommit &&
          Date.now() - Date.parse(task.updated_at) < 5 * 60_000 && receipt.contract.repair?.type === "conflict" &&
          ["queued", "notSet"].includes(pr.mergeStatus)) return null;
      const verdict = validateReviewResult(receipt.contract, result, pr, threads, builds);
      let publicationError = null;
      if (task.agent === "spelling" && result?.submissionId === key &&
          result.head === pr.sourceCommit && result.fingerprint === receipt.contract.fingerprint) {
        const { reconcileSpellingPublication } = await import("../scanners/spelling/publication-continuity.mjs");
        try { reconcileSpellingPublication({ store, owner: task.id, pr }); }
        catch (error) {
          publicationError = `Spelling publication verification failed: ${error.message}`;
          await log("creator_verification_failed", { pr: receipt.prId, taskId: task.id, error: publicationError });
        }
      }
      const ok = !publicationError && !resolutionError && task.status === "completed" && verdict.ok;
      const reason = ok ? verdict.reason : publicationError || resolutionError || task.error || verdict.reason;
      writeJson(path.join(store.records, `verification-${task.id}.json`), {
        taskId: task.id, agent: task.agent, prId: receipt.prId, submissionId: key,
        baselineHead: receipt.contract.head, head: pr.sourceCommit, sessionId: task.session_id,
        ok, reason, checkedAt: new Date().toISOString(), result,
      });
      return { completedAt: task.updated_at, outcome: ok ? "completed" : "blocked",
        text: JSON.stringify({ ok, reason, result }) };
    },
  };
  const recoverHandoffs = async () => {
    const jobs = telemetry.readJobs(config.telemetryFile, Infinity).filter(job =>
      job.jobId.startsWith("spool-creator:") &&
      (["queued", "in_progress", "preparing"].includes(job.state) ||
        (job.state === "blocked" && job.reason?.startsWith("Creator recovery held:")) ||
        (job.state === "failed" && job.phase === "dispatch")));
    for (const job of jobs) {
      const receipt = store.receipt(job.jobId);
      if (job.state === "failed" && (!receipt || receipt.phase === "interrupted")) continue;
      let owner;
      try {
        if (receipt?.contract) {
          owner = { taskId: receipt.taskId, agent: receipt.contract.agent, workspace: receipt.contract.cwd };
          store.validateAgent(owner.agent);
        } else {
          const pr = await client.getPullRequest(config, job.prId, { refresh: true });
          owner = await resolveCreator(pr);
        }
        await withAdmission(store.root, owner.agent, async () => {
          const submission = store.recoverSubmission(job.jobId);
          if (submission) {
            const current = store.metadata(submission.task.id);
            if (current?.key !== job.jobId) {
              telemetry.jobDone(config.telemetryFile, { jobId: job.jobId, at: new Date().toISOString(),
                outcome: "blocked", conversation: "A newer task generation superseded this interrupted journal; no result inferred" });
              return;
            }
            telemetry.jobDispatched(config.telemetryFile, { jobId: job.jobId, at: submission.at,
              agent: submission.task.agent, submissionId: job.jobId, body: "Recovered from durable Spool publication receipt" });
            await log("creator_handoff_recovered", { pr: job.prId, taskId: submission.task.id, jobId: job.jobId });
          } else {
            store.assertIdle(owner.agent, owner.workspace);
            telemetry.jobFailed(config.telemetryFile, { jobId: job.jobId, at: new Date().toISOString(),
              phase: "dispatch", error: "Interrupted before queue publication; original work preserved for fresh preparation" });
            await log("creator_preparation_recovered", { pr: job.prId, jobId: job.jobId });
          }
        }, owner.workspace);
      } catch (error) {
        const reason = `Creator recovery held: ${error.message}`;
        if (job.reason !== reason) telemetry.jobBlocked(config.telemetryFile, {
          jobId: job.jobId, at: new Date().toISOString(), reason });
        await log("job_skipped", { pr: job.prId, reason });
      }
    }
  };
  const recheckFinishedResults = async () => {
    const jobs = telemetry.readJobs(config.telemetryFile, Infinity).filter(job =>
      job.jobId.startsWith("spool-creator:") && job.state === "done" && job.outcome === "blocked");
    for (const job of jobs) {
      const receipt = store.receipt(job.jobId);
      if (receipt?.phase !== "published" || !receipt.contract) continue;
      await withAdmission(store.root, receipt.contract.agent, async () => {
        if (store.metadata(receipt.taskId)?.key !== job.jobId ||
            store.task(receipt.taskId)?.status !== "completed") return;
        const conversation = await harness.getConversations(config, job.jobId);
        if (conversation?.outcome !== "completed") return;
        telemetry.jobDone(config.telemetryFile, {
          jobId: job.jobId, at: job.doneAt || conversation.completedAt,
          agentMs: job.agentMs, updateMs: job.updateMs, outcome: "completed",
          conversation: conversation.text,
        });
        await log("creator_result_reverified", { pr: job.prId, taskId: receipt.taskId, jobId: job.jobId });
      }, receipt.contract.cwd, receipt.independentWorkspace ? receipt.taskId : null);
    }
  };
  const applyOutcomes = async surveyed => {
    const history = creatorResultHistory(store);
    for (const entry of surveyed) {
      let owner;
      try { owner = await resolveCreator(entry.pr); }
      catch (error) {
        entry.send = null;
        entry.holdingReason = error.message;
        if (entry.verdict) await log("job_skipped", { pr: entry.pr.id, reason: error.message });
        continue;
      }
      entry.creator = { agent: owner.agent, taskId: owner.taskId, status: owner.task.status };
      const verification = readJson(path.join(store.records, `verification-${owner.taskId}.json`));
      const metadata = store.metadata(owner.taskId);
      if (verification?.ok === false && verification.taskId === owner.taskId && metadata?.key &&
          verification.prId === String(entry.pr.id) &&
          verification.submissionId === metadata?.key &&
          (!verification.head || verification.head === entry.pr.sourceCommit) &&
          ["completed", "failed"].includes(owner.task.status)) {
        entry.creator.blockedReason = verification.reason;
        const dependency = config.repositoryProfile === "1js" && setupDependency(verification.reason);
        if (dependency) {
          const available = await dependencyAvailability(dependency);
          if (typeof available === "boolean")
            writeJson(path.join(store.records, `setup-dependency-${owner.taskId}.json`), { ...dependency, available });
          if (available !== true) {
            entry.send = null;
            entry.holdingReason = available === false
              ? `Approved feed does not yet provide ${dependency.name} ${dependency.range}; awaiting publication`
              : `Approved feed availability for ${dependency.name} ${dependency.range} could not be verified`;
            await log("job_skipped", { pr: entry.pr.id, reason: entry.holdingReason });
            continue;
          }
        }
        const unfinishedReply =
          metadata.contract?.findings?.some(finding =>
            verification.result?.findings?.some(row => row.threadId === finding.threadId && row.disposition === "blocked"));
        const unfinishedRepair = ["build", "conflict"].includes(metadata.contract?.repair?.type);
        const retryVerdict = entry.verdict || (unfinishedRepair ? {
          trigger: metadata.contract.repair.type, fingerprint: metadata.contract.fingerprint,
          reason: "Original creator repair verification remains unfinished",
        } : unfinishedReply ? {
          trigger: "review", fingerprint: metadata.contract.fingerprint, reason: "Original creator response remains unfinished",
        } : null);
        const rateLimited = config.repositoryProfile === "1js" &&
          /(?:GitHub|API|HTTP 403).{0,80}rate limit|GITHUB_RATE_LIMITED/i.test(verification.reason);
        if (rateLimited) {
          const deferred = await transportHold(store, owner);
          if (deferred) {
            entry.send = null;
            entry.holdingReason = deferred.reason;
            await log("job_skipped", { pr: entry.pr.id, reason: deferred.reason });
            continue;
          }
        }
        if (retryVerdict &&
            (rateLimited || metadata.repairWorkflowEvidence !== workflowEvidence(store, owner))) {
          entry.verdict ||= retryVerdict;
          entry.send = { ...retryVerdict, retry: true };
          await log("creator_workflow_changed", { pr: entry.pr.id, taskId: owner.taskId,
            reason: rateLimited ? "GitHub API cooldown ended; retrying the original creator"
              : "Verified blocked generation can retry after its preparation/repair instructions changed" });
        }
      }
      if (entry.verdict?.trigger !== "review" &&
          !["build", "conflict"].includes(metadata?.contract?.repair?.type)) continue;
      let snapshot;
      for (const key of history(owner.task)) {
        let result;
        try { result = readCreatorResult(store, owner.task, key); }
        catch (error) {
          await log("historical_result_invalid", { pr: entry.pr.id, reason: error.message });
          continue;
        }
        if (typeof result?.submissionId !== "string" || result.head !== entry.pr.sourceCommit) continue;
        const receipt = store.receipt(result.submissionId);
        if (!receipt || receipt.phase !== "published" || receipt.taskId !== owner.taskId ||
            receipt.prId !== String(entry.pr.id) || receipt.contract?.agent !== owner.agent ||
            receipt.contract?.branch !== entry.pr.branch) continue;
        snapshot ??= await Promise.all([
          client.getPullRequest(config, entry.pr.id, { refresh: true }),
          client.listThreads(config, entry.pr.id, { fresh: true }),
          client.listBuilds(config, entry.pr.id, { refresh: true }),
        ]);
        const [fresh, threads, builds] = snapshot;
        if (fresh.sourceCommit !== entry.pr.sourceCommit || fresh.branch !== entry.pr.branch || fresh.status !== "active") {
          entry.send = null;
          entry.holdingReason = "PR changed during verification; awaiting a fresh survey";
          break;
        }
        const findings = reviewFindings(threads, config);
        if (owner.task.status === "completed" &&
            pendingReviewCoverage(receipt.contract, result, fresh, threads, builds, findings)) {
          entry.send = null;
          entry.holdingReason = "Published feedback evidence is complete; awaiting current build policies before guarded resolution";
          break;
        }
        if (!verifiedReviewCoverage(receipt.contract, result, fresh, threads, builds, findings)) continue;
        entry.send = null;
        entry.holdingReason = "Feedback independently verified as addressed; awaiting human review or new feedback";
        break;
      }
    }
  };
  const dispatch = args => dispatchCreator(args, { store, config, client, callBohemia, log, resolveCreator,
    preparationEvidence, workflowEvidence, transportHold, assertMigrationSafe, harness });
  return async () => {
    failures.length = 0; holds.length = 0;
    await recoverHandoffs();
    await recheckFinishedResults();
    const state = await readState(config.stateFile);
    const result = await pass({ config: dispatchConfig, state, now: new Date().toISOString(), ado: client, harness, log,
      options: { runJob: dispatch, independentTasks: true, agentState: async () => ({ busy: false, status: "idle" }),
        onSurvey: async surveyed => {
          await applyOutcomes(surveyed);
          await observe?.({ pullRequests: surveyStatus(surveyed, config),
            lastSurvey: new Date().toISOString(), open: surveyed.length, actionable: surveyed.filter(row => row.send).length });
        } } });
    writeJson(config.stateFile, state);
    for (const entry of result.surveyed) {
      if (!entry.creator) continue;
      const task = store.task(entry.creator.taskId);
      entry.creator.status = task?.status || entry.creator.status;
      if (task && !["completed", "failed"].includes(task.status)) delete entry.creator.blockedReason;
    }
    return { agent, mode: "creator-updater", open: result.surveyed.length,
      actionable: result.surveyed.filter(row => row.send).length, dispatched: result.jobs?.length || Number(!!result.job?.dispatched),
      holding: result.busy?.reason || holds.at(-1) || null, lastError: failures.length ? failures.join("\n") : null,
      pullRequests: surveyStatus(result.surveyed, config) };
  };
}
