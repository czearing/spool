import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Standardized pure structured todo data schema across all agent auto-assign pipelines.
 * Output is pure JSON, containing zero markdown prose or non-structural formatting.
 */
export function buildStandardTodoData({
  openTasks = [],
  briefs = new Map(),
  transitions = [],
  backlog = [],
  lastCycle = null,
  maxOpenTasks = 3,
  shippedMaxOpenTasks = null,
  rejectionReasons = {},
  formatBrief = null,
} = {}) {
  const opened = new Map();
  const closed = [];
  let cycles = 0;

  for (const record of transitions) {
    if (record.kind === "cycle") {
      cycles += 1;
      continue;
    }
    if (record.kind !== "task_transition") continue;
    if (record.transition === "opened") {
      opened.set(record.issueId, record);
      continue;
    }
    if (record.transition === "unreadable") continue;
    const before = opened.get(record.issueId);
    closed.push({ ...record, before: before?.current ?? null, identifier: before?.issueIdentifier ?? null });
  }

  const queuedActionIds = new Set(
    openTasks.map((task) => {
      const brief = briefs.get?.(task.issueId) ?? (formatBrief ? formatBrief(task, briefs) : null);
      return brief?.actionId;
    }).filter(Boolean),
  );

  const seenActionIds = new Set(queuedActionIds);
  const seenGraphIds = new Set();
  const waiting = [];
  for (const entry of backlog) {
    if (entry.rejection) continue;
    if (openTasks.some((task) => task.metric === entry.metric)) continue;
    if (entry.actionId) {
      if (seenActionIds.has(entry.actionId)) continue;
      seenActionIds.add(entry.actionId);
    }
    if (entry.graphId) {
      if (seenGraphIds.has(entry.graphId)) continue;
      seenGraphIds.add(entry.graphId);
    }
    waiting.push(entry);
  }
  return {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    queueCap: {
      open: openTasks.length,
      max: maxOpenTasks,
      isClosed: openTasks.length >= maxOpenTasks,
      remainingSlots: Math.max(0, maxOpenTasks - openTasks.length),
    },
    inFlight: openTasks.map((task) => {
      const brief = briefs.get?.(task.issueId) ?? (formatBrief ? formatBrief(task, briefs) : null);
      return {
        identifier: brief?.issueIdentifier ?? task.issueIdentifier ?? task.issueId,
        metric: task.metric,
        current: task.current,
        target: task.target,
        severity: brief?.severity ?? null,
        impact: brief?.impact ?? null,
        action: brief?.action ?? null,
        reproduction: brief?.reproduction ?? task.reproduction,
      };
    }),
    waitingBehindCap: waiting.map((entry) => ({
      metric: entry.metric,
      current: entry.current,
      target: entry.target,
      severity: entry.severity ?? null,
      impact: entry.impact ?? null,
      action: entry.action ?? null,
    })),
    finished: closed.map((task) => ({
      identifier: task.identifier ?? task.issueId,
      metric: task.metric,
      before: task.before,
      after: task.after,
      verdict: task.verdict ?? task.transition,
      closedAt: task.ts,
    })),
  };
}

/**
 * Safely reads a structured todo.json file, returning null if not found or invalid.
 */
export function readTodoJson(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Writes standardized todo.json synchronously.
 */
export function writeStandardTodoFiles({ jsonPath, data }) {
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf8");
  }
}
