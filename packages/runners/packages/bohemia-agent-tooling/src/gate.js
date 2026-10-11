/**
 * Change gate. A tool is either woken on a cadence or woken by a change, and a change driven tool
 * needs the same three things every time: a mark of what it last observed, a reading of what is there
 * now, and a rule that says whether the difference is worth a cycle.
 *
 * The gate is generic. It never knows what a mark is. A tool supplies readCurrent, which returns a
 * comparable mark, and isRelevant, which says whether the move between two marks touches anything the
 * tool measures. Reading a repository head, a build id, or a row count are all the same shape here.
 *
 * A gate that refuses still lets the cycle append its record. Refusing to work is a result.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function createMarkStore({ path }) {
  if (!path) throw new Error("mark store requires a path");
  return {
    path,
    read() {
      if (!existsSync(path)) return null;
      const text = readFileSync(path, "utf8").trim();
      if (text === "") return null;
      return JSON.parse(text);
    },
    write(state) {
      if (state === null || typeof state !== "object" || Array.isArray(state)) {
        throw new Error("mark state must be an object");
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      return state;
    },
  };
}

export function assertGate(gate) {
  if (!gate) return null;
  if (typeof gate.evaluate !== "function") {
    throw new Error("gate requires an evaluate function");
  }
  if (gate.commit !== undefined && typeof gate.commit !== "function") {
    throw new Error("gate commit must be a function when it is supplied");
  }
  return gate;
}

/**
 * The default change gate. It proceeds when the mark moved and the move is relevant, and it advances
 * the stored mark only when the tool says the cycle finished with the change accounted for. A cycle
 * that was refused a candidate for a reason outside the change, a full queue for instance, leaves the
 * mark where it was so the change is still waiting on the next run.
 */
export function defineChangeGate({
  store,
  readCurrent,
  isRelevant = () => ({ relevant: true }),
  shouldAdvance = () => true,
  bypass = false,
}) {
  if (!store || typeof store.read !== "function" || typeof store.write !== "function") {
    throw new Error("change gate requires a mark store");
  }
  if (typeof readCurrent !== "function") {
    throw new Error("change gate requires a readCurrent function");
  }

  let pending = null;

  return {
    async evaluate(context = {}) {
      const previous = store.read();
      const current = await readCurrent(context);
      if (current === null || current === undefined) {
        pending = null;
        return { proceed: false, reason: "current_mark_unreadable", previous, current: null };
      }

      const previousMark = previous?.mark ?? null;
      // A bypassed run is an operator forcing one cycle. It skips the comparison and the relevance
      // rule, and it still records the real mark it observed, because writing a mark the tool cannot
      // read back would make every later run diff from a value that does not exist.
      if (bypass) {
        pending = { mark: current };
        return {
          proceed: true,
          reason: "bypassed",
          previous: previousMark,
          current,
          detail: { reason: "gate bypassed for this run" },
        };
      }

      if (previousMark !== null && previousMark === current) {
        pending = null;
        return { proceed: false, reason: "mark_unchanged", previous: previousMark, current };
      }

      const relevance = await isRelevant({ previous: previousMark, current, ...context });
      if (!relevance.relevant) {
        pending = { mark: current };
        return {
          proceed: false,
          reason: "no_relevant_change",
          previous: previousMark,
          current,
          detail: relevance.detail ?? null,
        };
      }

      pending = { mark: current };
      return {
        proceed: true,
        reason: previousMark === null ? "first_run" : "relevant_change",
        previous: previousMark,
        current,
        detail: relevance.detail ?? null,
      };
    },

    commit(outcome = {}) {
      if (!pending) return null;
      if (!shouldAdvance(outcome)) return null;
      const state = store.write({ mark: pending.mark, at: new Date().toISOString() });
      pending = null;
      return state;
    },
  };
}
