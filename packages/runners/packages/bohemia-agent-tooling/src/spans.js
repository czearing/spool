/**
 * Spans of time, and what one reading covers of another. Generic: it knows about instants and
 * coverage, not about any one tool.
 *
 * A collector reads more than one source, and the sources rarely cover the same stretch of time. The
 * rows come from an endpoint that keeps them all, and an outside record covers only the stretch it
 * was written over. Scoring a clause that reads the outside record against a cohort of rows the
 * record never saw is a false verdict in both directions: it fails a cohort on events that happened
 * before it started, and it passes a cohort at zero of zero on a stretch nothing was recorded for.
 *
 * The shared core owns the arithmetic once so no tool decides for itself what an overlap is. A span
 * is inclusive at both ends, and a null end is unbounded on that side.
 */

import { parseInstant, tryParseInstant } from "./instants.js";

/** A span from two ends, either of which may be null for unbounded. An inverted span is refused. */
export function makeSpan(from = null, to = null) {
  const start = from === null || from === undefined ? null : parseInstant(from);
  const end = to === null || to === undefined ? null : parseInstant(to);
  if (start !== null && end !== null && start.getTime() > end.getTime()) {
    throw new Error(`a span cannot end before it starts, got ${start.toISOString()} to ${end.toISOString()}`);
  }
  return { from: start === null ? null : start.toISOString(), to: end === null ? null : end.toISOString() };
}

/**
 * The span a set of instants occupies. Values that carry no usable instant are counted rather than
 * dropped in silence, because a source that dated nothing has no span and must say so.
 */
export function spanOfInstants(values) {
  if (!Array.isArray(values)) throw new Error("spanOfInstants requires an array of values");
  let earliest = null;
  let latest = null;
  let dated = 0;
  let undated = 0;
  for (const value of values) {
    const instant = tryParseInstant(value);
    if (instant === null) {
      undated += 1;
      continue;
    }
    dated += 1;
    if (earliest === null || instant.getTime() < earliest.getTime()) earliest = instant;
    if (latest === null || instant.getTime() > latest.getTime()) latest = instant;
  }
  if (dated === 0) return { span: null, dated, undated };
  return { span: makeSpan(earliest, latest), dated, undated };
}

/** Whether an instant falls inside a span. Both ends are inclusive, and an unusable value is false. */
export function isWithinSpan(value, span) {
  if (span === null || span === undefined) return true;
  const instant = tryParseInstant(value);
  if (instant === null) return false;
  const start = tryParseInstant(span.from);
  const end = tryParseInstant(span.to);
  if (start !== null && instant.getTime() < start.getTime()) return false;
  if (end !== null && instant.getTime() > end.getTime()) return false;
  return true;
}

/**
 * The stretch two spans share, or null when they share none. A null span on either side is read as
 * unbounded, so intersecting with nothing returns the other span rather than nothing.
 */
export function intersectSpans(left, right) {
  if (left === null || left === undefined) return right === null || right === undefined ? null : { ...right };
  if (right === null || right === undefined) return { ...left };

  const starts = [tryParseInstant(left.from), tryParseInstant(right.from)].filter((value) => value !== null);
  const ends = [tryParseInstant(left.to), tryParseInstant(right.to)].filter((value) => value !== null);
  const start = starts.length === 0 ? null : new Date(Math.max(...starts.map((value) => value.getTime())));
  const end = ends.length === 0 ? null : new Date(Math.min(...ends.map((value) => value.getTime())));
  if (start !== null && end !== null && start.getTime() > end.getTime()) return null;
  return makeSpan(start, end);
}

/**
 * The parts of a span that a coverage span does not reach. This is what a reading names when it
 * refuses to score: an operator who is told only that a clause was not scored cannot tell a source
 * that was never read from one that was read and stops short of the cohort.
 */
export function uncoveredSpans(span, coverage) {
  if (span === null || span === undefined) return [];
  if (coverage === null || coverage === undefined) return [{ ...span }];

  const parts = [];
  const spanStart = tryParseInstant(span.from);
  const spanEnd = tryParseInstant(span.to);
  const coverStart = tryParseInstant(coverage.from);
  const coverEnd = tryParseInstant(coverage.to);

  if (coverStart !== null && (spanStart === null || spanStart.getTime() < coverStart.getTime())) {
    parts.push(makeSpan(spanStart, coverStart));
  }
  if (coverEnd !== null && (spanEnd === null || spanEnd.getTime() > coverEnd.getTime())) {
    parts.push(makeSpan(coverEnd, spanEnd));
  }
  return parts;
}

/** A span as one readable string, so a refusal to score can name what it was refused over. */
export function describeSpan(span) {
  if (span === null || span === undefined) return "no span";
  return `${span.from ?? "the start of the record"} to ${span.to ?? "the end of the record"}`;
}
