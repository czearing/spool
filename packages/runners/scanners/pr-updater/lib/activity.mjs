/**
 * Read back the runner's own activity log for display.
 *
 * The script does real work that never becomes a job: requeueing an expired or transient build is
 * the whole of scenarios 1 and 3 before escalation, and none of it is visible in the job log. On
 * the dashboard those actions matter as much as the agent runs, because "nothing happened" and
 * "the script handled it without waking an agent" look identical otherwise.
 *
 * No regular expressions are used.
 */
import fs from "node:fs";
import { classifyOutage } from "./outage.mjs";

/**
 * A cycle failure in one line.
 *
 * The raw value is a full stack trace. Rendered verbatim it filled the activity log with a dozen
 * identical twelve-line blocks and buried every other event, which is the opposite of what the
 * log is for. The classifier already names the outage and its remedy, so that name is what the
 * row shows; the stack stays in the log file for anyone debugging.
 */
function cycleFailure(entry) {
  return classifyOutage({ message: String(entry.error || "") }).headline;
}

/** Events worth showing to a person, mapped to a plain description of what the script did. */
const DESCRIBE = {
  build_requeued: (entry) => `requeued ${entry.name || "build"} ${entry.build || ""}`.trim(),
  build_requeue_failed: (entry) => `requeue failed for ${entry.name || "build"}: ${entry.error || ""}`.trim(),
  runner_started: () => "runner started",
  cycle_failed: cycleFailure,
  dashboard_failed: (entry) => `dashboard failed: ${String(entry.error || "").split("\n")[0]}`,
};

/**
 * Collapse a run of identical rows into one.
 *
 * A stuck cause repeats every poll interval, so an outage of an hour produces twelve rows that
 * say the same thing. One row carrying the count says it better and leaves the rest of the log
 * readable, which is the standard treatment for repeated events in an activity feed.
 */
function collapse(actions) {
  const folded = [];
  for (const action of actions) {
    const last = folded[folded.length - 1];
    if (last && last.event === action.event && last.detail === action.detail && last.prId === action.prId) {
      last.count += 1;
      last.firstAt = action.at;
      continue;
    }
    folded.push({ ...action, count: 1 });
  }
  return folded;
}

/**
 * Fold the activity log into the script actions, newest first.
 *
 * Unknown events are dropped rather than rendered raw: the log is also the debug trace, and a page
 * that lists every survey line buries the four entries that mean something.
 */
export function readActions(file, limit = 100) {
  if (!fs.existsSync(file)) return [];
  const actions = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const describe = DESCRIBE[entry?.event];
    if (!describe) continue;
    actions.push({
      at: entry.timestamp,
      event: entry.event,
      prId: entry.pr ? String(entry.pr) : null,
      detail: describe(entry),
      failed: String(entry.event).endsWith("_failed"),
    });
  }
  return collapse(actions.reverse()).slice(0, limit);
}
