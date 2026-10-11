import { rollup, TELEMETRY_KINDS } from "./telemetry.js";
import { runCollection } from "./collect.js";
import { assertSelector } from "./select.js";
import { assertGate } from "./gate.js";
import { writeTaskIssue, writeDefectIssue } from "./issue-writer.js";
import { checkAcceptance } from "./acceptance.js";
import { setupAgentBranch, slugifyBranchTopic } from "./branch-setup.js";
import { assertAgentWorkspaceIdle } from "./workspace-admission.js";
import { BRIEF_VERIFICATION, detectDrift, describeDrift, describeUnverifiedBrief } from "./brief.js";
import {
  CORRECTION_RESULTS,
  createBriefCorrector,
  describeUncorrectedBrief,
} from "./correction.js";

const CORRECTION_TRANSITIONS = Object.freeze({
  [CORRECTION_RESULTS.APPLIED]: "corrected",
  [CORRECTION_RESULTS.DEFERRED]: "correction_deferred",
  [CORRECTION_RESULTS.HELD]: "correction_held",
  [CORRECTION_RESULTS.REFUSED]: "correction_refused",
  [CORRECTION_RESULTS.UNCHANGED]: "correction_unchanged",
});

/**
 * The wake. Every tool built on this scaffold runs the same ordered cycle and supplies the parts:
 * read the record, read results back, collect, select, write at most one issue, append telemetry.
 * An empty cycle is a normal result: it appends a cycle record and writes no issue.
 */
