/**
 * Instant handling. Generic: it knows about timestamps and cohorts, not about any one tool.
 *
 * Every operator collector that reads a timestamp off an API has the same trap in front of it. A
 * parser that assumes the local zone when a string carries no offset shifts every instant by that
 * offset, and a cohort split on a cutoff then reports the wrong side. The shared core owns that
 * decision once so no collector and no caller has to.
 */

const OFFSET_PATTERN = /(?:Z|z|[+-]\d{2}:?\d{2})$/;

/**
 * Parses an ISO 8601 timestamp to a Date. A string with no offset is read as UTC rather than as
 * local time, which is the only reading that keeps two hosts in different zones in agreement.
 */
export function parseInstant(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("instant is an invalid date");
    return new Date(value.getTime());
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("instant must be a non empty string or a date");
  }
  const trimmed = value.trim();
  const normalized = OFFSET_PATTERN.test(trimmed) ? trimmed : `${trimmed.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`instant "${value}" is not a parsable timestamp`);
  }
  return parsed;
}

/** Same contract as parseInstant, but a missing or unparsable value is null rather than a throw. */
export function tryParseInstant(value) {
  if (value === null || value === undefined || value === "") return null;
  try {
    return parseInstant(value);
  } catch {
    return null;
  }
}

export function minutesBetween(start, end) {
  const from = parseInstant(start);
  const to = parseInstant(end);
  return (to.getTime() - from.getTime()) / 60000;
}

/**
 * Splits rows on a cutoff instant using a caller supplied reader. Rows whose instant is missing or
 * unparsable are neither before nor after: they are returned separately so a collector reports them
 * instead of silently counting them on one side.
 */
export function splitByCutoff(rows, cutoff, readInstant) {
  if (!Array.isArray(rows)) throw new Error("splitByCutoff requires an array of rows");
  if (typeof readInstant !== "function") throw new Error("splitByCutoff requires an instant reader");

  const boundary = cutoff === null || cutoff === undefined ? null : parseInstant(cutoff);
  const before = [];
  const after = [];
  const undated = [];

  for (const row of rows) {
    const instant = tryParseInstant(readInstant(row));
    if (instant === null) {
      undated.push(row);
      continue;
    }
    if (boundary === null || instant.getTime() >= boundary.getTime()) {
      after.push(row);
    } else {
      before.push(row);
    }
  }

  return { before, after, undated, cutoff: boundary ? boundary.toISOString() : null };
}

/** Drops the sub second part of an instant, so rows recorded milliseconds apart share one key. */
export function truncateToSecond(value) {
  return truncateToBucket(value, 1);
}

/**
 * Drops an instant to the start of the bucket it falls in. One decision taken against a batch of rows
 * arrives with millisecond noise, so a one second bucket collects it. An event that takes a whole
 * population at once is spread over a wider window by the recording path itself, so a wider bucket is
 * what collects that. The width is the caller's, because only the caller knows which of the two it is
 * looking for.
 */
export function truncateToBucket(value, bucketSeconds) {
  if (!Number.isFinite(bucketSeconds) || bucketSeconds <= 0) {
    throw new Error("truncateToBucket requires a positive bucket width in seconds");
  }
  const instant = parseInstant(value);
  const width = bucketSeconds * 1000;
  return new Date(Math.floor(instant.getTime() / width) * width).toISOString();
}

/**
 * Groups rows by the second their instant falls in. A supervisor decision lands on many rows at once
 * with millisecond noise between them, so the grouped count is what separates one decision taken
 * against a batch from a batch of independent events. The optional reader supplies a second value to
 * count distinctly within each group, which is how one decision across many agents is told apart from
 * one agent failing repeatedly.
 *
 * Rows with no usable instant are returned separately rather than counted into any group.
 */
export function groupByInstantSecond(rows, readInstant, { distinctBy = null } = {}) {
  return groupByInstantBucket(rows, readInstant, { bucketSeconds: 1, distinctBy });
}

/**
 * Same grouping at a caller supplied bucket width. The rows a group carries and the distinct values
 * inside it are the two numbers that separate one decision taken against many rows from many rows
 * deciding independently, and neither number means anything without the width it was counted over,
 * so the width is reported back in the result.
 */
export function groupByInstantBucket(rows, readInstant, { bucketSeconds = 1, distinctBy = null } = {}) {
  if (!Array.isArray(rows)) throw new Error("groupByInstantBucket requires an array of rows");
  if (typeof readInstant !== "function") {
    throw new Error("groupByInstantBucket requires an instant reader");
  }
  if (!Number.isFinite(bucketSeconds) || bucketSeconds <= 0) {
    throw new Error("groupByInstantBucket requires a positive bucket width in seconds");
  }

  const groups = new Map();
  const undated = [];

  for (const row of rows) {
    const instant = tryParseInstant(readInstant(row));
    if (instant === null) {
      undated.push(row);
      continue;
    }
    const key = truncateToBucket(instant, bucketSeconds);
    if (!groups.has(key)) groups.set(key, { instant: key, count: 0, distinct: new Set() });
    const group = groups.get(key);
    group.count += 1;
    if (distinctBy !== null) {
      const value = distinctBy(row);
      if (value !== null && value !== undefined) group.distinct.add(value);
    }
  }

  const grouped = [...groups.values()]
    .sort((a, b) => a.instant.localeCompare(b.instant))
    .map((group) => ({
      instant: group.instant,
      count: group.count,
      ...(distinctBy === null
        ? {}
        : { distinctCount: group.distinct.size, distinctValues: [...group.distinct].sort() }),
    }));

  return { bucketSeconds, groups: grouped, undated };
}

/**
 * Reports the gaps in a series of instants that are at least as wide as a floor. A supervisor that
 * starts work on a cadence leaves a dense series behind it, so a wide gap in that series is the
 * supervisor not being there. This is the only availability reading that needs nothing but the rows
 * already collected, which matters when the supervisor's own record does not survive its restart.
 *
 * Rows with no usable instant are counted separately rather than closing a gap they were never in.
 */
export function gapsInSeries(rows, readInstant, { minimumGapMinutes = 3 } = {}) {
  if (!Array.isArray(rows)) throw new Error("gapsInSeries requires an array of rows");
  if (typeof readInstant !== "function") throw new Error("gapsInSeries requires an instant reader");
  if (!Number.isFinite(minimumGapMinutes) || minimumGapMinutes <= 0) {
    throw new Error("gapsInSeries requires a positive minimum gap in minutes");
  }

  const instants = [];
  let undated = 0;
  for (const row of rows) {
    const instant = tryParseInstant(readInstant(row));
    if (instant === null) {
      undated += 1;
      continue;
    }
    instants.push(instant);
  }
  instants.sort((a, b) => a.getTime() - b.getTime());

  const gaps = [];
  for (let index = 1; index < instants.length; index += 1) {
    const minutes = (instants[index].getTime() - instants[index - 1].getTime()) / 60000;
    if (minutes < minimumGapMinutes) continue;
    gaps.push({
      from: instants[index - 1].toISOString(),
      to: instants[index].toISOString(),
      minutes: Math.round(minutes * 100) / 100,
    });
  }

  const totalMinutes = Math.round(gaps.reduce((sum, gap) => sum + gap.minutes, 0) * 100) / 100;
  const widest = gaps.reduce((worst, gap) => (worst === null || gap.minutes > worst.minutes ? gap : worst), null);

  return {
    minimumGapMinutes,
    dated: instants.length,
    undated,
    first: instants.length > 0 ? instants[0].toISOString() : null,
    last: instants.length > 0 ? instants[instants.length - 1].toISOString() : null,
    gaps,
    gapCount: gaps.length,
    totalMinutes,
    widest,
  };
}

/**
 * Matches each row to the nearest of a set of instants and reports whether it lands within a
 * tolerance. Two detectors watching the same event report it under different names at different
 * times, and this is what says the two counts are one event counted twice rather than two events.
 *
 * A row with no usable instant is unmatched with no nearest instant rather than silently dropped.
 */
export function correlateToInstants(rows, readInstant, instants, { toleranceMinutes = 2 } = {}) {
  if (!Array.isArray(rows)) throw new Error("correlateToInstants requires an array of rows");
  if (typeof readInstant !== "function") {
    throw new Error("correlateToInstants requires an instant reader");
  }
  if (!Array.isArray(instants)) throw new Error("correlateToInstants requires an array of instants");
  if (!Number.isFinite(toleranceMinutes) || toleranceMinutes < 0) {
    throw new Error("correlateToInstants requires a non negative tolerance");
  }

  const targets = instants
    .map((instant) => tryParseInstant(instant))
    .filter((instant) => instant !== null);

  const matches = rows.map((row) => {
    const instant = tryParseInstant(readInstant(row));
    if (instant === null || targets.length === 0) {
      return { instant: instant ? instant.toISOString() : null, nearest: null, gapMinutes: null, matched: false };
    }
    let nearest = targets[0];
    for (const target of targets) {
      if (Math.abs(target.getTime() - instant.getTime()) < Math.abs(nearest.getTime() - instant.getTime())) {
        nearest = target;
      }
    }
    const gapMinutes = Math.abs(nearest.getTime() - instant.getTime()) / 60000;
    return {
      instant: instant.toISOString(),
      nearest: nearest.toISOString(),
      gapMinutes: Math.round(gapMinutes * 100) / 100,
      matched: gapMinutes <= toleranceMinutes,
    };
  });

  const matched = matches.filter((entry) => entry.matched).length;
  return { toleranceMinutes, total: matches.length, matched, unmatched: matches.length - matched, matches };
}
