#!/usr/bin/env node
/**
 * Heartbeat run health collector. Command line entry point, no interface.
 *
 * One command answers both the whole history and an arbitrary cutoff window. Every field is computed
 * from recorded columns only, so two runs against unchanged history return byte identical JSON. No
 * caller handles a timestamp: the cutoff is parsed by the shared instant surface, which reads an
 * offset free string as UTC and therefore cannot invert the cohorts on a host whose local time is not
 * UTC. The endpoint itself is mutable, so --snapshot freezes the rows a reading was taken from and
 * --input rescores that frozen cohort.
 *
 * stdout carries the JSON record. stderr carries a small table for a reader.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { computeHealth } from "./health.js";
import { describeSpan } from "bohemia-agent-tooling";
import { projectRunsAsOf } from "./as-of.js";
import { createRunsSource } from "./runs-source.js";
import { createIssuesSource } from "./issues-source.js";
import { createSupervisorLogSource } from "./supervisor-log.js";
import {
  defaultSupervisorRecordDirectory,
  readDiscoveredSupervisorRecord,
} from "./supervisor-discovery.js";

const USAGE = `heartbeat health collector

  node tools/heartbeat-health/cli.js [options]

  --since <iso>     split the rows on this cutoff and report both cohorts
  --as-of <iso>     score the rows as the endpoint would have returned them at this
                    instant, so a reading quoted before any snapshot existed can be
                    re-scored from recorded columns
  --limit <n>       rows to read from the endpoint, default 500
  --agent <id>      restrict to one agent id
  --input <file>    read rows from a saved json file instead of the endpoint
  --snapshot <file> write the exact rows read to this file, so the same cohort can be
                    rescored later with --input and return the same numbers
  --no-issues       skip the blocked issue read and report the board clause as null
  --supervisor-log <file>   read one supervisor record from this file instead of discovering
                    every record. Needs the two constants below, because a single file carries
                    neither the day it covers nor the offset it was written at
  --supervisor-log-date <YYYY-MM-DD>   the date that record covers, required with --supervisor-log
  --supervisor-log-offset <minutes>    the offset that record was written at, required with it
  --supervisor-log-dir <dir>   the directory the supervisor writes its records to, default the
                    runtime's own directory in the home directory. Discovery reads every record
                    there, places each one on the calendar from the rows it names, and merges them
  --no-supervisor   do not read the supervisor's record at all, leaving the two clauses it scores
                    unscored. This is a deliberate refusal, not the default
  --quiet           write the json only, no table on stderr
  --help            print this text

Environment when reading the endpoint: PAPERCLIP_API_URL, PAPERCLIP_API_KEY,
PAPERCLIP_COMPANY_ID.
`;

export function parseArgs(argv) {
  const options = {
    since: null,
    asOf: null,
    limit: 500,
    agentId: null,
    input: null,
    snapshot: null,
    issues: true,
    supervisorLog: null,
    supervisorLogDate: null,
    supervisorLogOffsetMinutes: null,
    supervisorLogDirectory: null,
    supervisor: true,
    quiet: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--since":
        options.since = takeValue();
        break;
      case "--as-of":
        options.asOf = takeValue();
        break;
      case "--limit":
        options.limit = Number(takeValue());
        if (!Number.isFinite(options.limit) || options.limit <= 0) {
          throw new Error("--limit needs a positive number");
        }
        break;
      case "--agent":
        options.agentId = takeValue();
        break;
      case "--input":
        options.input = takeValue();
        break;
      case "--snapshot":
        options.snapshot = takeValue();
        break;
      case "--no-issues":
        options.issues = false;
        break;
      case "--supervisor-log":
        options.supervisorLog = takeValue();
        break;
      case "--supervisor-log-date":
        options.supervisorLogDate = takeValue();
        break;
      case "--supervisor-log-offset":
        options.supervisorLogOffsetMinutes = Number(takeValue());
        if (!Number.isFinite(options.supervisorLogOffsetMinutes)) {
          throw new Error("--supervisor-log-offset needs a number of minutes");
        }
        break;
      case "--supervisor-log-dir":
        options.supervisorLogDirectory = takeValue();
        break;
      case "--no-supervisor":
        options.supervisor = false;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

/**
 * The supplied reading stays available and stays strict: asking for one file without the date and
 * offset it needs is refused rather than guessed, because a guessed offset shifts every instant in
 * it and would put a restart on the wrong side of the terminations it is being correlated to. The
 * default reading supplies none of the three and derives all of them, so the two constants only
 * appear alongside the file they belong to.
 */
