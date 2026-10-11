import path from "node:path";
import { callBohemia as sharedCall } from "../packages/bohemia-pr-mcp/src/client.mjs";
import { engine } from "./sources.mjs";
import { readJson, writeJson } from "./spool-store.mjs";
import { resumeEvidence } from "../packages/bohemia-pr-mcp/src/resume-state.mjs";
import { assertCreatorWorkspaceReleased, recoverSpoolCreator, resolveSpoolCreator } from "./creator-routing.mjs";
import { withAdmission } from "./admission.mjs";
import { readCreatorResult, resultComment } from "./creator-result.mjs";
import { dispatchCreator } from "./updater-dispatch.mjs";
export { readCreatorResult } from "./creator-result.mjs";
export async function createUpdater({ store, config, agent, workspace, runtime, callBohemia = sharedCall, ado, observe,
  preparationEvidence = resumeEvidence, assertMigrationSafe = assertCreatorWorkspaceReleased }) {
  const { pass, adoClient: originalAdo } = await engine("pr-updater/lib/pipeline.mjs");
  const { readState } = await engine("pr-updater/lib/state.mjs");
  const { surveyStatus } = await engine("pr-updater/lib/survey-status.mjs");
  const { createActivityLog } = await engine("pr-updater/lib/activity-log.mjs");
  const telemetry = await engine("pr-updater/lib/telemetry.mjs");
  const { reviewFindings, validateReviewResult, verifiedReviewCoverage } = await engine("lib/creator-review.mjs");
  const client = ado || originalAdo, activity = createActivityLog(runtime);
  const resolveCreator = async pr => {
    await recoverSpoolCreator(store, pr, client, config);
    return resolveSpoolCreator(store, pr);
  };
  const dispatchConfig = { ...config, harnessProjectId: "spool-creator" };
  const failures = [], holds = [];
  const log = async (event, detail) => {
    if (["job_prepare_failed", "job_dispatch_failed"].includes(event)) failures.push(detail.error);
    if (event === "job_skipped") holds.push(detail.reason);
    await activity(event, detail);
  };
  const harness = {
    async getConversations(_config, key) {
      const receipt = store.receipt(key), task = receipt && store.task(receipt.taskId);
      if (!receipt || !task) throw new Error(`Dispatched creator work ${key} is missing its durable ${receipt ? "task" : "receipt"}; verification held`);
      if (!["completed", "failed"].includes(task.status) || store.liveTasks([task]).length) return null;
      const marker = [...(task.comments || [])].reverse().map(c => c.message || c.content || "")
        .find(resultComment);
      if (!receipt.contract) return { completedAt: task.updated_at, outcome: "blocked", text: "Missing verified creator contract" };
      let result;
      try { result = marker ? readCreatorResult(store, task, marker) : null; }
      catch (error) {
        const reason = `Malformed creator result: ${error.message}`;
        writeJson(path.join(store.records, `verification-${task.id}.json`), {
          taskId: task.id, agent: task.agent, prId: receipt.prId, submissionId: key,
          ok: false, reason, checkedAt: new Date().toISOString(),
        });
        return { completedAt: task.updated_at, outcome: "blocked", text: reason };
      }
      const [pr, threads, builds] = await Promise.all([
        client.getPullRequest(config, receipt.prId, { refresh: true }),
        client.listThreads(config, receipt.prId, { fresh: true }),
        client.listBuilds(config, receipt.prId, { refresh: true }),
      ]);
      if (task.status === "completed" && result?.submissionId === key &&
          result.fingerprint === receipt.contract.fingerprint && result.head === pr.sourceCommit &&
          Date.now() - Date.parse(task.updated_at) < 5 * 60_000 && receipt.contract.repair?.type === "conflict" &&
          ["queued", "notSet"].includes(pr.mergeStatus)) return null;
      const verdict = validateReviewResult(receipt.contract, result, pr, threads, builds);
      const ok = task.status === "completed" && verdict.ok;
      writeJson(path.join(store.records, `verification-${task.id}.json`), {
        taskId: task.id, agent: task.agent, prId: receipt.prId, submissionId: key,
        baselineHead: receipt.contract.head, head: pr.sourceCommit, sessionId: task.session_id,
        ok, reason: ok ? verdict.reason : task.error || verdict.reason, checkedAt: new Date().toISOString(), result,
      });
      return { completedAt: task.updated_at, outcome: ok ? "completed" : "blocked",
        text: JSON.stringify({ ok, reason: verdict.reason, result }) };
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
    for (const entry of surveyed) {
      if (entry.verdict?.trigger !== "review") continue;
      let owner;
      try { owner = await resolveCreator(entry.pr); }
      catch (error) {
        entry.send = null;
        entry.holdingReason = error.message;
        continue;
      }
      let snapshot;
      for (const comment of [...(owner.task.comments || [])].reverse()) {
        const text = comment.message || comment.content || "";
        if (!resultComment(text)) continue;
        let result;
        try { result = readCreatorResult(store, owner.task, text); }
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
        if (!verifiedReviewCoverage(receipt.contract, result, fresh, threads, builds, reviewFindings(threads, config))) continue;
        entry.send = null;
        entry.holdingReason = "Feedback independently verified as addressed; awaiting human review or new feedback";
        break;
      }
    }
  };
  const dispatch = args => dispatchCreator(args, { store, config, client, callBohemia, log, resolveCreator,
    preparationEvidence, assertMigrationSafe, harness });
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
    return { agent, mode: "creator-updater", open: result.surveyed.length,
      actionable: result.surveyed.filter(row => row.send).length, dispatched: Number(!!result.job?.dispatched),
      holding: result.busy?.reason || holds.at(-1) || null, lastError: failures.length ? failures.join("\n") : null,
      pullRequests: surveyStatus(result.surveyed, config) };
  };
}
