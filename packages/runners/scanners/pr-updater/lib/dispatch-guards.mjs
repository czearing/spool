/**
 * The guards that decide whether a job may be handed to the agent at all.
 *
 * Both read the durable job log rather than any in-memory state, so a restarted or duplicated
 * runner reaches the same conclusion as the one that wrote the record. Agent availability is a
 * different question with a different source of truth and stays with the pass that uses it.
 */
import * as telemetry from "./telemetry.mjs";
import { assertPreparationCapacity, isCapacityError } from "../../../packages/bohemia-pr-mcp/src/preparation-capacity.mjs";

/** How far back the job log is consulted. Comfortably longer than any cooldown. */
const WINDOW = 200;

/** Whether this exact job was ever handed over, in any earlier pass or any earlier process. */
export function alreadySent(config, jobId) {
  return telemetry.readJobs(config.telemetryFile, WINDOW).some(
    (job) =>
      job.jobId === jobId &&
      (job.state === telemetry.DISPATCHED ||
        (job.state === telemetry.DONE && job.outcome === "completed")),
  );
}

/** How long a job that failed to prepare is left alone before it is tried again. */
export const RETRY_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Whether this job failed recently enough that retrying it now would only repeat the failure.
 *
 * A prepare failure is usually a property of the branch or the workspace, not of the moment, so
 * an immediate retry reproduces it. Without this gate one unbuildable branch logged 62 identical
 * failures in a day, which buried every other event in the log and rebuilt the repository each
 * time. The cooldown is per job, so unrelated pull requests are unaffected and a genuinely
 * transient failure still gets another attempt.
 */
export function recentlyFailed(config, jobId, now, cooldown = RETRY_COOLDOWN_MS) {
  const at = Date.parse(now);
  const last = telemetry
    .readJobs(config.telemetryFile, WINDOW)
    .filter((job) => job.jobId?.slice(0, job.jobId.lastIndexOf(":")) === jobId.slice(0, jobId.lastIndexOf(":"))
      && job.state === telemetry.FAILED
      && job.phase !== "dispatch"
      && (!config.preparationEvidence || job.preparationEvidence === config.preparationEvidence)
      // Old build prerequisites are no longer part of repair preparation.
      && !(job.trigger === "build" && String(job.error).includes("Bundle build failed")))
    .filter(job => {
      if (!isCapacityError({ message: String(job.error) })) return true;
      if (config.creatorMinimumFreeGiB === undefined) return true;
      try { assertPreparationCapacity(config, config.repoRoot); return false; }
      catch (error) { if (!isCapacityError(error)) throw error; return true; }
    })
    .map((job) => Date.parse(job.at))
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => b - a)[0];
  if (!Number.isFinite(last) || !Number.isFinite(at)) return false;
  return at - last < cooldown;
}
