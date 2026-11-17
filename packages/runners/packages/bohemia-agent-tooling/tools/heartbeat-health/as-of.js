/**
 * Reading a mutable run endpoint as it stood at an earlier instant.
 *
 * A run row keeps changing after it is first written. A run that was still running when a number was
 * read carries an error, a finish instant and a terminal status on the next read, so the same cutoff
 * over the same row count returns a larger lost cohort every time and a number quoted from an earlier
 * read cannot be re-scored. A snapshot prevents that going forward. It cannot recover a reading taken
 * before any snapshot existed.
 *
 * This projects a row back to the state the endpoint would have returned at a chosen instant, using
 * recorded columns only. A row that had not started yet is dropped. A row whose finish, error or last
 * output is stamped at or after the instant had not reached that state yet, so those columns are
 * cleared and the row reads as still running. No column is invented and no number is edited.
 */

import { tryParseInstant } from "../../src/instants.js";

/** Columns that only appear once a run has ended, and therefore have to be cleared together. */
const TERMINAL_COLUMNS = ["finishedAt", "error", "errorCode", "exitCode", "signal", "durationMs"];

function isAtOrAfter(value, instant) {
  const parsed = tryParseInstant(value);
  return parsed !== null && parsed.getTime() >= instant.getTime();
}

/**
 * Projects one row to its recorded state at the instant, or returns null when the row had not
 * started yet.
 */
export function projectRunAsOf(run, instant) {
  const startedAt = tryParseInstant(run?.startedAt);
  if (startedAt === null) return { ...run };
  if (startedAt.getTime() >= instant.getTime()) return null;

  const projected = { ...run };
  if (isAtOrAfter(run.lastOutputAt, instant)) projected.lastOutputAt = null;
  if (run.finishedAt === undefined || run.finishedAt === null || isAtOrAfter(run.finishedAt, instant)) {
    for (const column of TERMINAL_COLUMNS) {
      if (column in projected) projected[column] = null;
    }
    projected.status = "running";
  }
  return projected;
}

/**
 * Projects a set of rows to the state the endpoint would have returned at the instant. The instant is
 * parsed by the shared instant surface, so an offset free string reads as UTC on any host.
 */
export function projectRunsAsOf(runs, asOf) {
  const instant = tryParseInstant(asOf);
  if (instant === null) throw new Error(`--as-of needs an instant, got ${asOf}`);
  const projected = [];
  for (const run of runs) {
    const entry = projectRunAsOf(run, instant);
    if (entry !== null) projected.push(entry);
  }
  return projected;
}
