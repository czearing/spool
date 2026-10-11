/**
 * Which tasks still hold a slot in the queue cap.
 *
 * The shared rollup treats any transition after the open as an end, which is right for counting work
 * that finished. It is not right for a cap: a task the queue could not be read for has not finished,
 * and freeing its slot would put a second task on a writer who is already holding one. Only a real
 * close frees a slot here.
 */

import { TELEMETRY_KINDS } from "../../packages/bohemia-agent-tooling/src/index.js";

export function openTasks(records) {
  const open = new Map();
  for (const record of records) {
    if (record.kind !== TELEMETRY_KINDS.TASK_TRANSITION) continue;
    if (record.transition === "opened") {
      open.set(record.issueId, {
        issueId: record.issueId,
        issueIdentifier: record.issueIdentifier ?? null,
        metric: record.metric,
        current: record.current,
        acceptance: record.acceptance,
        openedAt: record.ts,
        held: false,
      });
      continue;
    }
    if (record.transition === "closed") {
      open.delete(record.issueId);
      continue;
    }
    const existing = open.get(record.issueId);
    if (existing) open.set(record.issueId, { ...existing, held: true, holdReason: record.transition });
  }
  return [...open.values()];
}
