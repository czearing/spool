/**
 * The supervisor's own record, read as a source.
 *
 * OFF-67 offered file modification times as correlating evidence for a restart taking every in
 * flight child with it. A modification time is the last write to a file, not a write history, so
 * that reading can only ever be an inference. The supervisor writes its own record of what it did
 * on startup, and that record names the runs, so reading it turns the inference into a reading.
 *
 * The record carries a wall clock time of day with no date and no offset, which is the same trap
 * the shared core owns for API timestamps and cannot be solved by guessing here. The date the log
 * covers and the offset it was written at can be supplied by a caller, or derived from the record
 * itself against the rows it names: a line that terminalizes a run is the same write that set that
 * run's finish instant, so the pair of a time of day and a recorded instant places the record on the
 * calendar without anyone guessing. Nothing in this file reads the clock or the local zone.
 */

import { parseInstant, tryParseInstant } from "../../src/instants.js";
import {
  intersectSpans,
  makeSpan,
  spanOfInstants,
} from "../../src/spans.js";

const CLOCK_PATTERN = /^\[(\d{2}):(\d{2}):(\d{2})\]\s+(\w+):\s+(.*)$/;

/**
 * The record is written for a terminal, so it carries colour escapes around the level, the message
 * and the payload. They are presentation and never content, and a reader that leaves them in place
 * fails to match every line in the file while reporting an empty record rather than an error.
 */
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function stripPresentation(line) {
  return line.replace(ANSI_PATTERN, "");
}

/** The lines the supervisor writes about a run it decided the fate of, and what each one means. */
export const SUPERVISOR_EVENTS = Object.freeze({
  GUARD_SKIP: "guard_skip",
  REAP: "reap",
  STALE_LOCK_TERMINALIZE: "stale_lock_terminalize",
  STARTUP_REAP_COMPLETE: "startup_reap_complete",
  LISTENING: "listening",
});

const MESSAGE_EVENTS = [
  ["skipping orphan reap for heartbeat run that is still producing output", SUPERVISOR_EVENTS.GUARD_SKIP],
  ["reaped orphaned heartbeat runs", SUPERVISOR_EVENTS.REAP],
  ["terminalized orphaned running heartbeat run in stale-lock sweep", SUPERVISOR_EVENTS.STALE_LOCK_TERMINALIZE],
  ["startup reap of orphaned heartbeat runs complete", SUPERVISOR_EVENTS.STARTUP_REAP_COMPLETE],
  ["Server listening", SUPERVISOR_EVENTS.LISTENING],
];

function classifyMessage(message) {
  for (const [needle, event] of MESSAGE_EVENTS) {
    if (message.startsWith(needle)) return event;
  }
  return null;
}

function readPayload(rest) {
  const start = rest.indexOf("{");
  if (start === -1) return {};
  try {
    return JSON.parse(rest.slice(start));
  } catch {
    return {};
  }
}

function offsetMinutesOf(value) {
  if (!Number.isFinite(value)) {
    throw new Error("a supervisor record needs the offset in minutes it was written at");
  }
  return value;
}

/**
 * The record as it stands before anyone knows what day it covers: a time of day, the number of
 * midnights the file has crossed by that line, and the payload. This is everything the file itself
 * carries, and it is separated out because both the supplied reading and the derived reading need
 * it. A line whose clock jumps backwards by more than an hour is a midnight crossing rather than an
 * out of order write, which is the same rule the supplied reading has always used.
 */
