/**
 * Heartbeat run health and per run liveness. This is the metric collection for one tool and it stays
 * here: the shared core never learns what a heartbeat run is.
 *
 * Every field is computed from recorded columns only. Nothing here reads the clock, so two runs
 * against unchanged history return identical values.
 */

import {
  tryParseInstant,
  minutesBetween,
  splitByCutoff,
  groupByInstantSecond,
  groupByInstantBucket,
  correlateToInstants,
  gapsInSeries,
  linkChains,
  analyzeWakePaths,
  round as coreRound,
  summarizeNumbers,
  percentage,
  countBy,
  spanOfInstants,
  intersectSpans,
  uncoveredSpans,
} from "bohemia-agent-tooling";
import { sliceSupervisorRecordAt, sliceSupervisorRecordBefore } from "./supervisor-log.js";

const PROCESS_LOST_PATTERN = /process lost/i;
const BACKSTOP_PATTERN = /recovery backstop/i;

/** The window an output recency guard treats as alive. Ten minutes is the adopted standard. */
export const OUTPUT_RECENCY_GUARD_MINUTES = 10;

/** How near a death instant must sit to a decision instant to count as the same event. */
export const CORRELATION_TOLERANCE_MINUTES = 2;

/**
 * The width a population wide event is collected over, and the number of distinct agents inside one
 * such window that makes it a population wide event rather than a coincidence. No per run cause makes
 * three unrelated agents stop inside the same minute, so a window carrying three or more is a reading
 * about the host and not about any run in it.
 */
export const MASS_INSTANT_BUCKET_SECONDS = 60;
export const MASS_INSTANT_AGENT_THRESHOLD = 3;

/** Detection latency a repair must reach, and the ceiling no single row may pass. */
export const DETECTION_LATENCY_MEAN_MINUTES = 5;
export const DETECTION_LATENCY_MAXIMUM_MINUTES = 10;

/** Lost run minutes, as a share of finished run minutes, that a repair must stay under. */
export const LOST_MINUTES_SHARE_CEILING = 10;

/** The process lost share a repair must reach, and the succeeded share it must not fall below. */
export const PROCESS_LOST_SHARE_TARGET = 5;
export const SUCCEEDED_SHARE_FLOOR = 69;

/**
 * Chain level standards. A wake that loses its process is retried, so the row level loss share says
 * how often an attempt died and says nothing about whether the work behind it was ever finished. The
 * chain answers that, and it is the only place a retry policy can be scored: a cap calibrated for a
 * rare loss abandons work as soon as the loss stops being rare.
 */
export const CHAIN_ABANDONMENT_SHARE_TARGET = 5;
export const CHAIN_SUCCEEDED_SHARE_FLOOR = 57;

/**
 * The columns a run may record an abandonment reason in. A chain that stopped being retried and a
 * chain whose next retry has not started yet read identically off a null scheduled retry, so a reason
 * is the only column that separates a policy decision from a pending one.
 */
export const CHAIN_ABANDONMENT_REASON_FIELDS = Object.freeze([
  "abandonmentReason",
  "retryAbandonedReason",
  "retryStopReason",
]);

/**
 * The band immediately past the guard. A detector that judges liveness by a wrong probe, and then has
 * a recency guard bolted in front of it, stops killing runs inside the guard and starts killing the
 * same runs the moment the guard expires. Those deaths pile up in a narrow band just past the guard
 * rather than spreading out, so a count in this band separates a repaired mechanism from a moved
 * counter without anyone reading rows.
 */
export const GUARD_BOUNDARY_BAND_MINUTES = 1;

/**
 * A dispatch gap wide enough to mean the supervisor was not there. Runs start on a cadence of well
 * under a minute across nine agents, so three minutes with nothing started is not a quiet patch.
 */
export const DISPATCH_GAP_MINUTES = 3;

export function isProcessLost(run) {
  return PROCESS_LOST_PATTERN.test(String(run?.error ?? "")) || run?.errorCode === "process_lost";
}

export function isBackstopTerminated(run) {
  return (
    BACKSTOP_PATTERN.test(String(run?.error ?? "")) || run?.errorCode === "orphaned_running_run"
  );
}

/**
 * Names the class a run's ending belongs to. A clean ending is the run deciding it is done. The other
 * three are the run being ended by something else, and only those carry a liveness question.
 */
export function classifyTermination(run) {
  if (tryParseInstant(run?.finishedAt) === null) return null;
  if (isBackstopTerminated(run)) return "backstop";
  if (isProcessLost(run)) return "processLost";
  return String(run?.error ?? "").trim() === "" ? "clean" : "error";
}

/**
 * Collapses an error message to the class it belongs to, so a class that is renamed rather than
 * removed cannot hide behind a fresh identifier, a fresh pid, or a fresh path.
 */
