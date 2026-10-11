import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const CYCLE = "cycle";
const TASK_TRANSITION = "task_transition";

export const TELEMETRY_KINDS = Object.freeze({ CYCLE, TASK_TRANSITION });

function assertKind(kind) {
  if (kind !== CYCLE && kind !== TASK_TRANSITION) {
    throw new Error(`telemetry kind must be "${CYCLE}" or "${TASK_TRANSITION}", received "${kind}"`);
  }
}

/**
 * Append only telemetry writer. One record per line, never rewritten, never truncated.
 */
export function createTelemetryWriter({ path, tool, now = () => new Date() }) {
  if (!path) throw new Error("telemetry writer requires a path");
  if (!tool) throw new Error("telemetry writer requires a tool name");

  mkdirSync(dirname(path), { recursive: true });

  return {
    path,
    append(kind, payload) {
      assertKind(kind);
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("telemetry payload must be an object");
      }
      const record = { ts: now().toISOString(), tool, kind, ...payload };
      appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
      return record;
    },
    read() {
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
    },
  };
}

/**
 * Derives the state a tool owner reads on every wake, so history is never reconstructed by asking.
 */
const NON_TERMINAL_TRANSITIONS = new Set([
  "drifted",
  "correction_deferred",
  "correction_held",
  "correction_refused",
  "correction_unchanged",
  "correction_reported",
]);

export function rollup(records) {
  const openTasks = new Map();
  let cycles = 0;
  let issuesWritten = 0;
  let emptyCycles = 0;
  let corrections = 0;
  let deferredCorrections = 0;
  let heldCorrections = 0;

  for (const record of records) {
    if (record.kind === CYCLE) {
      cycles += 1;
      if (!record.issueId) emptyCycles += 1;
      continue;
    }
    if (record.kind !== TASK_TRANSITION) continue;
    if (record.transition === "opened") {
      openTasks.set(record.issueId, {
        issueId: record.issueId,
        issueIdentifier: record.issueIdentifier ?? null,
        metric: record.metric,
        current: record.current,
        target: record.target,
        acceptance: record.acceptance,
        unit: record.unit ?? null,
        reproduction: record.reproduction ?? null,
        direction: record.direction ?? "lower_is_better",
        openedAt: record.ts,
        correctedAt: null,
      });
      issuesWritten += 1;
      continue;
    }
    // A brief correction rewrites the numbers the task carries. The open task is the corrected one
    // from here on, so acceptance is checked against the number the assignee can actually read.
    if (record.transition === "corrected") {
      const open = openTasks.get(record.issueId);
      if (open) {
        openTasks.set(record.issueId, {
          ...open,
          current: record.current ?? open.current,
          target: record.target ?? open.target,
          acceptance: record.acceptance ?? open.acceptance,
          unit: record.unit ?? open.unit,
          reproduction: record.reproduction ?? open.reproduction,
          correctedAt: record.ts,
        });
        corrections += 1;
      }
      continue;
    }
    if (record.transition === "correction_deferred") {
      deferredCorrections += 1;
      continue;
    }
    /**
     * A correction the run could not be attributed for was never sent, so the task keeps the numbers
     * it was opened with and the write is still to be made by a run that names a source issue.
     */
    if (record.transition === "correction_held") {
      heldCorrections += 1;
      continue;
    }
    // Reports about an open task, not the end of one.
    if (NON_TERMINAL_TRANSITIONS.has(record.transition)) continue;
    openTasks.delete(record.issueId);
  }

  return {
    cycles,
    emptyCycles,
    issuesWritten,
    corrections,
    deferredCorrections,
    heldCorrections,
    openTasks: [...openTasks.values()],
  };
}