export function readSupervisorClockEvents(text) {
  if (typeof text !== "string") throw new Error("readSupervisorClockEvents requires the record as text");

  const events = [];
  let previousSeconds = null;
  let dayIndex = 0;

  for (const line of text.split(/\r?\n/)) {
    const match = CLOCK_PATTERN.exec(stripPresentation(line).trim());
    if (match === null) continue;
    const [, hours, minutes, seconds, level, rest] = match;
    const secondsOfDay = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
    if (previousSeconds !== null && secondsOfDay < previousSeconds - 3600) dayIndex += 1;
    previousSeconds = secondsOfDay;

    const event = classifyMessage(rest);
    if (event === null) continue;

    const payload = readPayload(rest);
    const runIds = Array.isArray(payload.runIds)
      ? payload.runIds
      : typeof payload.runId === "string"
        ? [payload.runId]
        : [];

    events.push({ secondsOfDay, dayIndex, level: level.toLowerCase(), event, runIds, payload });
  }

  return events;
}

/** The instant a clock event happened, given the local midnight the record's first day started at. */
function instantOf(clockEvent, localMidnightMs) {
  return new Date(
    localMidnightMs + (clockEvent.secondsOfDay + clockEvent.dayIndex * 86400) * 1000,
  ).toISOString();
}

function datedEvents(clockEvents, localMidnightMs) {
  return clockEvents.map((clockEvent) => ({
    instant: instantOf(clockEvent, localMidnightMs),
    level: clockEvent.level,
    event: clockEvent.event,
    runIds: clockEvent.runIds,
    payload: clockEvent.payload,
  }));
}

/**
 * Turns one day of the supervisor's record into events with real instants. The date and the offset
 * are the caller's because the record does not carry either, and a record that rolls past midnight
 * is rejected rather than silently folded back onto the same day.
 */
export function parseSupervisorLog(text, { date, utcOffsetMinutes } = {}) {
  if (typeof text !== "string") throw new Error("parseSupervisorLog requires the record as text");
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("parseSupervisorLog requires the date the record covers as YYYY-MM-DD");
  }
  const offset = offsetMinutesOf(utcOffsetMinutes);
  const localMidnightMs = parseInstant(`${date}T00:00:00Z`).getTime() - offset * 60000;

  return {
    date,
    utcOffsetMinutes: offset,
    events: datedEvents(readSupervisorClockEvents(text), localMidnightMs),
  };
}

/**
 * The granularity every real world offset from UTC is a whole multiple of. Rounding the derived
 * local midnight to it absorbs the seconds between a terminating line and the row write it set,
 * without ever inventing an offset no zone uses.
 */
const OFFSET_GRANULARITY_MS = 15 * 60 * 1000;

/** How far the anchors may disagree before the record is treated as unplaceable rather than dated. */
export const ANCHOR_SPREAD_LIMIT_MS = 5 * 60 * 1000;

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Places a record on the calendar from the rows it names.
 *
 * A reap line and a stale lock sweep line are the writes that set the finish instant of the runs they
 * name, so the pair of the line's time of day and that run's recorded finish instant fixes the local
 * midnight the record's first day started at. Several such pairs are taken and the middle one is
 * used, so a single odd row cannot move the reading, and the pairs are required to agree because a
 * record that cannot be placed must say so rather than be placed anywhere.
 *
 * Nothing here reads a clock or a zone database. The offset comes out of the arithmetic: a local
 * midnight is a whole number of quarter hours away from a UTC midnight, and only one offset within
 * half a day satisfies that.
 */
