/**
 * Finding the supervisor's own record, rather than being handed it.
 *
 * The record was readable before this, but only when a caller supplied three constants by hand: the
 * file, the calendar day it covers, and the offset it was written at. A default reading therefore
 * scored nothing off it, and the two clauses that measure the output recency guard holes passed over
 * unscored. Worse, the file was one of several plausible ones in the same directory and the choice
 * silently inverted the verdict, so the number a reader got depended on the pick.
 *
 * Discovery removes all three constants. Every record in the directory is read, each is placed on
 * the calendar from the rows it names, and the placed ones are merged into one reading. A record
 * that names runs the cohort knows about but cannot be placed is a hole in the reading and is
 * refused, because a reading that quietly drops a supervisor restart scores zero of zero and reads
 * as a pass.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import {
  mergeSupervisorRecords,
  parseAnchoredSupervisorLog,
  summarizeSupervisorRecord,
} from "./supervisor-log.js";

/** Where the supervisor writes. The name is the runtime's, not this tool's, so nothing is invented. */
export const SUPERVISOR_RECORD_DIRECTORY_NAME = ".paperclip";

export function defaultSupervisorRecordDirectory(home = homedir()) {
  return join(home, SUPERVISOR_RECORD_DIRECTORY_NAME);
}

/** Files a supervisor record can be in. Everything else in the directory is skipped by name. */
export function isSupervisorRecordCandidate(name) {
  return name.endsWith(".log") && !name.endsWith(".err.log");
}

/**
 * The instants the rows record for runs a terminating line would have written. These are the only
 * anchors used, because a reap line and the finish instant it sets are the same write.
 */
export function terminalInstantsOf(runs) {
  const instants = new Map();
  for (const run of runs ?? []) {
    if (typeof run?.id === "string" && typeof run?.finishedAt === "string") {
      instants.set(run.id, run.finishedAt);
    }
  }
  return instants;
}

function cohortRunIds(runs) {
  return new Set((runs ?? []).map((run) => run?.id).filter((id) => typeof id === "string"));
}

/**
 * Reads every record in the directory and reports what each one is.
 *
 * A record with no supervisor lines at all is not a supervisor record and is not a gap. A record
 * with supervisor lines that names no run the cohort carries is outside the cohort and is excluded
 * with that reason. A record with supervisor lines that names runs the cohort carries and still
 * cannot be placed is a gap, and the caller is expected to refuse the reading rather than report it.
 */
export async function discoverSupervisorRecords({ directory, listFiles, readFile, runs }) {
  if (typeof directory !== "string" || directory.trim() === "") {
    throw new Error("discoverSupervisorRecords requires the directory the records are written to");
  }
  if (typeof listFiles !== "function") throw new Error("discoverSupervisorRecords requires a listFiles");
  if (typeof readFile !== "function") throw new Error("discoverSupervisorRecords requires a readFile");

  const terminalInstants = terminalInstantsOf(runs);
  const cohort = cohortRunIds(runs);

  const names = (await listFiles(directory)).filter(isSupervisorRecordCandidate).sort();
  const placed = [];
  const excluded = [];
  const gaps = [];

  for (const name of names) {
    const path = join(directory, name);
    const text = await readFile(path, "utf8");
    const read = parseAnchoredSupervisorLog(text, { terminalInstants });
    if (read.supervisorEvents === 0) {
      excluded.push({ path, reason: "carries no supervisor lines", supervisorEvents: 0 });
      continue;
    }
    if (read.anchor.placed) {
      placed.push({ path, anchor: read.anchor, parsed: read.parsed, supervisorEvents: read.supervisorEvents });
      continue;
    }
    const namesCohortRun = read.namedRunIds.some((runId) => cohort.has(runId));
    const entry = {
      path,
      reason: read.anchor.reason,
      supervisorEvents: read.supervisorEvents,
      namesCohortRun,
    };
    if (namesCohortRun) gaps.push(entry);
    else excluded.push({ ...entry, reason: `${read.anchor.reason}, and it names no run in this cohort` });
  }

  return { directory, candidates: names.length, placed, excluded, gaps };
}

/**
 * One reading over every record that could be placed, or a refusal naming the reason.
 *
 * The refusal is the point. Printing "not read" and leaving the clauses unscored is how a fail
 * became a pass, so a discovery that cannot see the record fails the command instead.
 */
export async function readDiscoveredSupervisorRecord(options) {
  const discovered = await discoverSupervisorRecords(options);
  if (discovered.gaps.length > 0) {
    const named = discovered.gaps
      .map((gap) => `${gap.path} (${gap.supervisorEvents} supervisor lines, ${gap.reason})`)
      .join("; ");
    throw new Error(
      `supervisor record discovery in ${discovered.directory} cannot place a record that names runs in this cohort: ${named}`,
    );
  }
  if (discovered.placed.length === 0) {
    throw new Error(
      `supervisor record discovery found no placeable record in ${discovered.directory}, over ${discovered.candidates} candidate files`,
    );
  }

  const merged = mergeSupervisorRecords(discovered.placed.map((record) => record.parsed));
  const summary = summarizeSupervisorRecord(merged);
  return {
    ...summary,
    discovery: {
      directory: discovered.directory,
      candidates: discovered.candidates,
      records: discovered.placed.map((record) => ({
        path: record.path,
        date: record.anchor.date,
        utcOffsetMinutes: record.anchor.utcOffsetMinutes,
        anchors: record.anchor.anchors,
        anchorSpreadSeconds: record.anchor.anchorSpreadSeconds,
        supervisorEvents: record.supervisorEvents,
      })),
      excluded: discovered.excluded.map((record) => ({ path: record.path, reason: record.reason })),
    },
  };
}
