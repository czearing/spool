/**
 * Who is holding each pull request right now.
 *
 * The dashboard used to answer this with a separate "In flight" table, which meant reading two
 * lists and matching ids by eye to learn that the row you cared about was already being worked.
 * Ownership belongs on the pull request itself.
 *
 * The job states already carry the answer, so nothing new is recorded. `queued` and `preparing`
 * are the runner cloning, resetting and building, so the script owns the row; `dispatched` means
 * the task reached the harness and the agent's clock is running. The harness is deliberately not
 * consulted: it reported an agent as `working` for fifty minutes after its last turn completed,
 * so its own status is the less truthful of the two signals.
 *
 * No regular expressions are used.
 */

const TERMINAL = ["done", "failed", "blocked", "verifying"];

/** Job states in which the runner itself, not the agent, is doing the work. */
const SCRIPT_STATES = ["queued", "preparing", "in_progress"];

/**
 * Map every pull request with a live job to the actor holding it.
 *
 * Keyed by pull request id as a string, because the watch list and the job log disagree about
 * whether an id is a number. The newest live job wins, so a requeued pull request reports the
 * attempt actually running rather than the one it superseded.
 */
export function owners(jobs = [], now = Date.now(), staleScriptMinutes = 15) {
  const map = new Map();
  for (const job of jobs) {
    if (!job?.prId || TERMINAL.includes(job.state)) continue;
    if (["succeeded", "failed", "cancelled", "timed_out", "expired"].includes(job.runStatus)) continue;
    const actor = SCRIPT_STATES.includes(job.state) ? "script" : "agent";
    const startedAt = actor === "agent" ? job.dispatchedAt || job.at : job.queuedAt || job.at;
    const since = Date.parse(startedAt || "");
    const elapsedMs = Number.isFinite(since) ? now - since : null;
    if (actor === "script" && !job.ownerConfirmed && Number.isFinite(elapsedMs) && elapsedMs > staleScriptMinutes * 60_000) {
      continue;
    }
    const entry = { ...job, actor, state: job.state, since, elapsedMs };
    const previous = map.get(String(job.prId));
    if (!previous || !(previous.since > entry.since)) map.set(String(job.prId), entry);
  }
  return map;
}