export function anchorSupervisorRecord(clockEvents, { terminalInstants } = {}) {
  if (!Array.isArray(clockEvents)) throw new Error("anchorSupervisorRecord requires clock events");
  if (!(terminalInstants instanceof Map)) {
    throw new Error("anchorSupervisorRecord requires a map of run id to recorded terminal instant");
  }

  const midnights = [];
  for (const clockEvent of clockEvents) {
    if (
      clockEvent.event !== SUPERVISOR_EVENTS.REAP &&
      clockEvent.event !== SUPERVISOR_EVENTS.STALE_LOCK_TERMINALIZE
    ) {
      continue;
    }
    for (const runId of clockEvent.runIds) {
      const recorded = terminalInstants.get(runId);
      if (typeof recorded !== "string") continue;
      const recordedMs = parseInstant(recorded).getTime();
      midnights.push(recordedMs - (clockEvent.secondsOfDay + clockEvent.dayIndex * 86400) * 1000);
    }
  }

  if (midnights.length === 0) {
    return { placed: false, reason: "no line in the record terminalizes a run the rows record a finish for", anchors: 0 };
  }

  const middle = median(midnights);
  const spreadMs = Math.max(...midnights.map((value) => Math.abs(value - middle)));
  if (spreadMs > ANCHOR_SPREAD_LIMIT_MS) {
    return {
      placed: false,
      reason: `the lines that name recorded runs disagree on the day by ${Math.round(spreadMs / 60000)} minutes`,
      anchors: midnights.length,
    };
  }

  const localMidnightMs = Math.round(middle / OFFSET_GRANULARITY_MS) * OFFSET_GRANULARITY_MS;
  const minutesOfEpoch = localMidnightMs / 60000;
  let utcOffsetMinutes = -(((minutesOfEpoch % 1440) + 1440) % 1440);
  if (utcOffsetMinutes <= -720) utcOffsetMinutes += 1440;
  const date = new Date(localMidnightMs + utcOffsetMinutes * 60000).toISOString().slice(0, 10);

  return {
    placed: true,
    date,
    utcOffsetMinutes,
    localMidnightMs,
    anchors: midnights.length,
    anchorSpreadSeconds: Math.round(spreadMs / 1000),
  };
}

/** The record read with the placement it derived, so a reading always says how it was dated. */
export function parseAnchoredSupervisorLog(text, { terminalInstants } = {}) {
  const clockEvents = readSupervisorClockEvents(text);
  const namedRunIds = [...new Set(clockEvents.flatMap((clockEvent) => clockEvent.runIds))];
  const anchor = anchorSupervisorRecord(clockEvents, { terminalInstants });
  if (!anchor.placed) {
    return { anchor, parsed: null, supervisorEvents: clockEvents.length, namedRunIds };
  }
  return {
    anchor,
    supervisorEvents: clockEvents.length,
    namedRunIds,
    parsed: {
      date: anchor.date,
      utcOffsetMinutes: anchor.utcOffsetMinutes,
      events: datedEvents(clockEvents, anchor.localMidnightMs),
    },
  };
}

/**
 * One reading over several records. A supervisor restart into a new file, and a cohort that crosses
 * midnight, are both the same shape: the runs are one population and the files are an accident of
 * where the writing went. Events are merged in instant order so the first occurrence of a run in the
 * merged record is the first occurrence in time, which is what every count below is defined on.
 */
export function mergeSupervisorRecords(parsedRecords) {
  if (!Array.isArray(parsedRecords) || parsedRecords.length === 0) {
    throw new Error("mergeSupervisorRecords requires at least one parsed record");
  }
  const events = parsedRecords
    .flatMap((record) => record.events)
    .sort((left, right) => left.instant.localeCompare(right.instant));
  const dates = [...new Set(parsedRecords.map((record) => record.date))].sort();
  return { date: dates.join(" to "), dates, events };
}

/**
 * The window the supervisor spares a run inside, and how close to its far edge a termination has to
 * land before it is read as the guard expiring rather than an unrelated death. Both are named here
 * because the record carries neither, and both are reported back so a reading says what it assumed.
 */
export const DEFAULT_OUTPUT_RECENCY_GUARD_MS = 10 * 60 * 1000;
export const DEFAULT_GUARD_EXPIRY_TOLERANCE_MS = 60 * 1000;