export function assertSupervisorLogOptions(options) {
  if (options.supervisorLog === null) {
    if (options.supervisorLogDate !== null || options.supervisorLogOffsetMinutes !== null) {
      throw new Error("--supervisor-log-date and --supervisor-log-offset need --supervisor-log");
    }
    if (!options.supervisor && options.supervisorLogDirectory !== null) {
      throw new Error("--supervisor-log-dir and --no-supervisor contradict each other");
    }
    return;
  }
  if (!options.supervisor) {
    throw new Error("--supervisor-log and --no-supervisor contradict each other");
  }
  if (options.supervisorLogDirectory !== null) {
    throw new Error("--supervisor-log names one record, so it cannot be combined with --supervisor-log-dir");
  }
  if (options.supervisorLogDate === null) {
    throw new Error("--supervisor-log needs --supervisor-log-date, the record carries no date");
  }
  if (options.supervisorLogOffsetMinutes === null) {
    throw new Error("--supervisor-log needs --supervisor-log-offset, the record carries no offset");
  }
}

function cohortLine(name, cohort) {
  const lost = cohort.processLostShare === null ? "n/a" : `${cohort.processLostShare}%`;
  const succeeded = cohort.succeededShare === null ? "n/a" : `${cohort.succeededShare}%`;
  const discarded = cohort.discardedShare === null ? "n/a" : `${cohort.discardedShare}%`;
  return [
    name.padEnd(7),
    `${String(cohort.processLostRuns).padStart(4)} of ${String(cohort.startedRuns).padStart(4)} process lost (${lost})`,
    `${String(cohort.succeededRuns).padStart(4)} of ${String(cohort.finishedRuns).padStart(4)} succeeded (${succeeded})`,
    `${cohort.finishedRunMinutes} finished minutes, ${cohort.lostRunMinutes} lost minutes, ${discarded} discarded`,
  ].join(" | ");
}

