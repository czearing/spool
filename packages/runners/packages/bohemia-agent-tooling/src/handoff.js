import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The handoff ledger.
 *
 * Every tool that gives work to an agent has to answer the same three questions later: what was
 * handed over, to which agent, and when. Reading that back from the queue is not an answer, because
 * an issue that was never created leaves no trace there at all, which is precisely the failure this
 * ledger exists to make visible.
 *
 * The ledger is append only and it is written by the tool, never by hand. A view reads it and stays
 * out of the execution path.
 */

const HANDED = "handed";
const ACCEPTED = "accepted";
const CLOSED = "closed";
const REFUSED = "refused";
const HELD = "held";

export const HANDOFF_TRANSITIONS = Object.freeze({ HANDED, ACCEPTED, CLOSED, REFUSED, HELD });

const TRANSITIONS = new Set(Object.values(HANDOFF_TRANSITIONS));

function assertTransition(transition) {
  if (!TRANSITIONS.has(transition)) {
    throw new Error(`handoff transition must be one of ${[...TRANSITIONS].join(", ")}, received "${transition}"`);
  }
}

/**
 * A handoff that names no task and no recipient records nothing useful and hides a real bug, so it
 * is refused at the write rather than stored and puzzled over later.
 */
function assertRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("handoff record must be an object");
  }
  if (!record.taskKey) throw new Error("handoff record requires a taskKey");
  if (!record.agent) throw new Error("handoff record requires an agent");
}

export function createHandoffLedger({ path, tool, now = () => new Date() }) {
  if (!path) throw new Error("handoff ledger requires a path");
  if (!tool) throw new Error("handoff ledger requires a tool name");

  mkdirSync(dirname(path), { recursive: true });

  return {
    path,
    append(transition, record) {
      assertTransition(transition);
      assertRecord(record);
      const line = { at: now().toISOString(), tool, transition, ...record };
      appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
      return line;
    },
    read() {
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter((entry) => entry.trim().length > 0)
        .map((entry) => JSON.parse(entry));
    },
  };
}

/**
 * Reduce the ledger to one row per task, newest transition wins.
 *
 * `handedAt` keeps the first handover time rather than the newest, because the question a person
 * asks is when the agent was given the work, not when the record was last touched.
 */
export function handoffRollup(records) {
  const tasks = new Map();
  for (const record of records) {
    if (!record?.taskKey) continue;
    const existing = tasks.get(record.taskKey);
    tasks.set(record.taskKey, {
      taskKey: record.taskKey,
      agent: record.agent,
      issueId: record.issueId ?? existing?.issueId ?? null,
      identifier: record.identifier ?? existing?.identifier ?? null,
      title: record.title ?? existing?.title ?? null,
      transition: record.transition,
      handedAt: record.transition === HANDED ? existing?.handedAt ?? record.at : existing?.handedAt ?? null,
      updatedAt: record.at,
      detail: record.detail ?? null,
    });
  }
  return [...tasks.values()].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

/**
 * The one assertion an operator cares about: did every task the tool decided to hand over actually
 * reach an agent. A refusal is a failed handoff even when the cycle itself reported success.
 */
export function handoffFailures(records) {
  return handoffRollup(records).filter((task) => task.transition === REFUSED);
}