export function normalizeErrorSignature(error) {
  const text = String(error ?? "").trim();
  if (text === "") return null;
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*/g, "<time>")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "<path>")
    .replace(/(?:\/[^\s"'/]+){2,}/g, "<path>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function round(value, places = 2) {
  return coreRound(value, places);
}

function share(part, whole) {
  return percentage(part, whole);
}

/**
 * A lost run has no finish, so its duration is measured to the last thing it recorded. When it
 * recorded nothing at all the duration is zero rather than a guess against the current clock.
 */
function lostMinutes(run) {
  const start = tryParseInstant(run.startedAt);
  if (start === null) return 0;
  const end = tryParseInstant(run.finishedAt ?? run.lastOutputAt ?? run.updatedAt);
  if (end === null) return 0;
  const minutes = minutesBetween(start, end);
  return minutes > 0 ? minutes : 0;
}

/**
 * Per run liveness at termination. Every field is computed from recorded columns, so the caller does
 * no arithmetic and no timestamp handling.
 *
 * A run ended by something other than itself carries the question this answers: was it still working
 * when it was ended. The quiet gap between its last recorded output and its finish is the answer, and
 * the guard is the standard the company already adopted for it. Grouping the endings to the second
 * separates one decision taken against a batch of runs from a batch of independent failures, and
 * correlating the lost runs to those instants says whether two detectors are counting one event twice.
 */
/**
 * Whether a termination recorded why it happened. An exit code or a signal is a reading taken from
 * the process itself. A named cause is only the detector restating its own diagnosis, so it is
 * reported but never counted as an exit status: a run carrying a name and no exit code and no signal
 * was still diagnosed by the absence of output alone.
 */
export function recordedOutcome(run) {
  const exitCode = run?.exitCode ?? null;
  const signal = run?.signal ?? null;
  const reason = String(run?.livenessReason ?? "").trim();
  const namedCause = reason === "" ? null : reason;
  return {
    exitCode,
    signal,
    namedCause,
    exitStatus: exitCode !== null || signal !== null,
    recorded: exitCode !== null || signal !== null || namedCause !== null,
  };
}

/**
 * How long a run kept working before it went quiet, from its start to its last recorded output.
 *
 * The exact minutes are kept on the record and rounded only when a spread is reported. Rounding each
 * run first and summing the rounded values drifts the total away from the number the rows actually
 * hold, and a total is one of the fields a clause is scored on.
 */
function productiveLifetimeMinutes(run) {
  const start = tryParseInstant(run?.startedAt);
  const lastOutput = tryParseInstant(run?.lastOutputAt);
  if (start === null || lastOutput === null) return null;
  return minutesBetween(start, lastOutput);
}

export function summarizeLiveness(runs) {
  const terminated = [];
  for (const run of runs) {
    const terminationClass = classifyTermination(run);
    if (terminationClass === null || terminationClass === "clean") continue;
    const lastOutput = tryParseInstant(run.lastOutputAt);
    const quietGapMinutes =
      lastOutput === null ? null : minutesBetween(run.lastOutputAt, run.finishedAt);
    const outcome = recordedOutcome(run);
    terminated.push({
      id: run.id ?? null,
      agentId: run.agentId ?? null,
      terminationClass,
      finishedAt: tryParseInstant(run.finishedAt).toISOString(),
      lastOutputAt: lastOutput === null ? null : lastOutput.toISOString(),
      quietGapMinutes,
      productiveLifetimeMinutes: productiveLifetimeMinutes(run),
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      namedCause: outcome.namedCause,
      hasRecordedOutcome: outcome.recorded,
      hasExitStatus: outcome.exitStatus,
      hadOutput: lastOutput !== null,
      insideOutputRecencyGuard:
        quietGapMinutes !== null && quietGapMinutes < OUTPUT_RECENCY_GUARD_MINUTES,
      atOutputRecencyGuardBoundary:
        quietGapMinutes !== null &&
        quietGapMinutes >= OUTPUT_RECENCY_GUARD_MINUTES &&
        quietGapMinutes < OUTPUT_RECENCY_GUARD_MINUTES + GUARD_BOUNDARY_BAND_MINUTES,
    });
  }
  terminated.sort(
    (a, b) => a.finishedAt.localeCompare(b.finishedAt) || String(a.id).localeCompare(String(b.id)),
  );

  const backstop = terminated.filter((entry) => entry.terminationClass === "backstop");
  const processLost = terminated.filter((entry) => entry.terminationClass === "processLost");
  const backstopInstants = groupByInstantSecond(backstop, (entry) => entry.finishedAt, {
    distinctBy: (entry) => entry.agentId,
  }).groups.map((group) => ({
    instant: group.instant,
    runs: group.count,
    agents: group.distinctCount,
  }));

  const correlation = correlateToInstants(
    processLost,
    (entry) => entry.lastOutputAt,
    backstopInstants.map((group) => group.instant),
    { toleranceMinutes: CORRELATION_TOLERANCE_MINUTES },
  );

  return {
    outputRecencyGuardMinutes: OUTPUT_RECENCY_GUARD_MINUTES,
    terminatedRuns: terminated.length,
    ...quietGapFields(terminated),
    classes: {
      backstop: { ...quietGapFields(backstop), terminationInstants: backstopInstants },
      processLost: {
        ...quietGapFields(processLost),
        correlatedToBackstopInstants: {
          toleranceMinutes: correlation.toleranceMinutes,
          count: correlation.matched,
          of: correlation.total,
          share: share(correlation.matched, correlation.total),
        },
      },
      error: quietGapFields(terminated.filter((entry) => entry.terminationClass === "error")),
    },
    runs: terminated.map((entry) => ({
      ...entry,
      quietGapMinutes: round(entry.quietGapMinutes, 2),
      productiveLifetimeMinutes: round(entry.productiveLifetimeMinutes, 2),
    })),
  };
}

function quietGapFields(entries) {
  const gaps = entries
    .filter((entry) => entry.quietGapMinutes !== null)
    .map((entry) => entry.quietGapMinutes);
  const insideGuard = entries.filter((entry) => entry.insideOutputRecencyGuard).length;
  const atBoundary = entries.filter((entry) => entry.atOutputRecencyGuardBoundary).length;
  const recorded = entries.filter((entry) => entry.hasRecordedOutcome).length;
  return {
    runs: entries.length,
    quietGapMinutes: {
      minimum: gaps.length === 0 ? null : round(Math.min(...gaps), 2),
      maximum: gaps.length === 0 ? null : round(Math.max(...gaps), 2),
      mean: gaps.length === 0 ? null : round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length, 2),
    },
    insideOutputRecencyGuard: { count: insideGuard, share: share(insideGuard, entries.length) },
    atOutputRecencyGuardBoundary: {
      bandMinutes: GUARD_BOUNDARY_BAND_MINUTES,
      count: atBoundary,
      share: share(atBoundary, entries.length),
    },
    noOutputRuns: entries.filter((entry) => !entry.hadOutput).length,
    detectionLatencyMinutes: summarizeNumbers(entries.map((entry) => entry.quietGapMinutes)),
    productiveLifetimeMinutes: summarizeNumbers(
      entries.map((entry) => entry.productiveLifetimeMinutes),
    ),
    recordedOutcome: {
      count: recorded,
      of: entries.length,
      withExitCode: entries.filter((entry) => entry.exitCode !== null).length,
      withSignal: entries.filter((entry) => entry.signal !== null).length,
      share: share(recorded, entries.length),
      withoutOutcome: entries.length - recorded,
      withExitStatus: entries.filter((entry) => entry.hasExitStatus).length,
      withoutExitStatus: entries.filter((entry) => !entry.hasExitStatus).length,
      byOutcome: countBy(
        entries,
        (entry) =>
          entry.exitCode !== null
            ? `exit ${entry.exitCode}`
            : entry.signal !== null
              ? `signal ${entry.signal}`
              : entry.namedCause,
        { emptyKey: "no recorded outcome" },
      ),
    },
    massInstants: massInstants(entries),
  };
}

/**
 * Windows in which several agents went quiet at once. Grouping the last recorded output to a wide
 * bucket and counting distinct agents inside it separates a host level event, which takes whatever is
 * in flight regardless of what it was doing, from a set of runs each failing for its own reason.
 */
export function massInstants(entries) {
  const grouped = groupByInstantBucket(
    entries.filter((entry) => entry.lastOutputAt !== null),
    (entry) => entry.lastOutputAt,
    { bucketSeconds: MASS_INSTANT_BUCKET_SECONDS, distinctBy: (entry) => entry.agentId },
  );
  const instants = grouped.groups
    .map((group) => ({ instant: group.instant, runs: group.count, agents: group.distinctCount }))
    .sort(
      (a, b) => b.runs - a.runs || b.agents - a.agents || a.instant.localeCompare(b.instant),
    );
  const windows = instants
    .filter((entry) => entry.agents >= MASS_INSTANT_AGENT_THRESHOLD)
    .sort((a, b) => a.instant.localeCompare(b.instant));
  return {
    bucketSeconds: MASS_INSTANT_BUCKET_SECONDS,
    agentThreshold: MASS_INSTANT_AGENT_THRESHOLD,
    instants,
    instantCount: instants.length,
    runsWithNoLastOutput: entries.filter((entry) => entry.lastOutputAt === null).length,
    windows,
    windowCount: windows.length,
    runsInWindows: windows.reduce((sum, window) => sum + window.runs, 0),
    largestWindowAgents: windows.reduce((most, window) => Math.max(most, window.agents), 0),
  };
}

/**
 * What happened to the runs that were retried after a loss, and how many losses were never retried at
 * all. A retry that loses again is not a recovery, and a loss with no further attempt is work that was
 * dropped rather than rescheduled.
 */
export function summarizeRetries(runs) {
  const retries = runs.filter((run) => run.retryOfRunId);
  const lostAgain = retries.filter(isProcessLost).length;
  const succeeded = retries.filter((run) => run.status === "succeeded").length;
  const retriedRunIds = new Set(retries.map((run) => run.retryOfRunId));
  const lost = runs.filter(isProcessLost);
  const notRetried = lost.filter((run) => !retriedRunIds.has(run.id)).length;
  const counts = runs
    .map((run) => run.processLossRetryCount)
    .filter((value) => Number.isFinite(value));
  const cap = counts.length === 0 ? null : Math.max(...counts);
  const atCap = cap === null ? 0 : counts.filter((value) => value === cap).length;
  return {
    rows: runs.length,
    retryRuns: retries.length,
    retryShare: share(retries.length, runs.length),
    lostAgain,
    lostAgainShare: share(lostAgain, retries.length),
    succeeded,
    succeededShare: share(succeeded, retries.length),
    byStatus: countBy(retries, (run) => run.status),
    retryCountCap: cap,
    rowsAtRetryCountCap: atCap,
    rowsAtRetryCountCapShare: share(atCap, runs.length),
    lostRunsWithNoRetry: notRetried,
    lostRunsWithNoRetryShare: share(notRetried, lost.length),
  };
}

/**
 * Wake chains, which is the population a retry policy is scored on. A chain is a root run plus every
 * run linked to it through the retry link, and it is the unit that carries the work: one chain is one
 * wake, however many attempts it took.
 *
 * A chain is settled when nothing more is coming for it, which means its last run is not running and
 * no retry is scheduled for it. A settled chain is abandoned when its last run was lost and nothing
 * points at it, so the work was dropped rather than rescheduled. Reporting the reason column and the
 * retry count of every abandoned chain is what separates a policy that stopped on purpose from one
 * that ran out of attempts, and separates both from a retry that has simply not started yet.
 */
export function summarizeChains(runs) {
  const linked = linkChains(runs, {
    idOf: (run) => run.id,
    parentOf: (run) => run.retryOfRunId ?? null,
  });
  const counts = runs
    .map((run) => run.processLossRetryCount)
    .filter((value) => Number.isFinite(value));
  const cap = counts.length === 0 ? null : Math.max(...counts);

  const entries = linked.chains.map((chain) => {
    const terminal = chain.terminal;
    const retryCount = Number.isFinite(terminal.processLossRetryCount)
      ? terminal.processLossRetryCount
      : null;
    const lost = isProcessLost(terminal);
    const awaitingRetry = tryParseInstant(terminal.scheduledRetryAt) !== null;
    const running = terminal.status === "running" || tryParseInstant(terminal.finishedAt) === null;
    return {
      rootId: chain.rootId,
      terminalId: terminal.id ?? null,
      agentId: terminal.agentId ?? null,
      attempts: chain.length,
      detached: chain.rootKind !== "origin",
      outcome: lost ? "lost" : (terminal.status ?? "none"),
      running,
      awaitingRetry: !running && awaitingRetry,
      settled: !running && !awaitingRetry,
      abandoned: !running && !awaitingRetry && lost,
      retryCount,
      atRetryCountCap: cap !== null && retryCount === cap,
      abandonmentReason: readAbandonmentReason(terminal),
      finishedAt: terminal.finishedAt ?? null,
    };
  });

  const settled = entries.filter((entry) => entry.settled);
  const abandoned = settled.filter((entry) => entry.abandoned);
  const succeeded = settled.filter((entry) => entry.outcome === "succeeded");
  const withoutReason = abandoned.filter((entry) => entry.abandonmentReason === null);
  const atCap = abandoned.filter((entry) => entry.atRetryCountCap);

  return {
    rows: runs.length,
    chains: linked.chainCount,
    detachedChains: linked.detachedChains,
    branchedChains: linked.branchedChains,
    unreachableRows: linked.unreachableRows,
    attempts: summarizeNumbers(entries.map((entry) => entry.attempts)),
    runningChains: entries.filter((entry) => entry.running).length,
    awaitingRetryChains: entries.filter((entry) => entry.awaitingRetry).length,
    settledChains: settled.length,
    byOutcome: countBy(settled, (entry) => entry.outcome),
    succeededChains: succeeded.length,
    succeededShare: share(succeeded.length, settled.length),
    abandonedChains: abandoned.length,
    abandonedShare: share(abandoned.length, settled.length),
    retryCountCap: cap,
    abandonedAtRetryCountCap: atCap.length,
    abandonedWithRecordedReason: abandoned.length - withoutReason.length,
    abandonedWithoutRecordedReason: withoutReason.length,
    abandonedChainDetail: abandoned
      .map((entry) => ({
        rootId: entry.rootId,
        terminalId: entry.terminalId,
        agentId: entry.agentId,
        attempts: entry.attempts,
        retryCount: entry.retryCount,
        atRetryCountCap: entry.atRetryCountCap,
        abandonmentReason: entry.abandonmentReason,
        finishedAt: entry.finishedAt,
      }))
      .sort(
        (a, b) =>
          String(a.finishedAt).localeCompare(String(b.finishedAt)) ||
          String(a.terminalId).localeCompare(String(b.terminalId)),
      ),
  };
}

/** The first non empty reason column a run records, or null when it records none. */
export function readAbandonmentReason(run) {
  for (const field of CHAIN_ABANDONMENT_REASON_FIELDS) {
    const value = String(run?.[field] ?? "").trim();
    if (value !== "") return value;
  }
  return null;
}

/**
 * Loss concentrated in a few agents and loss spread evenly across all of them are different
 * mechanisms, so the share is reported per agent rather than only for the population.
 */
export function summarizePerAgentLoss(runs) {
  const byAgent = new Map();
  for (const run of runs) {
    const agentId = run.agentId ?? "unknown";
    if (!byAgent.has(agentId)) byAgent.set(agentId, { agentId, startedRuns: 0, processLostRuns: 0 });
    const entry = byAgent.get(agentId);
    entry.startedRuns += 1;
    if (isProcessLost(run)) entry.processLostRuns += 1;
  }
  const agents = [...byAgent.values()]
    .map((entry) => ({
      ...entry,
      processLostShare: share(entry.processLostRuns, entry.startedRuns),
    }))
    .sort(
      (a, b) =>
        b.processLostRuns - a.processLostRuns ||
        b.processLostShare - a.processLostShare ||
        String(a.agentId).localeCompare(String(b.agentId)),
    );
  const affected = agents.filter((entry) => entry.processLostRuns > 0);
  const shares = affected.map((entry) => entry.processLostShare);
  return {
    agents,
    agentCount: agents.length,
    affectedAgentCount: affected.length,
    lowestAffectedShare: shares.length === 0 ? null : Math.min(...shares),
    highestAffectedShare: shares.length === 0 ? null : Math.max(...shares),
  };
}

/**
 * Board side liveness. An issue parked in blocked with nothing blocking it names no owner and has
 * nothing to resolve, which is the board level shape of the same lost execution path. Reporting only:
 * nothing here writes an issue.
 *
 * Three readings come out of this, and they are not the same number. The window reading says how many
 * issues entered blocked with neither a first class blocker nor a scheduled monitor. The terminal
 * reading says how many of those dead ends something else is waiting on, so the fault reaches past the
 * issue it sits on. The stranded reading says how many issues in total cannot resume, which is what
 * one dead end actually costs. The blocker graph is walked over every blocked issue on the board
 * rather than over the window, because whether a chain can resume is a fact about the board now and
 * not about when its rows were parked.
 *
 * The walk itself is the shared core's, so a second tool that parks work counts chains the same way.
 * Only the field names and what counts as a wake path are decided here.
 */
export function summarizeBlockedIssues(issues, { since = null } = {}) {
  const blocked = issues.filter((issue) => issue.status === "blocked");
  const split = splitByCutoff(blocked, since, (issue) => issue.blockedTransitionAt);
  const inWindow = since === null ? blocked : split.after;
  const stranded = inWindow.filter((issue) => (issue.blockedBy?.length ?? 0) === 0);
  const withoutWakePath = inWindow.filter(
    (issue) => (issue.blockedBy?.length ?? 0) === 0 && !hasScheduledMonitor(issue),
  );

  // The blockers named inside a blocked issue join the population so the walk can resolve the chain.
  // A blocker that is itself blocked is already on the board list, so this only adds the live ones,
  // and a live blocker is exactly the wake path the chain resumes on.
  const population = new Map();
  for (const issue of blocked) population.set(String(issue.id), issue);
  for (const issue of blocked) {
    for (const blocker of issue.blockedBy ?? []) {
      const id = String(blocker.id);
      if (!population.has(id)) population.set(id, blocker);
    }
  }

  const paths = analyzeWakePaths([...population.values()], {
    idOf: (issue) => issue.id,
    dependsOnOf: (issue) => (issue.blockedBy ?? []).map((blocker) => blocker.id),
    isParked: (issue) => issue.status === "blocked",
    // An issue that is not blocked moves on its own, and a blocked issue with a scheduled monitor
    // wakes on the timer. Anything else waits on its blockers alone.
    hasOwnWakePath: (issue) => issue.status !== "blocked" || hasScheduledMonitor(issue),
  });

  const strandedIssues = paths.strandedIds.map((id) => population.get(id));
  const withoutUnblockDescriptor = strandedIssues.filter((issue) => !hasUnblockDescriptor(issue));

  return {
    blockedIssues: blocked.length,
    blockedIssuesInWindow: inWindow.length,
    withoutBlockers: stranded.length,
    /** Blocked in window with neither a first class blocker nor a scheduled monitor. */
    withoutWakePath: withoutWakePath.length,
    undatedBlockedIssues: since === null ? 0 : split.undated.length,
    /** Dead ends that something else is waiting on, and the population waiting behind them. */
    chainTerminalsWithoutWakePath: paths.chainTerminalCount,
    strandedDependents: paths.strandedDependentCount,
    strandedIssueCount: paths.strandedCount,
    /** Stranded issues that record no machine readable unblock owner and action. */
    strandedWithoutUnblockDescriptor: withoutUnblockDescriptor.length,
    unresolvedBlockerReferences: paths.unresolvedDependencies,
    blockerCycles: paths.cyclicIds.length,
    issues: withoutWakePath.map(describeBlockedIssue).sort(byIdentifier),
    chainTerminals: paths.chainTerminals
      .map((terminal) => ({
        ...describeBlockedIssue(terminal.row),
        strandedDependents: terminal.strandedDependentCount,
        strandedDependentIdentifiers: terminal.strandedDependentIds
          .map((id) => population.get(id)?.identifier ?? id)
          .sort(),
      }))
      .sort(byIdentifier),
    strandedIssues: strandedIssues.map(describeBlockedIssue).sort(byIdentifier),
  };
}

function byIdentifier(a, b) {
  return String(a.identifier).localeCompare(String(b.identifier));
}

function describeBlockedIssue(issue) {
  return {
    identifier: issue.identifier ?? issue.id ?? null,
    title: issue.title ?? null,
    blockedTransitionAt: issue.blockedTransitionAt ?? null,
    blockers: (issue.blockedBy ?? []).length,
    monitorNextCheckAt: issue.monitorNextCheckAt ?? null,
    unblockOwnerRecorded: hasUnblockDescriptor(issue),
  };
}

function hasScheduledMonitor(issue) {
  return tryParseInstant(issue.monitorNextCheckAt) !== null;
}

/**
 * Whether the issue records who unblocks it and what they do in a field rather than in prose. Prose in
 * a comment cannot be scored, so a chain that is merely waiting reads identically to a stranded one
 * until this field is filled.
 */
function hasUnblockDescriptor(issue) {
  const descriptor = issue?.unblockDescriptor;
  if (descriptor === null || typeof descriptor !== "object") return false;
  const owner = descriptor.owner;
  const hasOwner =
    typeof owner === "string"
      ? owner.trim().length > 0
      : typeof owner === "object" &&
        owner !== null &&
        [owner.agentId, owner.userId, owner.agentNameKey].some(
          (value) => typeof value === "string" && value.trim().length > 0,
        );
  const hasAction = typeof descriptor.action === "string" && descriptor.action.trim().length > 0;
  return hasOwner && hasAction;
}

/**
 * The two clauses that read the supervisor's own record. Kept as one function so the block scored on
 * the cohort and the block reported for each side of a cutoff can never drift apart.
 *
 * A record that never observed the span answers nothing about it. Scoring these clauses on the events
 * it does carry would report zero of zero as a pass, which is the same false verdict as scoring them
 * on evidence from before the cutoff, only in the other direction.
 */
export function scoreGuardClauses(supervisor, { coversSpan = true, uncovered = [] } = {}) {
  const observed = supervisor === null || supervisor === undefined || !coversSpan ? null : supervisor;
  const notScoredOver = observed === null && supervisor !== null && supervisor !== undefined ? uncovered : null;
  return {
    "runs the output recency guard skipped and another path terminalized anyway": {
      number: observed === null ? null : observed.guardHoleRuns,
      of: observed === null ? null : observed.guardSkippedRuns,
      target: 0,
      // A hole that names no authority is its own number rather than one folded in with the holes
      // that name one. A path that recorded a wrong reading and a path that recorded no reading are
      // different defects, and only the second one leaves nothing at all to repair against.
      withoutRecordedAuthority:
        observed === null ? null : observed.guardHolesWithoutRecordedAuthority,
      byTerminatingPath: observed === null ? null : observed.guardHolesByTerminatingPath,
      notScoredOver,
      pass: observed === null ? null : observed.guardHoleRuns === 0,
    },
    // Separates a guard that prevented a wrong verdict from one that only postponed it. A hole
    // landing on the far edge of the window is the same verdict on a timer, and it reads as a pass
    // on every clause that counts only deaths inside the window.
    "guard skipped runs terminalized at the instant the guard expired": {
      number: observed === null ? null : observed.guardExpiryKills,
      of: observed === null ? null : observed.guardHolesWithOutputAge,
      target: 0,
      notScoredOver,
      pass: observed === null ? null : observed.guardExpiryKills === 0,
    },
  };
}

/**
 * Scores the acceptance clauses that were being read by hand off these fields. A clause with no data
 * behind it scores null rather than passing by default.
 */
export function scoreClauses(
  cohort,
  blocked,
  {
    succeededShareFloor = SUCCEEDED_SHARE_FLOOR,
    chainSucceededShareFloor = CHAIN_SUCCEEDED_SHARE_FLOOR,
    supervisor = null,
    supervisorCoversCohort = true,
    supervisorUncoveredSpans = [],
  } = {},
) {
  const guardClauses = scoreGuardClauses(supervisor, {
    coversSpan: supervisorCoversCohort,
    uncovered: supervisorUncoveredSpans,
  });
  const liveness = cohort.liveness;
  const chains = cohort.chains ?? summarizeChains([]);
  const insideGuard = liveness.insideOutputRecencyGuard.count;
  const atBoundary = liveness.atOutputRecencyGuardBoundary.count;
  const lost = liveness.classes.processLost;
  const latency = lost.detectionLatencyMinutes;
  const startedRuns = cohort.startedRuns ?? null;
  const lostShare = cohort.processLostShare ?? null;
  const succeededShare = cohort.succeededShare ?? null;
  const lostMinutesShare = cohort.lostMinutesShareOfFinished ?? null;

  return {
    "terminated runs inside the output recency guard": {
      number: insideGuard,
      of: liveness.terminatedRuns,
      target: 0,
      pass: insideGuard === 0,
    },
    "terminated runs pinned to the guard boundary": {
      number: atBoundary,
      of: liveness.terminatedRuns,
      target: 0,
      pass: atBoundary === 0,
    },
    "one minute windows losing runs from three or more agents": {
      number: lost.massInstants.windowCount,
      of: lost.runs,
      target: 0,
      pass: lost.massInstants.windowCount === 0,
    },
    "process lost share": {
      number: lostShare,
      of: startedRuns,
      target: PROCESS_LOST_SHARE_TARGET,
      pass: lostShare === null ? null : lostShare <= PROCESS_LOST_SHARE_TARGET,
    },
    "terminated runs with no recorded outcome": {
      number: liveness.recordedOutcome.withoutOutcome,
      of: liveness.terminatedRuns,
      target: 0,
      pass: liveness.recordedOutcome.withoutOutcome === 0,
    },
    /*
     * A named cause is the detector restating its own diagnosis. The clause a repair is judged on asks
     * for a reading taken from the process itself, so it is scored on the exit code and the signal
     * alone. Scoring it on the recorded outcome would let a run diagnosed by the absence of output
     * pass a clause about exit status.
     */
    "terminated runs with no exit status": {
      number: liveness.recordedOutcome.withoutExitStatus,
      of: liveness.terminatedRuns,
      target: 0,
      pass: liveness.recordedOutcome.withoutExitStatus === 0,
    },
    "detection latency on lost runs in minutes": {
      number: latency.mean,
      of: latency.count,
      target: DETECTION_LATENCY_MEAN_MINUTES,
      maximum: latency.maximum,
      maximumTarget: DETECTION_LATENCY_MAXIMUM_MINUTES,
      pass:
        latency.count === 0
          ? null
          : latency.mean <= DETECTION_LATENCY_MEAN_MINUTES &&
            latency.maximum <= DETECTION_LATENCY_MAXIMUM_MINUTES,
    },
    "succeeded share": {
      number: succeededShare,
      of: cohort.finishedRuns ?? null,
      target: succeededShareFloor,
      pass: succeededShare === null ? null : succeededShare >= succeededShareFloor,
    },
    "lost run minutes as a share of finished run minutes": {
      number: lostMinutesShare,
      of: cohort.finishedRunMinutes ?? null,
      target: LOST_MINUTES_SHARE_CEILING,
      pass: lostMinutesShare === null ? null : lostMinutesShare <= LOST_MINUTES_SHARE_CEILING,
    },
    "settled wake chains abandoned with no further attempt": {
      number: chains.abandonedShare,
      of: chains.settledChains,
      target: CHAIN_ABANDONMENT_SHARE_TARGET,
      pass:
        chains.abandonedShare === null
          ? null
          : chains.abandonedShare <= CHAIN_ABANDONMENT_SHARE_TARGET,
    },
    "chains abandoned at the retry count cap while loss is above its target": {
      number: chains.abandonedAtRetryCountCap,
      of: chains.abandonedChains,
      target: 0,
      // A cap that stops a chain is only a fault while loss is still common. Once the loss share is
      // at its own target the cap is doing what it was calibrated for, so the clause is not scored
      // against a repair it does not own.
      pass:
        lostShare === null
          ? null
          : lostShare <= PROCESS_LOST_SHARE_TARGET || chains.abandonedAtRetryCountCap === 0,
    },
    "abandoned chains with no recorded reason": {
      number: chains.abandonedWithoutRecordedReason,
      of: chains.abandonedChains,
      target: 0,
      pass: chains.abandonedWithoutRecordedReason === 0,
    },
    "succeeded share of settled wake chains": {
      number: chains.succeededShare,
      of: chains.settledChains,
      target: chainSucceededShareFloor,
      pass:
        chains.succeededShare === null
          ? null
          : chains.succeededShare >= chainSucceededShareFloor,
    },
    "issues blocked with no blocker": {
      number: blocked === null ? null : blocked.withoutWakePath,
      of: blocked === null ? null : blocked.blockedIssuesInWindow,
      target: 0,
      // The same clause now carries what the chain costs, so the stranded numbers come out of this
      // command rather than out of a caller side walk over the relation endpoints.
      chainTerminalsWithoutWakePath: blocked === null ? null : blocked.chainTerminalsWithoutWakePath,
      strandedDependents: blocked === null ? null : blocked.strandedDependents,
      pass: blocked === null ? null : blocked.withoutWakePath === 0,
    },
    "blocked chain terminals with no wake path": {
      number: blocked === null ? null : blocked.chainTerminalsWithoutWakePath,
      of: blocked === null ? null : blocked.blockedIssues,
      target: 0,
      strandedDependents: blocked === null ? null : blocked.strandedDependents,
      pass: blocked === null ? null : blocked.chainTerminalsWithoutWakePath === 0,
    },
    "stranded blocked issues recording no unblock owner and action": {
      number: blocked === null ? null : blocked.strandedWithoutUnblockDescriptor,
      of: blocked === null ? null : blocked.strandedIssueCount,
      target: 0,
      pass: blocked === null ? null : blocked.strandedWithoutUnblockDescriptor === 0,
    },
    ...guardClauses,
    "lost runs silenced while the supervisor was still dispatching": {
      number: cohort.dispatch?.lostRunsSilencedWhileStillDispatching ?? null,
      of: cohort.dispatch?.lostRunsSilencedWhileStillDispatching === undefined ? null : lost.runs,
      target: 0,
      pass:
        cohort.dispatch === undefined
          ? null
          : cohort.dispatch.lostRunsSilencedWhileStillDispatching === 0,
    },
  };
}

/**
 * Dispatch availability, and where the silences fall against it.
 *
 * A run going quiet says nothing on its own about what silenced it. A run going quiet while the
 * supervisor was still starting other runs is a different event from one going quiet while the
 * supervisor was absent, and until the two are counted apart every diagnosis of this surface is a
 * guess. The dispatch series is the only availability evidence that survives a supervisor restart,
 * because the supervisor's own record does not.
 */
export function summarizeDispatch(runs, { minimumGapMinutes = DISPATCH_GAP_MINUTES } = {}) {
  const series = gapsInSeries(runs, (run) => run.startedAt, { minimumGapMinutes });
  const lost = runs.filter(isProcessLost);

  const windows = series.gaps.map((gap) => ({
    from: parseInstantOrNull(gap.from),
    to: parseInstantOrNull(gap.to),
  }));

  let duringGap = 0;
  let whileDispatching = 0;
  let unknown = 0;
  for (const run of lost) {
    const silence = tryParseInstant(run.lastOutputAt);
    if (silence === null) {
      unknown += 1;
      continue;
    }
    const inside = windows.some(
      (window) =>
        window.from !== null &&
        window.to !== null &&
        silence.getTime() > window.from.getTime() &&
        silence.getTime() < window.to.getTime(),
    );
    if (inside) duringGap += 1;
    else whileDispatching += 1;
  }

  return {
    minimumGapMinutes,
    gapCount: series.gapCount,
    gapMinutes: series.totalMinutes,
    widestGap: series.widest,
    gaps: series.gaps,
    lostRunsSilencedDuringADispatchGap: duringGap,
    lostRunsSilencedWhileStillDispatching: whileDispatching,
    lostRunsWithNoSilenceInstant: unknown,
    silencedWhileStillDispatchingShare: share(whileDispatching, lost.length),
  };
}

function parseInstantOrNull(value) {
  return tryParseInstant(value);
}

export function summarizeCohort(runs) {
  const started = runs.filter((run) => tryParseInstant(run.startedAt) !== null);
  const processLost = started.filter(isProcessLost);
  const finished = started.filter(
    (run) => tryParseInstant(run.finishedAt) !== null && !isProcessLost(run),
  );
  const succeeded = finished.filter((run) => run.status === "succeeded");

  const finishedRunMinutes = round(
    finished.reduce((sum, run) => sum + minutesBetween(run.startedAt, run.finishedAt), 0),
    1,
  );
  const lostRunMinutes = round(
    processLost.reduce((sum, run) => sum + lostMinutes(run), 0),
    1,
  );
  const totalMinutes = round(finishedRunMinutes + lostRunMinutes, 1);

  const counts = new Map();
  for (const run of started) {
    const signature = normalizeErrorSignature(run.error);
    if (signature === null) continue;
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  const errorSignatures = [...counts.entries()]
    .map(([signature, count]) => ({ signature, count }))
    .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));

  return {
    startedRuns: started.length,
    processLostRuns: processLost.length,
    processLostShare: share(processLost.length, started.length),
    finishedRuns: finished.length,
    succeededRuns: succeeded.length,
    succeededShare: share(succeeded.length, finished.length),
    finishedRunMinutes,
    lostRunMinutes,
    discardedShare: share(lostRunMinutes, totalMinutes),
    errorSignatures,
    retries: summarizeRetries(started),
    chains: summarizeChains(started),
    perAgentLoss: summarizePerAgentLoss(started),
    lostMinutesShareOfFinished: share(lostRunMinutes, finishedRunMinutes),
    liveness: summarizeLiveness(started),
    dispatch: summarizeDispatch(started),
  };
}

/**
 * What a supervisor record observed of the runs it is being scored against. An operator told only
 * that a clause was not scored cannot tell a record that was never read from one that was read and
 * stops short of the cohort, so the uncovered stretch is named rather than implied.
 */
function describeCoverage(record, runs, wholeRecord = record) {
  if (record === null || record === undefined) return null;
  const cohortSpan = spanOfInstants(
    runs.flatMap((run) => [run.startedAt, run.lastOutputAt, run.finishedAt]),
  ).span;
  const scopedSpan = record.coverageSpan ?? null;
  /*
   * Two different facts, and a refusal that reports only one of them misinforms. The scoped span is
   * what the record retains for this cohort, and it is what the verdict is taken on. The record span
   * is what the record observed at all, and naming it is the difference between a record that was
   * never read and one that was read and stops short of the cohort. Collapsing them reports a record
   * that covered a day and a half as having observed nothing.
   */
  const recordSpan = wholeRecord?.coverageSpan ?? scopedSpan;
  /*
   * A record that carries no coverage field at all says nothing about what it observed, and is read
   * as unbounded. A record that carries the field and holds null observed nothing of this cohort,
   * which is the opposite verdict, and the two must not collapse into one another.
   */
  const observedNothing = Object.hasOwn(record, "coverageSpan") && scopedSpan === null;
  const observedSpan =
    cohortSpan === null || observedNothing ? null : intersectSpans(cohortSpan, scopedSpan);
  const coversCohort = observedNothing ? false : cohortSpan === null || observedSpan !== null;
  return {
    cohortSpan,
    recordSpan,
    scopedSpan,
    observedSpan,
    coversCohort,
    uncoveredSpans: uncoveredSpans(cohortSpan, scopedSpan),
  };
}

function guardSide(record, runs, wholeRecord) {
  const coverage = describeCoverage(record, runs, wholeRecord);
  return {
    coverage,
    clauses: scoreGuardClauses(record, {
      coversSpan: coverage === null ? true : coverage.coversCohort,
      uncovered: coverage === null ? [] : coverage.uncoveredSpans,
    }),
  };
}

function buildGuardClausesBySide(supervisor, split, scoredSupervisor, coverage) {
  return {
    before: guardSide(sliceSupervisorRecordBefore(supervisor, split.cutoff), split.before, supervisor),
    after: {
      coverage,
      clauses: scoreGuardClauses(scoredSupervisor, {
        coversSpan: coverage === null ? true : coverage.coversCohort,
        uncovered: coverage === null ? [] : coverage.uncoveredSpans,
      }),
    },
  };
}

/**
 * One record per query. With no cutoff the whole history is one cohort. With a cutoff the same four
 * fields are reported for each side of it, and the caller never handles a timestamp itself.
 */
export function computeHealth(runs, { since = null, asOf = null, agentId = null, issues = null, supervisor = null } = {}) {
  const asOfInstant = asOf === null ? null : tryParseInstant(asOf);
  if (asOf !== null && asOfInstant === null) throw new Error(`asOf needs an instant, got ${asOf}`);
  const scoped = agentId ? runs.filter((run) => run.agentId === agentId) : runs;
  const split = splitByCutoff(scoped, since, (run) => run.startedAt);
  const cohorts =
    split.cutoff === null
      ? { window: summarizeCohort(split.after) }
      : { before: summarizeCohort(split.before), after: summarizeCohort(split.after) };
  const blocked =
    issues === null ? null : summarizeBlockedIssues(issues, { since: split.cutoff });
  const scored = cohorts.window ?? cohorts.after;
  /*
   * The supervisor record covers whatever span its files cover, which is not the span the cutoff
   * asks about. Scoring its clauses on the whole record while every other clause is scored on the
   * cohort after the cutoff reports evidence recorded before a repair as a verdict on the repair.
   */
  const scoredSupervisor =
    supervisor === null || split.cutoff === null
      ? supervisor
      : sliceSupervisorRecordAt(supervisor, split.cutoff);

  const coverage = describeCoverage(scoredSupervisor, split.after, supervisor);

  /*
   * The guard clauses are cohort clauses, so with a cutoff supplied they are reported on each side of
   * it the same as every other cohort number. Each side is read from its own slice of the record and
   * scored against its own coverage, so neither side inherits the other's events.
   */
  const guardClausesBySide =
    split.cutoff === null || supervisor === null
      ? null
      : buildGuardClausesBySide(supervisor, split, scoredSupervisor, coverage);

  return {
    metric: "heartbeat run health and per run liveness",
    query: {
      since: split.cutoff,
      asOf: asOfInstant === null ? null : asOfInstant.toISOString(),
      agentId,
      rows: scoped.length,
    },
    undatedRuns: split.undated.length,
    ...cohorts,
    blocked,
    supervisor,
    supervisorScored: scoredSupervisor,
    supervisorCoverage: coverage,
    guardClausesBySide,
    clauses: scoreClauses(scored, blocked, {
      supervisor: scoredSupervisor,
      supervisorCoversCohort: coverage === null ? true : coverage.coversCohort,
      supervisorUncoveredSpans: coverage === null ? [] : coverage.uncoveredSpans,
    }),
  };
}