export function renderTable(health) {
  const lines = [
    `metric: ${health.metric}`,
    `rows: ${health.query.rows}, cutoff: ${health.query.since ?? "none"}, as of: ${health.query.asOf ?? "now"}, agent: ${health.query.agentId ?? "all"}, undated: ${health.undatedRuns}`,
  ];
  const cohorts = health.window
    ? [["window", health.window]]
    : [
        ["before", health.before],
        ["after", health.after],
      ];
  for (const [name, cohort] of cohorts) lines.push(cohortLine(name, cohort));

  lines.push("error signatures:");
  for (const [name, cohort] of cohorts) {
    if (cohort.errorSignatures.length === 0) {
      lines.push(`  ${name}: none`);
      continue;
    }
    for (const entry of cohort.errorSignatures.slice(0, 10)) {
      lines.push(`  ${name}: ${String(entry.count).padStart(4)}  ${entry.signature}`);
    }
  }

  for (const [name, cohort] of cohorts) lines.push(...livenessLines(name, cohort.liveness));
  for (const [name, cohort] of cohorts) lines.push(retryLine(name, cohort.retries));
  for (const [name, cohort] of cohorts) lines.push(...chainLines(name, cohort.chains));
  for (const [name, cohort] of cohorts) lines.push(...perAgentLines(name, cohort.perAgentLoss));
  for (const [name, cohort] of cohorts) lines.push(...dispatchLines(name, cohort.dispatch));

  if (health.supervisor === undefined || health.supervisor === null) {
    lines.push("supervisor record: not read");
  } else {
    const discovery = health.supervisor.discovery;
    if (discovery) {
      lines.push(
        `supervisor record discovery: ${discovery.records.length} of ${discovery.candidates} candidate files in ${discovery.directory} placed from the rows they name, ${discovery.excluded.length} excluded`,
      );
      for (const record of discovery.records) {
        lines.push(
          `  ${record.path}  ${record.date} at offset ${record.utcOffsetMinutes} minutes, from ${record.anchors} anchors agreeing within ${record.anchorSpreadSeconds} seconds, ${record.supervisorEvents} supervisor lines`,
        );
      }
      for (const record of discovery.excluded) {
        lines.push(`  excluded ${record.path}  ${record.reason}`);
      }
    }
    lines.push(
      `supervisor record: ${health.supervisor.startups} startups on ${health.supervisor.date}, ${health.supervisor.guardSkippedRuns} runs skipped by the output recency guard, ${health.supervisor.reapedRuns} reaped, ${health.supervisor.staleLockTerminalizedRuns} terminalized in a stale lock sweep, ${health.supervisor.guardHoleRuns} skipped by the guard and terminalized anyway`,
    );
    lines.push(
      `guard holes by terminating path: ${health.supervisor.guardHolesByTerminatingPath.map((entry) => `${entry.count} ${entry.key}, ${entry.withoutAuthority} of them recording no authority`).join("; ") || "none"}, ${health.supervisor.guardHolesWithoutRecordedAuthority} of ${health.supervisor.guardHoleRuns} holes record no authority at all`,
    );
    for (const hole of health.supervisor.guardHoles.slice(0, 10)) {
      lines.push(
        `  ${hole.runId}  skipped at ${hole.skippedAt} with output ${hole.recentOutputAgeMs} ms old and pid ${hole.processPid ?? "none"}, terminalized ${hole.secondsAfterSkip} seconds later by ${hole.terminalizedBy} on authority ${hole.authority ?? "none"} as ${hole.terminalStatus ?? "none"}`,
      );
    }
    const scoredRecord = health.supervisorScored;
    if (scoredRecord && scoredRecord.sinceCutoff) {
      lines.push(
        `supervisor record scored on the cohort: ${scoredRecord.startups} startups, ${scoredRecord.guardSkippedRuns} runs skipped by the guard, ${scoredRecord.guardHoleRuns} skipped and terminalized anyway, ${scoredRecord.guardExpiryKills} at the instant the guard expired, from the events at or after ${scoredRecord.sinceCutoff}`,
      );
      lines.push(
        `  the two guard clauses read this slice, not the whole record. The record above spans ${(health.supervisor.dates ?? [health.supervisor.date]).join(", ")}`,
      );
    }
    const coverage = health.supervisorCoverage;
    if (coverage && !coverage.coversCohort) {
      lines.push(
        `supervisor coverage: the record observed ${describeSpan(coverage.recordSpan)} and the cohort spans ${describeSpan(coverage.cohortSpan)}, which it never observed`,
      );
      lines.push(
        `  the two guard clauses are not scored, because a record that did not observe the cohort would read zero of zero as a pass. Uncovered: ${coverage.uncoveredSpans.map(describeSpan).join("; ") || "none"}`,
      );
    }
  }

  if (health.blocked === null) {
    lines.push("blocked issues: not read");
  } else {
    lines.push(
      `blocked issues: ${health.blocked.withoutWakePath} of ${health.blocked.blockedIssuesInWindow} in window carry no wake path, ${health.blocked.withoutBlockers} of those carry no blocker`,
    );
    for (const issue of health.blocked.issues.slice(0, 10)) {
      lines.push(`  ${issue.identifier}  ${issue.blockedTransitionAt ?? "no transition instant"}`);
    }
    lines.push(
      `blocked chains: ${health.blocked.chainTerminalsWithoutWakePath} of ${health.blocked.blockedIssues} blocked issues are chain terminals with no wake path, stranding ${health.blocked.strandedDependents} dependents, ${health.blocked.strandedIssueCount} issues stranded in total, ${health.blocked.strandedWithoutUnblockDescriptor} of them recording no unblock owner and action`,
    );
    for (const terminal of health.blocked.chainTerminals.slice(0, 10)) {
      lines.push(
        `  ${terminal.identifier}  no blocker and no monitor, stranding ${terminal.strandedDependents} behind it: ${terminal.strandedDependentIdentifiers.join(", ") || "none"}`,
      );
    }
  }

  lines.push("clauses:");
  for (const [name, clause] of Object.entries(health.clauses)) {
    const verdict = clause.pass === null ? "not scored" : clause.pass ? "pass" : "fail";
    lines.push(`  ${verdict.padEnd(9)} ${clause.number ?? "n/a"} of ${clause.of ?? "n/a"}, target ${clause.target}  ${name}`);
    if (clause.pass === null && Array.isArray(clause.notScoredOver) && clause.notScoredOver.length > 0) {
      lines.push(
        `            not scored over ${clause.notScoredOver.map(describeSpan).join("; ")}, which the supervisor record never observed`,
      );
    }
  }

  if (health.guardClausesBySide) {
    lines.push("guard clauses on each side of the cutoff:");
    for (const side of ["before", "after"]) {
      const reading = health.guardClausesBySide[side];
      for (const [name, clause] of Object.entries(reading.clauses)) {
        const verdict = clause.pass === null ? "not scored" : clause.pass ? "pass" : "fail";
        lines.push(
          `  ${side.padEnd(6)} ${verdict.padEnd(9)} ${clause.number ?? "n/a"} of ${clause.of ?? "n/a"}, target ${clause.target}  ${name}`,
        );
      }
      if (reading.coverage && !reading.coverage.coversCohort) {
        lines.push(
          `  ${side.padEnd(6)} the record observed ${describeSpan(reading.coverage.recordSpan)} and this side spans ${describeSpan(reading.coverage.cohortSpan)}`,
        );
      }
    }
  }
  return lines.join("\n");
}