/**
 * What the record says the supervisor did, as counts a clause can be scored on.
 *
 * The field that matters most is the guard hole: a run the orphan reaper skipped because it was
 * still producing output, which another path on the same startup terminalized anyway. The output
 * recency guard only holds on the path it was added to, and a run in that set is a live run being
 * discarded by the path the guard was never put in front of.
 *
 * The second field separates the two ways a guard can fail, which the hole count alone cannot tell
 * apart. A guard that prevents a wrong verdict leaves the run alive. A guard that only delays one
 * leaves the run alive until the instant its output age crosses the window, and then the same
 * verdict lands. The record carries the output age at the moment of the skip and the seconds from
 * the skip to the termination, so the output age at termination is a sum of two recorded fields.
 * When that sum piles up on the far edge of the window the guard moved the counter and did not
 * repair the mechanism, and an operator reading only the inside-the-guard count sees a pass.
 */
export function summarizeSupervisorRecord(parsed, {
  outputRecencyGuardMs = DEFAULT_OUTPUT_RECENCY_GUARD_MS,
  guardExpiryToleranceMs = DEFAULT_GUARD_EXPIRY_TOLERANCE_MS,
} = {}) {
  if (!parsed || !Array.isArray(parsed.events)) {
    throw new Error("summarizeSupervisorRecord requires a parsed supervisor record");
  }
  if (!Number.isFinite(outputRecencyGuardMs) || outputRecencyGuardMs <= 0) {
    throw new Error("summarizeSupervisorRecord requires the output recency guard in milliseconds");
  }
  if (!Number.isFinite(guardExpiryToleranceMs) || guardExpiryToleranceMs < 0) {
    throw new Error("summarizeSupervisorRecord requires the guard expiry tolerance in milliseconds");
  }

  const guardSkips = new Map();
  const reaped = new Map();
  const staleLockTerminalized = new Map();
  const startupInstants = [];

  for (const entry of parsed.events) {
    if (entry.event === SUPERVISOR_EVENTS.LISTENING) {
      startupInstants.push(entry.instant);
      continue;
    }
    if (entry.event === SUPERVISOR_EVENTS.STARTUP_REAP_COMPLETE) {
      startupInstants.push(entry.instant);
      continue;
    }
    for (const runId of entry.runIds) {
      if (entry.event === SUPERVISOR_EVENTS.GUARD_SKIP) {
        if (!guardSkips.has(runId)) guardSkips.set(runId, entry);
      } else if (entry.event === SUPERVISOR_EVENTS.REAP) {
        if (!reaped.has(runId)) reaped.set(runId, entry);
      } else if (entry.event === SUPERVISOR_EVENTS.STALE_LOCK_TERMINALIZE) {
        if (!staleLockTerminalized.has(runId)) staleLockTerminalized.set(runId, entry);
      }
    }
  }

  const holes = [];
  for (const [runId, skip] of guardSkips) {
    const terminalizer = staleLockTerminalized.get(runId) ?? reaped.get(runId) ?? null;
    if (terminalizer === null) continue;
    if (parseInstant(terminalizer.instant).getTime() < parseInstant(skip.instant).getTime()) continue;
    const recentOutputAgeMs =
      typeof skip.payload.recentOutputAgeMs === "number" ? skip.payload.recentOutputAgeMs : null;
    const secondsAfterSkip =
      Math.round(
        ((parseInstant(terminalizer.instant).getTime() - parseInstant(skip.instant).getTime()) / 1000) * 100,
      ) / 100;
    // The age of the run's last output at the moment it was terminalized, from two recorded fields.
    // Nothing here reads a clock, so the same record always returns the same number.
    const outputAgeAtTerminalizationMs =
      recentOutputAgeMs === null ? null : recentOutputAgeMs + secondsAfterSkip * 1000;
    const atGuardExpiry =
      outputAgeAtTerminalizationMs !== null &&
      Math.abs(outputAgeAtTerminalizationMs - outputRecencyGuardMs) <= guardExpiryToleranceMs;
    holes.push({
      runId,
      skippedAt: skip.instant,
      recentOutputAgeMs,
      processPid: skip.payload.processPid ?? null,
      terminalizedAt: terminalizer.instant,
      terminalizedBy:
        terminalizer.event === SUPERVISOR_EVENTS.STALE_LOCK_TERMINALIZE ? "stale_lock_sweep" : "orphan_reap",
      authority: terminalizer.payload.authority ?? null,
      terminalStatus: terminalizer.payload.terminalStatus ?? null,
      secondsAfterSkip,
      outputAgeAtTerminalizationMs,
      atGuardExpiry,
    });
  }
  holes.sort((left, right) => left.terminalizedAt.localeCompare(right.terminalizedAt));

  const eventInstants = (entries) =>
    [...entries].map(([runId, entry]) => ({ runId, instant: entry.instant }));

  const uniqueStartups = [...new Set(startupInstants)].sort();
  const holesAtGuardExpiry = holes.filter((hole) => hole.atGuardExpiry);
  const holesWithOutputAge = holes.filter((hole) => hole.outputAgeAtTerminalizationMs !== null);
  // A hole that carries no authority is a run discarded by a path that recorded nothing about why.
  // Folded in with the holes that name an authority it reads as the same event, and the repair for
  // the two is not the same: one path recorded a wrong reading, the other recorded no reading.
  const holesWithoutAuthority = holes.filter(
    (hole) => hole.authority === null || String(hole.authority).trim() === "",
  );
  const byTerminatingPath = [...new Set(holes.map((hole) => hole.terminalizedBy))].sort().map((path) => ({
    key: path,
    count: holes.filter((hole) => hole.terminalizedBy === path).length,
    withoutAuthority: holesWithoutAuthority.filter((hole) => hole.terminalizedBy === path).length,
  }));

  return {
    date: parsed.date,
    dates: parsed.dates ?? [parsed.date],
    outputRecencyGuardMs,
    guardExpiryToleranceMs,
    startupInstants: uniqueStartups,
    startups: uniqueStartups.length,
    guardSkippedRuns: guardSkips.size,
    reapedRuns: reaped.size,
    staleLockTerminalizedRuns: staleLockTerminalized.size,
    guardHoleRuns: holes.length,
    guardExpiryKills: holesAtGuardExpiry.length,
    guardHolesWithOutputAge: holesWithOutputAge.length,
    guardHolesWithoutRecordedAuthority: holesWithoutAuthority.length,
    guardHolesByTerminatingPath: byTerminatingPath,
    guardHoles: holes,
    // The instants each counted event happened at, kept so the record can be restricted to a cutoff
    // later. Without them only the totals survive, and a reading taken after a repair would score
    // the clauses on evidence recorded before it.
    guardSkipEvents: eventInstants(guardSkips),
    reapEvents: eventInstants(reaped),
    staleLockEvents: eventInstants(staleLockTerminalized),
    // The stretch this record actually observed. A clause that reads the record is only answerable
    // over this span, so a cohort outside it is not scored at zero of zero, it is not scored at all.
    coverageSpan: spanOfInstants(
      parsed.events.map((entry) => entry.instant),
    ).span,
    sinceCutoff: null,
  };
}

