import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHandoffLedger, runManagedRunner } from "../../packages/bohemia-agent-tooling/src/index.js";
import { createActivityLog } from "./lib/activity-log.mjs";
import { alertDue, markRecoveredAlerts, migrateLegacyAlerts, recordAssignedAlert } from "./lib/alert-policy.mjs";
import { queryBuilds, queryTimeline } from "./lib/azure-devops.mjs";
import { readAdoMetrics } from "../lib/ado-transport.mjs";
import { assignIncident, submissionId } from "./lib/delivery.mjs";
import { assessBuilds, assessQueryError, requiredTimelineIds } from "./lib/detect.mjs";
import { createQueue } from "./lib/queue.mjs";
import { readState, writeJsonAtomic } from "./lib/state.mjs";

export async function runLivesite(entryUrl, options = {}) {
return runManagedRunner(entryUrl, async lifecycle => {
  options.onLifecycle?.(lifecycle);
  const { directory, runtime } = lifecycle;
  const config = options.config || JSON.parse(await readFile(path.join(directory, "config.json"), "utf8"));
  const stateFile = path.join(runtime, "state.json");
  const log = createActivityLog(runtime);
  const ledger = createHandoffLedger({
    path: path.join(runtime, "handoffs.jsonl"),
    tool: "livesite-runner",
  });
  const once = options.once ?? process.argv.includes("--once");
  const dryRun = process.argv.includes("--dry-run");
  const queue = options.queue || createQueue(config);
  const readBuilds = options.queryBuilds || queryBuilds;
  const readTimeline = options.queryTimeline || queryTimeline;
  const MIN_SCAN_FAILURES_BEFORE_ALERT = 2;

  await log("runner_started", { pid: process.pid, pollSeconds: config.pollSeconds, dryRun });
  await lifecycle.poll({ scan: options.wrapScan ? () => options.wrapScan(scan) : scan,
    onError: handleScanFailure, once, intervalMs: config.pollSeconds * 1000 });
  await log("runner_stopped", { pid: process.pid });

  async function scan() {
    const now = new Date();
    const state = await readState(stateFile);
    const assessments = [];
    let buildCount = 0;
    for (const definition of config.definitions) {
      const builds = await readBuilds(config, definition);
      buildCount += builds.length;
      const timelines = {};
      for (const id of requiredTimelineIds(builds)) {
        timelines[id] = await readTimeline(config, id, { completed: true });
      }
      assessments.push(assessBuilds(builds, timelines, now, config));
    }

    migrateLegacyAlerts(state, assessments);
    markRecoveredAlerts(state, assessments, now);
    state.consecutiveScanFailures = 0;
    const actionable = assessments.filter((assessment) => assessment.actionable);
    let assigned = 0;
    let holding = null;
    const deliveryErrors = [];
    for (const assessment of actionable) {
      if (!alertDue(state, assessment, now, config.alertCooldownHours)) continue;
      const attempt = (state.alerts[assessment.key]?.attempt || 0) + 1;
      const id = submissionId(config, assessment, attempt);
      let issue = null;
      if (!dryRun) {
        try {
          issue = await assignIncident(config, assessment, attempt, { queue, ledger, setupAgentBranch: options.setupAgentBranch });
        } catch (error) {
          if (error.code === "WORKFLOW_FILTERED") { await log("event_filtered", { key: assessment.key }); continue; }
          const failure = { key: assessment.key, submissionId: id, attempt, error: error.message };
          deliveryErrors.push(failure);
          await log("incident_delivery_failed", failure);
          continue;
        }
        if (!recordAssignedAlert(state, assessment.key, { now, attempt, submissionId: id, issue })) {
          holding = "Agent workspace is occupied";
          await log("incident_held", { kind: assessment.kind, submissionId: id, reason: "Agent workspace is occupied" });
          continue;
        }
        assigned++;
      }
      await log(dryRun ? "incident_dry_run" : "incident_assigned", {
        kind: assessment.kind,
        build: assessment.build?.id || null,
        submissionId: id,
        issueId: issue?.id || null,
      });
    }
    state.lastAssessment = { at: now.toISOString(), assessments, deliveryErrors };
    await writeJsonAtomic(stateFile, state);
    await writeStatus({
      lastScan: now.toISOString(),
      nextScan: new Date(now.getTime() + config.pollSeconds * 1000).toISOString(),
      detected: buildCount,
      assigned: actionable.length,
      queued: assigned,
      dispatched: assigned,
      holding: deliveryErrors.length ? `Incident delivery failed: ${deliveryErrors.map(item => item.error).join("; ")}` : holding,
      deliveryFailed: deliveryErrors.length,
      tracked: assessments.filter((item) => item.kind === "watching").length,
      reviewing: 0,
      completed: assessments.filter((item) => item.kind === "healthy").length,
      ignored: assessments.filter((item) => !item.actionable).length,
      assessments: assessments.map(compactAssessment),
      lastError: deliveryErrors.length ? deliveryErrors.map(item => item.error).join("; ") : null,
    });
    await log(deliveryErrors.length ? "scan_delivery_failed" : "scan_completed", {
      builds: buildCount, actionable: actionable.length, assigned, deliveryErrors,
    });
  }

  async function handleScanFailure(error) {
    const now = new Date();
    const state = await readState(stateFile);
    const assessment = assessQueryError(error);
    let assigned = 0;
    let deliveryError = null;
    const queueUnavailable = String(error.message).startsWith("queue ");
    // A single failed scan is not evidence of an outage. The monitor cannot reach Azure for
    // many transient reasons, and it recovers on the next poll in nearly every case, so alert
    // only once consecutive scans have failed.
    state.consecutiveScanFailures = (state.consecutiveScanFailures || 0) + 1;
    const persistent = state.consecutiveScanFailures >= MIN_SCAN_FAILURES_BEFORE_ALERT;
    if (assessment.actionable && persistent && !queueUnavailable && alertDue(state, assessment, now, config.alertCooldownHours)) {
      const attempt = (state.alerts[assessment.key]?.attempt || 0) + 1;
      const id = submissionId(config, assessment, attempt);
      try {
        if (!dryRun) {
          const issue = await assignIncident(config, assessment, attempt, { queue, ledger, setupAgentBranch: options.setupAgentBranch });
          assigned = Number(recordAssignedAlert(state, assessment.key, { now, attempt, submissionId: id, issue }));
        }
      } catch (assignmentError) {
        deliveryError = assignmentError;
      }
    }
    state.lastAssessment = { at: now.toISOString(), assessments: [assessment] };
    await writeJsonAtomic(stateFile, state);
    await writeStatus({
      lastScan: now.toISOString(),
      nextScan: new Date(now.getTime() + config.pollSeconds * 1000).toISOString(),
      detected: 0,
      assigned: assessment.actionable && persistent ? 1 : 0,
      queued: assigned,
      tracked: 0,
      reviewing: 0,
      completed: 0,
      ignored: 0,
      assessments: [compactAssessment(assessment)],
      lastError: deliveryError ? `${assessment.summary}; ${deliveryError.message}` : assessment.summary,
    });
    await log("scan_failed", {
      kind: assessment.kind,
      assigned,
      consecutiveFailures: state.consecutiveScanFailures,
      error: assessment.summary,
      deliveryError: deliveryError?.message || null,
    });
  }

  function compactAssessment(item) {
    return {
      kind: item.kind,
      actionable: item.actionable,
      summary: item.summary,
      build: item.build?.number || null,
      url: item.build?.url || null,
    };
  }

  async function writeStatus(update) {
    lifecycle.publish({
      mode: "livesite",
      agent: config.agentName || config.agentId,
      pollSeconds: config.pollSeconds,
      ado: await readAdoMetrics().catch((error) => ({ error: error.message })),
      ...update,
    });
  }

});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runLivesite(import.meta.url);
}