function gapRange(gap) {
  return gap.minimum === null ? "no gaps" : `${gap.minimum} to ${gap.maximum} minutes, mean ${gap.mean}`;
}

function livenessLines(name, liveness) {
  const lines = [
    `${name} liveness: ${liveness.terminatedRuns} runs ended by something other than themselves, ${liveness.insideOutputRecencyGuard.count} inside the ${liveness.outputRecencyGuardMinutes} minute output recency guard, ${liveness.atOutputRecencyGuardBoundary.count} pinned to the guard boundary, ${liveness.noOutputRuns} with no output, ${liveness.recordedOutcome.withoutOutcome} with no recorded outcome`,
  ];
  for (const [className, klass] of Object.entries(liveness.classes)) {
    if (klass.runs === 0) continue;
    lines.push(
      `  ${className}: ${klass.runs} runs, quiet gap ${gapRange(klass.quietGapMinutes)}, ${klass.insideOutputRecencyGuard.count} inside the guard, ${klass.atOutputRecencyGuardBoundary.count} pinned to the guard boundary, ${klass.noOutputRuns} with no output`,
    );
    lines.push(
      `    productive lifetime ${spread(klass.productiveLifetimeMinutes)} minutes, detection latency ${spread(klass.detectionLatencyMinutes)} minutes, ${klass.detectionLatencyMinutes.total ?? 0} minutes not knowing`,
    );
    lines.push(
      `    recorded outcome ${klass.recordedOutcome.count} of ${klass.recordedOutcome.of}: ${klass.recordedOutcome.withExitCode} carry an exit code, ${klass.recordedOutcome.withSignal} carry a signal, ${klass.recordedOutcome.byOutcome.map((entry) => `${entry.count} ${entry.key}`).join(", ")}`,
    );
    const mass = klass.massInstants;
    lines.push(
      `    ${mass.instantCount} silence instants of ${mass.bucketSeconds} seconds on last output, ${mass.runsWithNoLastOutput} runs carry no last output`,
    );
    for (const instant of mass.instants.slice(0, 10)) {
      lines.push(`      ${instant.instant}  ${instant.runs} runs, ${instant.agents} agents`);
    }
    lines.push(
      `    ${mass.windowCount} windows of ${mass.bucketSeconds} seconds carry ${mass.runsInWindows} runs from ${mass.agentThreshold} or more agents, largest ${mass.largestWindowAgents} agents`,
    );
    for (const window of mass.windows) {
      lines.push(`      ${window.instant}  ${window.runs} runs, ${window.agents} agents`);
    }
    for (const instant of klass.terminationInstants ?? []) {
      lines.push(`    ${instant.instant}  ${instant.runs} runs, ${instant.agents} agents`);
    }
    const correlation = klass.correlatedToBackstopInstants;
    if (correlation) {
      lines.push(
        `    ${correlation.count} of ${correlation.of} died within ${correlation.toleranceMinutes} minutes of a backstop instant`,
      );
    }
  }
  return lines;
}

