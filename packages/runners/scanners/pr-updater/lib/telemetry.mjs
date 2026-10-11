/**
 * One durable record per job, from the moment a pull request is queued to the moment the agent
 * finishes with it.
 *
 * A job is written as an append-only line per state change and folded back into a single row on
 * read, so a crash loses at most the current job rather than the history, and a job that never
 * finishes is still visible as started. That matters more than it sounds: the harness inserts its
 * `turns` row only on completion, so an in-flight job is invisible everywhere else.
 *
 * Segment durations, not a status. "Slow" and "stuck" look identical from outside, and only the
 * split between repo setup, agent work and pull request update says which one is happening.
 * No regular expressions are used.
 */
import fs from "node:fs";
import path from "node:path";

/** Job states, in the order a healthy job passes through them. */
export const QUEUED = "queued";
export const IN_PROGRESS = "in_progress";
export const PREPARING = "preparing";
export const DISPATCHED = "dispatched";
export const DONE = "done";
export const FAILED = "failed";
export const BLOCKED = "blocked";

export function jobBlocked(file, { jobId, at, reason }) {
  appendLine(file, { jobId, state: BLOCKED, at, phase: "prepare", reason, error: null });
}

function appendLine(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/**
 * Record that a pull request entered the queue.
 *
 * Written before any work, because "pull requests are not being added to the queue" and "the
 * agent is stuck" produce the same symptom of an unchanged pull request and must be
 * distinguishable without reading code.
 */
export function jobQueued(file, { jobId, prId, prUrl, trigger, reason, at, issueId, identifier, agentId, agent }) {
  appendLine(file, { jobId, state: QUEUED, prId, prUrl, trigger, reason, at, queuedAt: at, issueId, identifier, agentId, agent,
    error: null, detail: null, phase: null });
  return jobId;
}

/**
 * Record that repo setup / the build actually started running, not merely that it was queued.
 *
 * `prepare()` can legitimately run for tens of minutes (a slow install, a real build). Without
 * this line the job log shows only the original `queued` timestamp for that whole window, which
 * `summarize` cannot tell apart from a job that never started at all, so a healthy long-running
 * prepare step was silently miscounted as stale/failed instead of running.
 */
export function jobStarted(file, { jobId, at }) {
  appendLine(file, { jobId, state: IN_PROGRESS, at, startedAt: at });
}

/** Repo setup finished, with the per-step breakdown that says where the time went. */
export function jobPrepared(file, { jobId, at, ms, steps, branch, conflicts = [] }) {
  appendLine(file, { jobId, state: PREPARING, at, preparedAt: at, setupMs: ms, steps, branch, conflicts });
}

/** The task reached the harness. Agent work starts here and its clock runs from `dispatchedAt`. */
export function jobDispatched(file, { jobId, at, agent, submissionId, body, creatorOwned, issueId, identifier, agentId }) {
  appendLine(file, {
    jobId, state: DISPATCHED, at, dispatchedAt: at, agent, submissionId, body, creatorOwned, issueId, identifier, agentId,
    doneAt: null, outcome: null, commit: null, conversation: null,
    error: null, detail: null, phase: null,
  });
}

/**
 * The agent finished. `outcome` is the artefact, not the exit status: whether the pull request
 * actually changed is the only thing that proves the job worked.
 */
export function jobDone(file, { jobId, at, agentMs, updateMs, outcome, commit = null, conversation = null }) {
  appendLine(file, { jobId, state: DONE, at, doneAt: at, agentMs, updateMs, outcome, commit, conversation });
}

/**
 * A failure, with the evidence needed to diagnose it.
 *
 * `error` stays one line because the dashboard renders it in a cell, but the tail of the tool's
 * own output is kept in `detail`. Discarding it cost 62 identical prepare failures that read
 * "Bundle build failed (exit 1)" and named neither the cause nor the fix.
 */
export function jobFailed(file, { jobId, at, phase, error, preparationEvidence }) {
  const text = String(error);
  const [summary, ...rest] = text.split("\n");
  const detail = rest.join("\n").trim();
  appendLine(file, { jobId, state: FAILED, at, phase, error: summary, detail: detail.slice(-4000) || undefined, preparationEvidence });
}

/**
 * Parse one line, recovering the tail if a previous write was cut off mid-record.
 *
 * A process killed between the write and its newline leaves a partial record, and the next append
 * lands on the same line. Splitting on the newline alone would then lose not just the truncated
 * record but every record written after it, which is silent and permanent. Taking the last
 * complete object on the line gives up only the record that was actually lost.
 */
function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    const start = line.lastIndexOf('{"jobId"');
    if (start <= 0) return null;
    try {
      return JSON.parse(line.slice(start));
    } catch {
      return null;
    }
  }
}