/**
 * The same record restricted to the events at or after a cutoff.
 *
 * A supervisor record covers whatever span its files cover, which is not the span a cohort split
 * asks about. Scoring the guard clauses on the whole record while the run clauses are scored on the
 * cohort after a cutoff reports evidence from before the repair as a verdict on the repair. This
 * recomputes every derived number from the retained instants, so the slice is a reading and not a
 * subtraction.
 */
export function sliceSupervisorRecordAt(summary, cutoff) {
  return restrictSupervisorRecord(summary, cutoff, "atOrAfter", "sliceSupervisorRecordAt");
}

/**
 * The same record restricted to the events before a cutoff.
 *
 * A cohort split reports every other cohort number on each side of the cutoff. The guard clauses are
 * cohort clauses too, so the side before the cutoff is a reading in its own right rather than the
 * remainder left over once the scored side has been taken out of the whole record.
 */
export function sliceSupervisorRecordBefore(summary, cutoff) {
  return restrictSupervisorRecord(summary, cutoff, "before", "sliceSupervisorRecordBefore");
}

function restrictSupervisorRecord(summary, cutoff, side, caller) {
  if (!summary || !Array.isArray(summary.guardHoles)) {
    throw new Error(`${caller} requires a summarized supervisor record`);
  }
  if (cutoff === null || cutoff === undefined) return summary;
  /*
   * A record that carries totals but not the instants behind them cannot be restricted. Recomputing
   * from an absent detail would report zero rather than report that the question cannot be answered,
   * which is a fabricated reading. Such a record is returned whole and marked as not restricted.
   */
  if (!Array.isArray(summary.guardSkipEvents)) {
    return { ...summary, sinceCutoff: null, restrictedToCutoff: false };
  }
  const boundary = tryParseInstant(cutoff);
  if (boundary === null) {
    throw new Error(`${caller} needs an instant, got ${cutoff}`);
  }
  const at = boundary.getTime();
  const keep = (instant) => {
    const parsed = tryParseInstant(instant);
    if (parsed === null) return false;
    return side === "atOrAfter" ? parsed.getTime() >= at : parsed.getTime() < at;
  };

  const holes = summary.guardHoles.filter((hole) => keep(hole.terminalizedAt));
  const holesWithoutAuthority = holes.filter(
    (hole) => hole.authority === null || String(hole.authority).trim() === "",
  );
  const countEvents = (events) =>
    (Array.isArray(events) ? events : []).filter((entry) => keep(entry.instant));

  const guardSkipEvents = countEvents(summary.guardSkipEvents);
  const reapEvents = countEvents(summary.reapEvents);
  const staleLockEvents = countEvents(summary.staleLockEvents);
  const sideSpan = side === "atOrAfter" ? makeSpan(boundary, null) : makeSpan(null, boundary);

  return {
    ...summary,
    startupInstants: summary.startupInstants.filter((instant) => keep(instant)),
    startups: summary.startupInstants.filter((instant) => keep(instant)).length,
    guardSkippedRuns: guardSkipEvents.length,
    reapedRuns: reapEvents.length,
    staleLockTerminalizedRuns: staleLockEvents.length,
    guardHoleRuns: holes.length,
    guardExpiryKills: holes.filter((hole) => hole.atGuardExpiry).length,
    guardHolesWithOutputAge: holes.filter((hole) => hole.outputAgeAtTerminalizationMs !== null).length,
    guardHolesWithoutRecordedAuthority: holesWithoutAuthority.length,
    guardHolesByTerminatingPath: [...new Set(holes.map((hole) => hole.terminalizedBy))]
      .sort()
      .map((path) => ({
        key: path,
        count: holes.filter((hole) => hole.terminalizedBy === path).length,
        withoutAuthority: holesWithoutAuthority.filter((hole) => hole.terminalizedBy === path).length,
      })),
    guardHoles: holes,
    guardSkipEvents,
    reapEvents,
    staleLockEvents,
    // The record observed no more of the cohort than it observed of time overall, so the coverage
    // narrows with the slice rather than being inherited whole from the record.
    coverageSpan: intersectSpans(summary.coverageSpan ?? null, sideSpan),
    sinceCutoff: side === "atOrAfter" ? boundary.toISOString() : null,
    beforeCutoff: side === "before" ? boundary.toISOString() : null,
    restrictedToCutoff: true,
  };
}

/** Reads the record from a file. The parse contract is unchanged, so nothing is guessed here. */
export function createSupervisorLogSource({ readFile }) {
  if (typeof readFile !== "function") {
    throw new Error("a supervisor log source requires a readFile");
  }
  return {
    async readRecord({ path, date, utcOffsetMinutes }) {
      const text = await readFile(path, "utf8");
      return summarizeSupervisorRecord(parseSupervisorLog(text, { date, utcOffsetMinutes }));
    },
  };
}
