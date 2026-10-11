/**
 * Brief correction surface. A tool that writes a numeric brief owns the numbers it wrote, and until
 * now it had no way to put a wrong number right. Drift detection could see that a brief had gone
 * stale, the defect channel could say so once, and there the record stopped: the task the engineer is
 * holding still carried the old number on every following wake.
 *
 * Correcting the brief is not a fifth channel. It is a second write on the task out channel, to the
 * same fields the tool wrote in the first place, rendered by the same renderer, so a corrected brief
 * and a freshly written one are the same shape.
 *
 * The write is field scoped by construction. Only the carried brief is sent. Status, result and every
 * other field the running assignee owns are never in the payload, so a correction cannot take work
 * away from the agent doing it.
 *
 * The queue may refuse the write while the assignee holds a live run checkout. That refusal is a lock
 * and not a wall: it clears when the run ends. A deferred correction is therefore recorded and retried
 * on the next wake rather than escalated, and only a deferral that keeps failing is handed to the tool
 * owner as a defect.
 */

import { buildTaskIssue } from "./issue-writer.js";
import { formatBriefNumber, withinTolerance } from "./brief.js";
import { isRunContextRefusal, RUN_CONTEXT_REFUSAL_CODE } from "./run-context.js";

export const CORRECTION_RESULTS = Object.freeze({
  APPLIED: "applied",
  UNCHANGED: "unchanged",
  DEFERRED: "deferred",
  HELD: "held",
  REFUSED: "refused",
  NOT_CONFIGURED: "not_configured",
});

export const ASSIGNEE_RUN_LOCK_CODE = "issue_write_assignee_run_lock";

/** The carried fields a correction is allowed to rewrite. Everything else belongs to the run. */
export const CORRECTABLE_FIELDS = Object.freeze(["title", "description"]);

/**
 * A refusal that clears on its own. The queue reports it by code, and a queue that only passes the
 * response text through still carries the code inside that text.
 */
export function isRunLockRefusal(error) {
  if (!error) return false;
  const code = error.code ?? error.details?.code ?? null;
  if (code === ASSIGNEE_RUN_LOCK_CODE) return true;
  const text = typeof error === "string" ? error : (error.message ?? "");
  return text.includes(ASSIGNEE_RUN_LOCK_CODE);
}

const NUMERIC_FIELDS = ["current", "target", "acceptance"];

/**
 * The corrected brief for one open task, from the freshest observation of the same metric. The
 * numbers come from the collection interface, never from a hand supplied value, so a tool cannot
 * correct a brief into a number nothing measured.
 */
export function buildBriefCorrection({
  task,
  observation,
  renderTask,
  bodyBudget,
  titleBudget,
  tolerance = 0,
} = {}) {
  if (!task || typeof task.issueId !== "string" || task.issueId.trim() === "") {
    throw new Error("a brief correction requires the issue id of an open task");
  }
  if (!observation || observation.metric !== task.metric) {
    throw new Error("a brief correction requires an observation of the same metric as the task");
  }

  const candidate = {
    metric: observation.metric,
    current: observation.current,
    target: observation.target,
    acceptance: observation.acceptance ?? observation.target,
    unit: observation.unit,
    reproduction: observation.reproduction,
    direction: observation.direction ?? "lower_is_better",
  };

  const changedFields = NUMERIC_FIELDS.filter(
    (key) => !withinTolerance(task[key], candidate[key], tolerance),
  );

  if (changedFields.length === 0) {
    return {
      issueId: task.issueId,
      metric: task.metric,
      changed: false,
      changedFields: [],
      recorded: task.current,
      candidate,
      fields: null,
    };
  }

  const { title, body } = buildTaskIssue(candidate, { bodyBudget, titleBudget, renderTask });

  return {
    issueId: task.issueId,
    metric: task.metric,
    changed: true,
    changedFields,
    recorded: task.current,
    candidate,
    fields: { title, description: body },
  };
}

/**
 * Sends the corrected brief. The result is one of a fixed set, because the cycle that calls this has
 * to record what happened without deciding anything per run.
 */
export async function applyBriefCorrection({ queue, correction, attempt = 1 }) {
  if (!correction) throw new Error("applyBriefCorrection requires a correction");
  if (correction.changed !== true) {
    return { result: CORRECTION_RESULTS.UNCHANGED, reason: "brief already carries the observed numbers", attempt };
  }
  if (!queue || typeof queue.updateIssue !== "function") {
    throw new Error("a brief correction requires a queue with updateIssue");
  }

  for (const key of Object.keys(correction.fields)) {
    if (!CORRECTABLE_FIELDS.includes(key)) {
      throw new Error(`a brief correction may not write ${key}, which belongs to the assignee run`);
    }
  }

  try {
    await queue.updateIssue(correction.issueId, { ...correction.fields });
  } catch (error) {
    /**
     * A write the run cannot be attributed for is held, not failed and not deferred. Retrying it from
     * another timer woken run would be refused for the same reason, so it carries no attempt count
     * and never reaches the deferral limit. The next run that names a source issue rebuilds the same
     * correction from the record and sends it.
     */
    if (isRunContextRefusal(error)) {
      return {
        result: CORRECTION_RESULTS.HELD,
        reason: RUN_CONTEXT_REFUSAL_CODE,
        attempt,
      };
    }
    if (isRunLockRefusal(error)) {
      return {
        result: CORRECTION_RESULTS.DEFERRED,
        reason: ASSIGNEE_RUN_LOCK_CODE,
        attempt,
      };
    }
    return { result: CORRECTION_RESULTS.REFUSED, reason: error.message ?? String(error), attempt };
  }

  return { result: CORRECTION_RESULTS.APPLIED, reason: "brief rewritten in place", attempt };
}

/**
 * The corrector a tool configures. A tool that renders its task differently passes the same
 * renderTask it writes with, so the correction stays the shape of the original brief.
 */
export function createBriefCorrector({ queue, renderTask, bodyBudget, titleBudget, tolerance = 0 } = {}) {
  if (!queue || typeof queue.updateIssue !== "function") {
    throw new Error("a brief corrector requires a queue with updateIssue");
  }
  return async function correct({ task, observation, attempt = 1 }) {
    const correction = buildBriefCorrection({ task, observation, renderTask, bodyBudget, titleBudget, tolerance });
    const outcome = await applyBriefCorrection({ queue, correction, attempt });
    return { ...outcome, correction };
  };
}

export function describeUncorrectedBrief(drift, outcome) {
  const unit = drift.unit ? ` ${drift.unit}` : "";
  const numbers = `${formatBriefNumber(drift.recorded)}${unit} against ${formatBriefNumber(drift.observed)}${unit}`;
  if (outcome?.result === CORRECTION_RESULTS.DEFERRED) {
    return `brief correction is still refused after ${outcome.attempt} attempts: ${drift.metric} carries ${numbers} and the write is held by ${outcome.reason}`;
  }
  if (outcome?.result === CORRECTION_RESULTS.HELD) {
    return `brief correction is waiting for a run it can be attributed to: ${drift.metric} carries ${numbers} and the write was held by ${outcome.reason}`;
  }
  return `brief correction was refused: ${drift.metric} carries ${numbers} and the write failed with ${outcome?.reason ?? "an unknown reason"}`;
}
