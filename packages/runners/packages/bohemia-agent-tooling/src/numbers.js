/**
 * Numeric summaries. Generic: it knows about a list of numbers, not about any one tool.
 *
 * Every collector that reports a spread repeats the same four decisions: what a missing value does to
 * the mean, whether an empty list is zero or unknown, how many places a reported number carries, and
 * whether the total is reported at all. Answering them once in the core is what keeps two collectors
 * from reporting the same quantity with two different roundings, and it is what makes an acceptance
 * clause scored off these fields mean the same thing on every surface.
 *
 * An empty list is unknown, not zero. A clause with nothing behind it must not pass by default.
 */

export function round(value, places = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Reduces values to count, minimum, maximum, mean and total. Values that are not finite numbers are
 * counted as missing rather than read as zero, so a column the platform does not record cannot drag a
 * mean towards a number nobody measured.
 */
export function summarizeNumbers(values, { places = 2 } = {}) {
  if (!Array.isArray(values)) throw new Error("summarizeNumbers requires an array of values");
  const present = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  const missing = values.length - present.length;
  if (present.length === 0) {
    return { count: 0, missing, minimum: null, maximum: null, mean: null, total: null };
  }
  const total = present.reduce((sum, value) => sum + value, 0);
  return {
    count: present.length,
    missing,
    minimum: round(Math.min(...present), places),
    maximum: round(Math.max(...present), places),
    mean: round(total / present.length, places),
    total: round(total, places),
  };
}

/** A part of a whole as a percentage. A whole of zero is unknown rather than zero percent. */
export function percentage(part, whole, { places = 1 } = {}) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole === 0) return null;
  return round((part / whole) * 100, places);
}

/**
 * Counts rows by a caller supplied key. A key that is null or undefined is counted under an explicit
 * name so a column the platform leaves empty is visible as a group rather than dropped.
 */
export function countBy(rows, readKey, { emptyKey = "none" } = {}) {
  if (!Array.isArray(rows)) throw new Error("countBy requires an array of rows");
  if (typeof readKey !== "function") throw new Error("countBy requires a key reader");
  const counts = new Map();
  for (const row of rows) {
    const raw = readKey(row);
    const key = raw === null || raw === undefined || raw === "" ? emptyKey : String(raw);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
