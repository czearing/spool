/**
 * Run attribution surface. Every mutating write on an issue that already exists is attributed to the
 * run that made it, and the queue refuses a write from a run it cannot attribute. A tool woken by a
 * timer has a run and no issue of its own, so a write it makes on an issue it owns arrives with
 * nothing to attribute it to and is refused with the same code on every wake.
 *
 * That refusal is neither a lock nor a wall. A lock clears when a run ends, and the cycle already
 * waits one out. This one clears when the tool next runs from a run that names a source issue, which
 * is a different thing to wait for: waiting is right, counting attempts against a deferral limit is
 * not, because no number of timer woken retries will ever land the write.
 *
 * So an unattributable write is held. It is not sent, it is not counted as a failure, and it is not
 * handed to the tool owner as a defect. It is recorded, and the next attributable run recomputes the
 * same numbers and writes them. Nothing is stored between the two: a held write is an intent the
 * cycle rebuilds from the record and the collection, never a number kept on the side to go stale.
 */

export const RUN_CONTEXT_REFUSAL_CODE = "cross_issue_influence_run_context_required";

/** Reads a run is attributed by. A write on an existing issue needs both of them. */
export const RUN_CONTEXT_ENV_KEYS = Object.freeze({
  runId: ["PAPERCLIP_RUN_ID"],
  sourceIssueId: ["PAPERCLIP_TASK_ID", "PAPERCLIP_ISSUE_ID"],
});

export const RUN_CONTEXT_REASONS = Object.freeze({
  ATTRIBUTABLE: "attributable",
  NO_RUN_ID: "no_run_id",
  NO_SOURCE_ISSUE: "no_source_issue",
});

/** The writes that are attributed to a run. Creating an issue is not one of them. */
export const ATTRIBUTED_WRITES = Object.freeze(["updateIssue", "cancelIssue", "parkIssue"]);

export class RunContextHeldError extends Error {
  constructor(message, runContext) {
    super(message);
    this.name = "RunContextHeldError";
    this.code = RUN_CONTEXT_REFUSAL_CODE;
    this.held = true;
    this.runContext = runContext ?? null;
  }
}

function firstValue(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/**
 * The run context of the process making the write, read from the wake environment. This is a read,
 * never a claim: a tool cannot declare itself attributable, it can only be woken that way.
 */
export function readRunContext(env = {}) {
  const runId = firstValue(env, RUN_CONTEXT_ENV_KEYS.runId);
  const sourceIssueId = firstValue(env, RUN_CONTEXT_ENV_KEYS.sourceIssueId);
  let reason = RUN_CONTEXT_REASONS.ATTRIBUTABLE;
  if (!runId) reason = RUN_CONTEXT_REASONS.NO_RUN_ID;
  else if (!sourceIssueId) reason = RUN_CONTEXT_REASONS.NO_SOURCE_ISSUE;
  return {
    runId,
    sourceIssueId,
    attributable: reason === RUN_CONTEXT_REASONS.ATTRIBUTABLE,
    reason,
  };
}

/**
 * A refusal the run context caused. It is answered by code, because the sentence the queue sends back
 * asks for the run id header the request already carried and so cannot be read for the cause.
 */
export function isRunContextRefusal(error) {
  if (!error) return false;
  if (error.held === true) return true;
  const code = error.code ?? error.details?.code ?? null;
  if (code === RUN_CONTEXT_REFUSAL_CODE) return true;
  const text = typeof error === "string" ? error : (error.message ?? "");
  return text.includes(RUN_CONTEXT_REFUSAL_CODE);
}

export function describeUnattributableRun(runContext) {
  if (!runContext || runContext.attributable) return "the run can attribute its writes";
  if (runContext.reason === RUN_CONTEXT_REASONS.NO_RUN_ID) {
    return "the write was held because this run has no run id to attribute it to";
  }
  return "the write was held because this run names no source issue to attribute it to";
}

/**
 * Wraps a queue so a write on an existing issue is held rather than sent when the run cannot be
 * attributed. Reads and issue creation pass straight through, which is the same line the queue draws:
 * a new issue is not influence on an issue someone else is holding.
 */
export function guardIssueWrites(queue, runContext) {
  if (!queue) throw new Error("guarding issue writes requires a queue");
  if (!runContext) throw new Error("guarding issue writes requires a run context");
  if (runContext.attributable) return queue;

  const guarded = Object.create(queue);
  for (const name of ATTRIBUTED_WRITES) {
    if (typeof queue[name] !== "function") continue;
    guarded[name] = async () => {
      throw new RunContextHeldError(describeUnattributableRun(runContext), runContext);
    };
  }
  guarded.runContext = runContext;
  return guarded;
}