export async function runCycle(config) {
  const {
    tool,
    telemetry,
    collectors,
    selector,
    queue,
    assigneeAgentId,
    parentIssueId = null,
    projectId = null,
    bodyBudget,
    titleBudget,
    renderTask,
    gate = null,
    verifyBrief = null,
    driftTolerance = 0,
    correctBriefs = true,
    correctionDeferralLimit = 3,
    defect = null,
    context = {},
  } = config;

  if (!tool) throw new Error("cycle requires a tool name");
  if (!telemetry) throw new Error("cycle requires a telemetry writer");
  if (verifyBrief !== null && typeof verifyBrief !== "function") {
    throw new Error("verifyBrief must be a function returning a verification status");
  }
  if (defect !== null && (typeof defect !== "object" || typeof defect.ownerAgentId !== "string" || defect.ownerAgentId.trim() === "")) {
    throw new Error("the defect channel requires a tool owner agent id");
  }
  assertSelector(selector);
  assertGate(gate);

  /**
   * What this run can attribute a write to. It is read from the queue the tool configured rather than
   * declared, so a cycle records the reason a write was held instead of leaving the reason in a
   * refusal sentence nobody keeps.
   */
  const runContext = config.runContext ?? queue?.runContext ?? null;

  const history = rollup(telemetry.read());
  const transitions = [];

  for (const task of history.openTasks) {
    let issue = null;
    let comments = [];
    try {
      issue = await queue.getIssue(task.issueId);
      if (typeof queue.getComments === "function") {
        comments = await queue.getComments(task.issueId);
      }
    } catch (error) {
      transitions.push(
        telemetry.append(TELEMETRY_KINDS.TASK_TRANSITION, {
          issueId: task.issueId,
          metric: task.metric,
          transition: "unreadable",
          verdict: "unknown",
          error: error.message,
        }),
      );
      continue;
    }

    const result = checkAcceptance(task, issue, comments);
    if (result.transition === "open") continue;
    transitions.push(
      telemetry.append(TELEMETRY_KINDS.TASK_TRANSITION, {
        issueId: task.issueId,
        metric: task.metric,
        transition: result.transition,
        verdict: result.verdict,
        status: result.status ?? null,
        after: result.after,
        acceptance: result.acceptance ?? null,
        delta: result.delta ?? null,
      }),
    );
  }

  const stillOpen = rollup(telemetry.read()).openTasks;
  const openMetrics = new Set(stillOpen.map((task) => task.metric));

  const gateResult = gate ? await gate.evaluate(context) : { proceed: true, reason: "no_gate" };

  if (!gateResult.proceed) {
    if (gate.commit) gate.commit({ proceed: false, gate: gateResult, selection: null, issueId: null });
    const skippedRecord = telemetry.append(TELEMETRY_KINDS.CYCLE, {
      observed: 0,
      skippedOpenMetrics: [...openMetrics],
      collectionFailures: [],
      selectionReason: gateResult.reason,
      gate: {
        proceed: false,
        reason: gateResult.reason,
        previous: gateResult.previous ?? null,
        current: gateResult.current ?? null,
        detail: gateResult.detail ?? null,
      },
      candidateMetric: null,
      issueId: null,
      issueIdentifier: null,
      transitions: transitions.length,
      briefVerification: null,
      drifted: 0,
      corrected: 0,
      correctionsDeferred: 0,
      correctionsHeld: 0,
      runContext: runContext ? { attributable: runContext.attributable === true, reason: runContext.reason ?? null } : null,
      defectIssueId: null,
      measurements: [],
    });
    return {
      tool,
      empty: true,
      issueId: null,
      issueIdentifier: null,
      observations: [],
      failures: [],
      selection: { candidate: null, reason: gateResult.reason },
      gate: gateResult,
      transitions,
      drifts: [],
      corrections: [],
      briefVerification: null,
      defectIssueId: null,
      runContext,
      cycleRecord: skippedRecord,
    };
  }

  const { observations, failures } = await runCollection(collectors, context);
  if (config.failOnCollectionError && failures.length) {
    throw new Error(`Collection failed: ${JSON.stringify(failures)}`);
  }

  const records = telemetry.read();
  const alreadyReported = new Set(
    records
      .filter((record) => record.kind === TELEMETRY_KINDS.TASK_TRANSITION && record.transition === "drifted")
      .map((record) => `${record.issueId}:${record.recorded}`),
  );
  const drifts = detectDrift(stillOpen, observations, { tolerance: driftTolerance });
  let defectIssueId = null;

  const observationByMetric = new Map(observations.map((observation) => [observation.metric, observation]));
  const openByIssue = new Map(stillOpen.map((task) => [task.issueId, task]));
  const deferralCounts = new Map();
  for (const record of records) {
    if (record.kind !== TELEMETRY_KINDS.TASK_TRANSITION) continue;
    if (record.transition !== "correction_deferred") continue;
    deferralCounts.set(record.issueId, (deferralCounts.get(record.issueId) ?? 0) + 1);
  }

  const correctBrief =
    correctBriefs && queue && typeof queue.updateIssue === "function"
      ? createBriefCorrector({ queue, renderTask, bodyBudget, titleBudget, tolerance: driftTolerance })
      : null;

  const corrections = [];

  for (const drift of drifts) {
    transitions.push(
      telemetry.append(TELEMETRY_KINDS.TASK_TRANSITION, {
        issueId: drift.issueId,
        metric: drift.metric,
        transition: "drifted",
        verdict: "stale_brief",
        recorded: drift.recorded,
        observed: drift.observed,
        unit: drift.unit,
        delta: drift.delta,
      }),
    );

    if (!correctBrief) continue;
    const observation = observationByMetric.get(drift.metric);
    const task = openByIssue.get(drift.issueId);
    if (!observation || !task) continue;

    const attempt = (deferralCounts.get(drift.issueId) ?? 0) + 1;
    const outcome = await correctBrief({ task, observation, attempt });
    corrections.push({ ...outcome, drift });

    const candidate = outcome.correction?.candidate ?? null;
    transitions.push(
      telemetry.append(TELEMETRY_KINDS.TASK_TRANSITION, {
        issueId: drift.issueId,
        metric: drift.metric,
        transition: CORRECTION_TRANSITIONS[outcome.result] ?? "correction_refused",
        verdict: outcome.result,
        reason: outcome.reason,
        attempt,
        recorded: drift.recorded,
        current: candidate?.current ?? null,
        target: candidate?.target ?? null,
        acceptance: candidate?.acceptance ?? null,
        unit: candidate?.unit ?? drift.unit ?? null,
        reproduction: candidate?.reproduction ?? null,
        fields: outcome.correction?.changedFields ?? [],
      }),
    );
  }

  /**
   * A stale brief the tool put right in place is settled, so it is not handed to the tool owner. Only
   * a correction that could not land is a defect, and a deferral is one only once the run lock has
   * refused it more times than the tool is willing to wait.
   *
   * A held correction is never one. Nothing the tool owner can do makes a timer woken run
   * attributable, and the write is waiting rather than lost, so a defect for it would be noise on
   * every wake for as long as the tool keeps waking.
   */
  const unsettled = corrections.filter((entry) => {
    if (entry.result === CORRECTION_RESULTS.HELD) return false;
    if (entry.result === CORRECTION_RESULTS.REFUSED) return true;
    if (entry.result !== CORRECTION_RESULTS.DEFERRED) return false;
    return entry.attempt >= correctionDeferralLimit;
  });

  const correctionAttempted = new Set(corrections.map((entry) => entry.drift.issueId));
  const unreportedDrift = drifts.find(
    (drift) => !alreadyReported.has(`${drift.issueId}:${drift.recorded}`) && !correctionAttempted.has(drift.issueId),
  );
  const reportedCorrections = new Set(
    records
      .filter(
        (record) =>
          record.kind === TELEMETRY_KINDS.TASK_TRANSITION && record.transition === "correction_reported",
      )
      .map((record) => record.issueId),
  );
  const unsettledDefect = unsettled.find((entry) => !reportedCorrections.has(entry.drift.issueId));

  if (defect && (unsettledDefect || unreportedDrift)) {
    const summary = unsettledDefect
      ? describeUncorrectedBrief(unsettledDefect.drift, unsettledDefect)
      : describeDrift(unreportedDrift);
    const parentIssue = unsettledDefect ? unsettledDefect.drift.issueId : unreportedDrift.issueId;
    const created = await writeDefectIssue({
      queue,
      defect: { tool, surface: "task-brief", summary },
      ownerAgentId: defect.ownerAgentId,
      parentIssueId: parentIssue,
      bodyBudget,
      titleBudget,
    });
    defectIssueId = created.id;
    if (unsettledDefect) {
      transitions.push(
        telemetry.append(TELEMETRY_KINDS.TASK_TRANSITION, {
          issueId: unsettledDefect.drift.issueId,
          metric: unsettledDefect.drift.metric,
          transition: "correction_reported",
          verdict: unsettledDefect.result,
          defectIssueId,
          attempt: unsettledDefect.attempt,
        }),
      );
    }
  }

  const selectable = observations.filter((observation) => !openMetrics.has(observation.metric));
  const proposed = selector(selectable);

  let issueId = null;
  let issueIdentifier = null;
  let briefVerification = proposed.candidate
    ? { status: BRIEF_VERIFICATION.NOT_CONFIGURED, reason: "no verifier configured", observed: [] }
    : null;

  if (proposed.candidate && verifyBrief) {
    briefVerification = await verifyBrief(proposed.candidate);
  }

  const briefRefused =
    briefVerification !== null &&
    briefVerification.status !== BRIEF_VERIFICATION.VERIFIED &&
    briefVerification.status !== BRIEF_VERIFICATION.NOT_CONFIGURED;

  if (briefRefused && defect && defectIssueId === null) {
    const created = await writeDefectIssue({
      queue,
      defect: {
        tool,
        surface: "task-brief",
        summary: describeUnverifiedBrief(proposed.candidate, briefVerification),
      },
      ownerAgentId: defect.ownerAgentId,
      parentIssueId: defect.parentIssueId ?? parentIssueId ?? null,
      bodyBudget,
      titleBudget,
    });
    defectIssueId = created.id;
  }

  const selection = briefRefused
    ? { ...proposed, candidate: null, reason: `brief_${briefVerification.status}` }
    : proposed;

  if (selection.candidate) {
    let branchName = selection.candidate.branchName || null;
    const repoRoot = config.agentWorkspaceRoot || config.repoRoot || null;
    if (repoRoot) {
      try {
        await assertAgentWorkspaceIdle(queue, assigneeAgentId);
        const slug = slugifyBranchTopic(selection.candidate.metric || tool);
        const branchTopic = branchName || `${tool.replace(/-engine$/, "")}-${slug}`;
        const branchResult = await (config.setupAgentBranch || setupAgentBranch)({
          repoRoot,
          branch: branchTopic,
          baseBranch: "master",
          mode: branchName ? "checkout" : "create",
        });
        branchName = branchResult.branch;
        await assertAgentWorkspaceIdle(queue, assigneeAgentId);
      } catch (error) {
        telemetry.append(TELEMETRY_KINDS.TASK_TRANSITION, { transition: "preparation_failed", metric: selection.candidate.metric, error: error.message });
        throw error;
      }
    }

    const candidateWithBranch = {
      ...selection.candidate,
      ...(branchName ? { branchName } : {}),
      ...(repoRoot ? { repoRoot } : {}),
    };

    const created = await writeTaskIssue({
      queue,
      candidate: candidateWithBranch,
      assigneeAgentId,
      parentIssueId,
      projectId,
      bodyBudget,
      titleBudget,
      renderTask,
    });
    issueId = created.id;
    issueIdentifier = created.identifier ?? null;
    telemetry.append(TELEMETRY_KINDS.TASK_TRANSITION, {
      issueId,
      issueIdentifier,
      metric: selection.candidate.metric,
      transition: "opened",
      current: selection.candidate.current,
      target: selection.candidate.target,
      acceptance: selection.candidate.acceptance,
      unit: selection.candidate.unit,
      reproduction: selection.candidate.reproduction,
      direction: selection.candidate.direction ?? "lower_is_better",
    });
  }

  const cycleRecord = telemetry.append(TELEMETRY_KINDS.CYCLE, {
    observed: observations.length,
    skippedOpenMetrics: [...openMetrics],
    collectionFailures: failures,
    selectionReason: selection.reason,
    minGapRatio: selection.minGapRatio ?? null,
    gate: {
      proceed: true,
      reason: gateResult.reason,
      previous: gateResult.previous ?? null,
      current: gateResult.current ?? null,
      detail: gateResult.detail ?? null,
    },
    candidateMetric: selection.candidate?.metric ?? null,
    issueId,
    issueIdentifier,
    transitions: transitions.length,
    briefVerification: briefVerification
      ? { status: briefVerification.status, reason: briefVerification.reason ?? null, observed: briefVerification.observed ?? [] }
      : null,
    drifted: drifts.length,
    corrected: corrections.filter((entry) => entry.result === CORRECTION_RESULTS.APPLIED).length,
    correctionsDeferred: corrections.filter((entry) => entry.result === CORRECTION_RESULTS.DEFERRED).length,
    correctionsHeld: corrections.filter((entry) => entry.result === CORRECTION_RESULTS.HELD).length,
    runContext: runContext ? { attributable: runContext.attributable === true, reason: runContext.reason ?? null } : null,
    defectIssueId,
    measurements: observations.map((observation) => ({
      metric: observation.metric,
      current: observation.current,
      target: observation.target,
      unit: observation.unit,
    })),
  });

  if (gate?.commit) gate.commit({ proceed: true, gate: gateResult, selection, issueId });

  return {
    tool,
    empty: issueId === null,
    issueId,
    issueIdentifier,
    observations,
    failures,
    selection,
    gate: gateResult,
    transitions,
    drifts,
    corrections,
    briefVerification,
    defectIssueId,
    runContext,
    cycleRecord,
  };
}
/**
 * The command line contract every tool shares. No interface, one JSON summary on stdout,
 * exit code 0 for a completed cycle including an empty one, 1 for a cycle that could not run.
 */