/**
 * Fold the log back into one row per job, newest first.
 *
 * Later lines win field by field rather than replacing the row, so a job keeps its pull request
 * and trigger from the queued line after the dispatched line arrives. An unreadable line is
 * skipped rather than fatal: a half-written record from a kill must not hide the whole history.
 */
export function readJobs(file, limit = 200) {
  if (!fs.existsSync(file)) return [];
  const jobs = new Map();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const record = parseLine(line);
    if (!record?.jobId) continue;
    const current = jobs.get(record.jobId) || { jobId: record.jobId };
    jobs.set(record.jobId, { ...current, ...record, state: record.state || current.state });
  }
  return [...jobs.values()]
    .sort((left, right) => String(right.at || "").localeCompare(String(left.at || "")))
    .slice(0, limit);
}

/** A later exclusive creator attempt proves an undispatched preparation no longer owns the checkout. */
export function reconcileSupersededPreparations(file) {
  const jobs = readJobs(file, Infinity);
  const recovered = [];
  for (const job of jobs) {
    if (!job.jobId.startsWith("creator:") || !job.issueId || job.dispatchedAt ||
        ![QUEUED, IN_PROGRESS, PREPARING].includes(job.state)) continue;
    const next = jobs.filter((other) => other.jobId.startsWith("creator:") &&
      other.issueId === job.issueId && String(other.prId) === String(job.prId) &&
      Date.parse(other.startedAt) > Date.parse(job.at))
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0];
    if (!next) continue;
    jobFailed(file, {
      jobId: job.jobId, at: next.startedAt, phase: "prepare",
      error: `Preparation ended without a terminal record; superseded by exclusive creator attempt ${next.jobId}. Uncommitted work was preserved.`,
    });
    recovered.push(job.jobId);
  }
  return recovered;
}

/**
 * Totals a person can act on.
 *
 * `stalled` counts jobs that were dispatched and never reported done, which is the exact shape of
 * every outage seen so far: the machinery looked healthy and the pull request never moved.
 */
export function summarize(jobs, now = Date.now(), stallMinutes = 180, staleScriptMinutes = 15) {
  const summary = { total: jobs.length, queued: 0, running: 0, done: 0, failed: 0, blocked: 0, stalled: 0, medianSetupMs: null };
  const setups = [];
  for (const job of jobs) {
    if (job.state === BLOCKED) summary.blocked += 1;
    else if (job.state === DONE && ["blocked", "failed", "cancelled", "timed_out", "expired"].includes(job.outcome)) summary.failed += 1;
    else if (job.state === DONE) summary.done += 1;
    else if (job.state === FAILED) summary.failed += 1;
    else if (job.state === DISPATCHED) {
      summary.running += 1;
      const age = (now - Date.parse(job.at || "")) / 60_000;
      if (Number.isFinite(age) && age > stallMinutes) summary.stalled += 1;
    } else if (job.state === IN_PROGRESS) {
      // A real prepare step is in flight. Use the same generous stall window as a dispatched job
      // rather than the 15-minute queued-staleness check, which exists to catch a job that never
      // started, not one that is genuinely still running.
      summary.running += 1;
      const age = (now - Date.parse(job.at || "")) / 60_000;
      if (Number.isFinite(age) && age > stallMinutes) summary.stalled += 1;
    } else if (job.state === PREPARING) {
      const age = (now - Date.parse(job.at || "")) / 60_000;
      if (Number.isFinite(age) && age > staleScriptMinutes) summary.failed += 1;
      else summary.running += 1;
    } else {
      const age = (now - Date.parse(job.at || "")) / 60_000;
      if (Number.isFinite(age) && age > staleScriptMinutes) summary.failed += 1;
      else summary.queued += 1;
    }
    if (Number.isFinite(job.setupMs)) setups.push(job.setupMs);
  }
  if (setups.length > 0) {
    setups.sort((left, right) => left - right);
    summary.medianSetupMs = setups[Math.floor(setups.length / 2)];
  }
  return summary;
}