function spread(summary) {
  return summary.count === 0
    ? "none"
    : `${summary.minimum} to ${summary.maximum}, mean ${summary.mean}`;
}

function retryLine(name, retries) {
  const parts = [
    `${retries.retryRuns} retry runs of ${retries.rows} rows (${retries.retryShare ?? "n/a"} percent)`,
    `${retries.lostAgain} lost again`,
    ...retries.byStatus.map((entry) => `${entry.count} ${entry.key}`),
    `${retries.rowsAtRetryCountCap} of ${retries.rows} rows sit at the retry count cap of ${retries.retryCountCap ?? "none"}`,
    `${retries.lostRunsWithNoRetry} lost runs carry no retry`,
  ];
  return `${name} retries: ${parts.join(", ")}`;
}

function chainLines(name, chains) {
  const lines = [
    `${name} chains: ${chains.chains} wake chains over ${chains.rows} rows, ${chains.settledChains} settled, ${chains.runningChains} still running, ${chains.awaitingRetryChains} awaiting a scheduled retry, ${chains.detachedChains} starting outside the window`,
    `  ${chains.abandonedChains} of ${chains.settledChains} settled chains abandoned (${chains.abandonedShare ?? "n/a"} percent), ${chains.abandonedAtRetryCountCap} at the retry count cap of ${chains.retryCountCap ?? "none"}, ${chains.abandonedWithoutRecordedReason} carry no recorded reason`,
    `  ${chains.succeededChains} of ${chains.settledChains} settled chains succeeded (${chains.succeededShare ?? "n/a"} percent), outcomes ${chains.byOutcome.map((entry) => `${entry.count} ${entry.key}`).join(", ")}`,
    `  attempts per chain ${spread(chains.attempts)}`,
  ];
  for (const entry of chains.abandonedChainDetail.slice(0, 10)) {
    lines.push(
      `    ${entry.finishedAt ?? "no finish"}  ${entry.terminalId}  ${entry.attempts} attempts, retry count ${entry.retryCount ?? "none"}, reason ${entry.abandonmentReason ?? "none"}`,
    );
  }
  return lines;
}