export async function runWake(config, { stdout = process.stdout } = {}) {
  try {
    const summary = await runCycle(config);
    stdout.write(
      `${JSON.stringify(
        {
          tool: summary.tool,
          empty: summary.empty,
          issueId: summary.issueId,
          issueIdentifier: summary.issueIdentifier,
          candidateMetric: summary.selection.candidate?.metric ?? null,
          selectionReason: summary.selection.reason,
          briefVerification: summary.briefVerification?.status ?? null,
          drifted: summary.drifts?.length ?? 0,
          corrected: summary.corrections?.filter((entry) => entry.result === CORRECTION_RESULTS.APPLIED).length ?? 0,
          correctionsDeferred:
            summary.corrections?.filter((entry) => entry.result === CORRECTION_RESULTS.DEFERRED).length ?? 0,
          correctionsHeld:
            summary.corrections?.filter((entry) => entry.result === CORRECTION_RESULTS.HELD).length ?? 0,
          runContext: summary.runContext?.reason ?? null,
          defectIssueId: summary.defectIssueId ?? null,
          observed: summary.observations.length,
          collectionFailures: summary.failures,
          telemetryPath: config.telemetry.path,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (error) {
    stdout.write(`${JSON.stringify({ error: error.message }, null, 2)}\n`);
    return 1;
  }
}
