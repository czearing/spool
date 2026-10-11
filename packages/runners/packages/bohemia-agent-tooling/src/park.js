/**
 * Parking work, with the wake path required rather than hoped for.
 *
 * Moving an issue to blocked is a claim that something else will move it back. When nothing is named,
 * the claim is empty and the issue sits there until a person notices, taking every issue waiting on it
 * along. The failure is silent because a parked issue with no way back reads exactly like one that is
 * simply waiting, and the difference only shows up in a walk nobody runs.
 *
 * So the wake path is a precondition of the write, not a field a caller may forget. A park with no
 * blocker and no scheduled monitor is refused here, before it reaches the queue, the same way a task
 * with no current number is refused before it reaches the queue. Naming who unparks the work and what
 * they do is required for the same reason: prose in a comment cannot be read back by the walk that
 * scores whether the board is stranded.
 *
 * This is core rather than tool code because a queue is a shared surface. Every tool built on this
 * scaffold parks work, and one that parks it without a wake path strands issues belonging to tools
 * that did nothing wrong.
 */

/** How a parked issue gets moved again. At least one is required to park anything. */
export const PARK_WAKE_PATHS = Object.freeze({
  /** A first class blocker. The park ends when the blocker reaches a terminal status. */
  BLOCKER: "blocker",
  /** A scheduled monitor. The park ends when the timer fires. */
  MONITOR: "monitor",
});

function normalizeOwner(owner) {
  if (typeof owner === "string") {
    const trimmed = owner.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (owner === null || typeof owner !== "object") return null;
  const agentId = typeof owner.agentId === "string" ? owner.agentId.trim() : "";
  if (agentId.length > 0) return { agentId };
  const userId = typeof owner.userId === "string" ? owner.userId.trim() : "";
  if (userId.length > 0) return { userId };
  return null;
}

/**
 * Builds the update that parks an issue, and refuses to build one that cannot be undone.
 *
 * The refusal is the point. A caller that cannot name a blocker or a monitor does not have a park, it
 * has an abandonment, and the right place to find that out is at the call site rather than in a board
 * sweep days later.
 */
export function buildPark({
  blockedByIssueIds = [],
  monitorNextCheckAt = null,
  owner = null,
  action = null,
} = {}) {
  const blockers = [...new Set((blockedByIssueIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
  const monitor =
    typeof monitorNextCheckAt === "string" && !Number.isNaN(Date.parse(monitorNextCheckAt))
      ? monitorNextCheckAt
      : monitorNextCheckAt instanceof Date && !Number.isNaN(monitorNextCheckAt.getTime())
        ? monitorNextCheckAt.toISOString()
        : null;

  if (blockers.length === 0 && monitor === null) {
    throw new Error(
      "parking work needs a wake path: name at least one blocking issue or schedule a monitor",
    );
  }

  const normalizedOwner = normalizeOwner(owner);
  if (normalizedOwner === null) {
    throw new Error("parking work needs an unblock owner recorded as an agent, a user, or the board");
  }
  const normalizedAction = typeof action === "string" ? action.trim() : "";
  if (normalizedAction.length === 0) {
    throw new Error("parking work needs the unblock action recorded as text the owner can act on");
  }

  const wakePaths = [];
  if (blockers.length > 0) wakePaths.push(PARK_WAKE_PATHS.BLOCKER);
  if (monitor !== null) wakePaths.push(PARK_WAKE_PATHS.MONITOR);

  return {
    update: {
      status: "blocked",
      blockedByIssueIds: blockers,
      unblockDescriptor: { owner: normalizedOwner, action: normalizedAction },
    },
    monitorNextCheckAt: monitor,
    wakePaths,
  };
}

/**
 * Reads back whether a parked issue can still be moved, off the issue record alone.
 *
 * A park that was legal when it was written stops being legal the moment its only blocker turns out to
 * be parked with no wake path of its own, so this answers for the row and the caller resolves the
 * chain. It never reads the clock: a monitor instant in the past is still a scheduled monitor, and
 * whether the timer fired is the scheduler's answer to give, not this function's to guess.
 */
export function readWakePaths(issue) {
  const blockers = issue?.blockedByIssueIds ?? (issue?.blockedBy ?? []).map((blocker) => blocker?.id);
  const blockerCount = (blockers ?? []).filter((id) => id !== null && id !== undefined).length;
  const monitor = issue?.monitorNextCheckAt ?? null;
  const hasMonitor = typeof monitor === "string" && !Number.isNaN(Date.parse(monitor));

  const wakePaths = [];
  if (blockerCount > 0) wakePaths.push(PARK_WAKE_PATHS.BLOCKER);
  if (hasMonitor) wakePaths.push(PARK_WAKE_PATHS.MONITOR);

  const descriptor = issue?.unblockDescriptor ?? null;
  const ownerRecorded =
    descriptor !== null && typeof descriptor === "object" && normalizeOwner(descriptor.owner) !== null;
  const actionRecorded =
    descriptor !== null &&
    typeof descriptor === "object" &&
    typeof descriptor.action === "string" &&
    descriptor.action.trim().length > 0;

  return {
    wakePaths,
    hasWakePath: wakePaths.length > 0,
    blockerCount,
    unblockOwnerRecorded: ownerRecorded && actionRecorded,
  };
}

/** Throws unless the issue records a way back. Used by a caller reading a park it did not write. */
export function assertWakePath(issue) {
  const read = readWakePaths(issue);
  if (!read.hasWakePath) {
    throw new Error("issue is parked with no blocker and no scheduled monitor, so nothing can wake it");
  }
  return read;
}