function dispatchLines(name, dispatch) {
  if (!dispatch) return [`${name} dispatch: not computed`];
  const lines = [
    `${name} dispatch: ${dispatch.gapCount} gaps of ${dispatch.minimumGapMinutes} minutes or more, ${dispatch.gapMinutes} minutes with nothing dispatched, widest ${dispatch.widestGap ? `${dispatch.widestGap.minutes} minutes from ${dispatch.widestGap.from}` : "none"}`,
    `  ${dispatch.lostRunsSilencedWhileStillDispatching} lost runs went quiet while the supervisor was still dispatching (${dispatch.silencedWhileStillDispatchingShare ?? "n/a"} percent), ${dispatch.lostRunsSilencedDuringADispatchGap} inside a dispatch gap, ${dispatch.lostRunsWithNoSilenceInstant} with no silence instant`,
  ];
  for (const gap of dispatch.gaps.slice(0, 10)) {
    lines.push(`    ${gap.from} to ${gap.to}  ${gap.minutes} minutes`);
  }
  return lines;
}

function perAgentLines(name, perAgent) {
  const lines = [
    `${name} per agent loss: ${perAgent.affectedAgentCount} of ${perAgent.agentCount} agents affected, from ${perAgent.lowestAffectedShare ?? "none"} to ${perAgent.highestAffectedShare ?? "none"} percent`,
  ];
  for (const entry of perAgent.agents) {
    lines.push(
      `  ${entry.agentId}  ${entry.processLostRuns} of ${entry.startedRuns} lost (${entry.processLostShare} percent)`,
    );
  }
  return lines;
}

export async function readRows(options, env) {
  if (options.input) {
    const payload = JSON.parse(await readFile(options.input, "utf8"));
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.runs)) return payload.runs;
    if (Array.isArray(payload?.data)) return payload.data;
    throw new Error(`${options.input} holds no array of runs`);
  }
  const source = createRunsSource({
    baseUrl: env.PAPERCLIP_API_URL,
    apiKey: env.PAPERCLIP_API_KEY,
    companyId: env.PAPERCLIP_COMPANY_ID,
  });
  return source.readRuns({ limit: options.limit });
}

/**
 * Freezes the exact rows a reading was taken from. The endpoint is mutable: a run that was still
 * running when a number was read becomes a lost run later, so the same cutoff over the same row count
 * returns a different cohort on the next read and a number quoted from an earlier read cannot be
 * reproduced. Writing the rows alongside the reading makes the cohort rescorable with --input.
 */
export async function writeSnapshot(file, rows) {
  await writeFile(file, `${JSON.stringify({ runs: rows }, null, 2)}\n`, "utf8");
}

export async function readIssues(options, env) {
  if (!options.issues || options.input) return null;
  const source = createIssuesSource({
    baseUrl: env.PAPERCLIP_API_URL,
    apiKey: env.PAPERCLIP_API_KEY,
    companyId: env.PAPERCLIP_COMPANY_ID,
  });
  return source.readBlockedIssues();
}

export async function readSupervisorRecord(options, rows, deps = {}) {
  if (!options.supervisor) return null;
  const readFileImpl = deps.readFile ?? readFile;
  if (options.supervisorLog !== null) {
    const source = createSupervisorLogSource({ readFile: readFileImpl });
    return source.readRecord({
      path: options.supervisorLog,
      date: options.supervisorLogDate,
      utcOffsetMinutes: options.supervisorLogOffsetMinutes,
    });
  }
  return readDiscoveredSupervisorRecord({
    directory: options.supervisorLogDirectory ?? defaultSupervisorRecordDirectory(),
    listFiles: deps.listFiles ?? readdir,
    readFile: readFileImpl,
    runs: rows,
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseArgs(argv);
    assertSupervisorLogOptions(options);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    process.stderr.write(USAGE);
    return 0;
  }

  try {
    const rows = await readRows(options, env);
    if (options.snapshot) await writeSnapshot(options.snapshot, rows);
    const scored = options.asOf === null ? rows : projectRunsAsOf(rows, options.asOf);
    const issues = await readIssues(options, env);
    const supervisor = await readSupervisorRecord(options, scored);
    const health = computeHealth(scored, {
      since: options.since,
      asOf: options.asOf,
      agentId: options.agentId,
      issues,
      supervisor,
    });
    process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
    if (!options.quiet) process.stderr.write(`${renderTable(health)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`heartbeat health collection failed: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main();
}
