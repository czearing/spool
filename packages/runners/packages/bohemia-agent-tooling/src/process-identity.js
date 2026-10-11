/**
 * Process identity.
 *
 * A process id is not an identity. It is a slot the operating system reuses the moment the process
 * holding it exits, and on Windows it is reused quickly. Every supervisor that answers "is my child
 * still alive" by asking whether the id exists is really asking whether the slot is occupied, and it
 * gets a yes as soon as an unrelated process lands in the slot. The recorded run then never
 * terminalizes, no exit code or signal is ever written, and whatever lock the run holds is never
 * released.
 *
 * The fix is to record enough to recognise the process again and to compare it on every probe. A
 * process start time is the cheap discriminator: the operating system will hand the same id to a
 * later process, but it cannot hand it to a process that started before the one being looked for.
 *
 * Nothing here names a tool. A recorded process is any object carrying an id and a start time.
 */

/**
 * Clock skew allowance between the time a runner records and the time the operating system reports.
 * A recorded start time is taken by the parent after the spawn returns, so it always trails the
 * operating system's own start time by a small amount.
 */
export const IDENTITY_START_TOLERANCE_SECONDS = 5;

export const IDENTITY_SAME = "same";
export const IDENTITY_REUSED = "reused";
export const IDENTITY_GONE = "gone";
export const IDENTITY_UNVERIFIABLE = "unverifiable";

function parseTime(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Decide whether an observed process is the process that was recorded.
 *
 * The verdicts are deliberately four and not two. "unverifiable" is not a synonym for "same": it
 * says the probe could not answer, and a caller that treats it as a live process is making the same
 * assumption this surface exists to remove.
 */
export function classifyProcessIdentity(recorded, observed, options = {}) {
  const toleranceMs =
    Math.max(0, Number(options.toleranceSeconds ?? IDENTITY_START_TOLERANCE_SECONDS)) * 1000;

  const recordedPid = normalizePid(recorded?.pid);
  if (recordedPid === null) {
    return { verdict: IDENTITY_UNVERIFIABLE, reason: "no recorded process id", driftSeconds: null };
  }

  if (!observed) {
    return { verdict: IDENTITY_GONE, reason: "no process holds the recorded id", driftSeconds: null };
  }

  const observedPid = normalizePid(observed.pid);
  if (observedPid !== null && observedPid !== recordedPid) {
    return {
      verdict: IDENTITY_UNVERIFIABLE,
      reason: `observation is for process ${observedPid}, not ${recordedPid}`,
      driftSeconds: null,
    };
  }

  const marker = recorded.marker ?? null;
  if (marker && typeof observed.commandLine === "string" && !observed.commandLine.includes(marker)) {
    return {
      verdict: IDENTITY_REUSED,
      reason: `process ${recordedPid} does not carry the recorded marker`,
      driftSeconds: null,
    };
  }

  const recordedStart = parseTime(recorded.startedAt);
  const observedStart = parseTime(observed.startedAt);
  if (recordedStart === null || observedStart === null) {
    return {
      verdict: IDENTITY_UNVERIFIABLE,
      reason: "a start time is missing on one side of the comparison",
      driftSeconds: null,
    };
  }

  const driftMs = observedStart - recordedStart;
  const driftSeconds = Math.round((driftMs / 1000) * 100) / 100;
  if (Math.abs(driftMs) <= toleranceMs) {
    return { verdict: IDENTITY_SAME, reason: "start times agree", driftSeconds };
  }

  const direction = driftMs > 0 ? "after" : "before";
  return {
    verdict: IDENTITY_REUSED,
    reason: `process ${recordedPid} started ${Math.abs(driftSeconds)}s ${direction} the recorded process`,
    driftSeconds,
  };
}

/** Whether a verdict means the recorded process is genuinely still running. */
export function isSameProcess(verdict) {
  return verdict === IDENTITY_SAME;
}

/**
 * Whether a verdict proves the recorded process is finished.
 *
 * "unverifiable" is excluded on purpose. A probe that could not answer must not be allowed to
 * terminalize a run, because that is the wrongful kill this surface is the alternative to.
 */
export function isProvenFinished(verdict) {
  return verdict === IDENTITY_GONE || verdict === IDENTITY_REUSED;
}

/** Index an observed process table by process id, so a probe is a lookup and not a scan. */
export function indexProcessTable(processes) {
  const index = new Map();
  for (const entry of processes ?? []) {
    const pid = normalizePid(entry?.pid);
    if (pid === null) continue;
    index.set(pid, { ...entry, pid });
  }
  return index;
}

/**
 * Probe one recorded process against an observed process table.
 *
 * The table is passed in rather than read here so the surface stays a pure decision and every
 * caller, on any host, tests the same code.
 */
export function verifyProcessIdentity(recorded, processIndex, options = {}) {
  const recordedPid = normalizePid(recorded?.pid);
  const index =
    processIndex instanceof Map ? processIndex : indexProcessTable(processIndex);
  const observed = recordedPid === null ? null : index.get(recordedPid) ?? null;
  const classified = classifyProcessIdentity(recorded, observed, options);
  return {
    pid: recordedPid,
    observed,
    running: isSameProcess(classified.verdict),
    finished: isProvenFinished(classified.verdict),
    ...classified,
  };
}
