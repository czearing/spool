/**
 * Brief surface. A task brief carries a number and the command that is supposed to produce it, and
 * nothing in the scaffold used to hold those two together. Two failures follow from that gap and both
 * are answered here.
 *
 * The first is a brief written with a number the named command does not produce. The verifier runs the
 * command the brief will name and refuses the write when the number is absent from what came back.
 *
 * The second is a brief that was right when it was written and is wrong now, because what the tool
 * measures moved underneath an open task. Drift detection compares the number recorded on every open
 * task against the fresh collection for the same metric, so a stale brief is reported by the tool that
 * wrote it rather than by the agent who tried to work it.
 *
 * Both checks are deterministic and neither knows what is being measured.
 */

export const BRIEF_VERIFICATION = Object.freeze({
  VERIFIED: "verified",
  UNVERIFIED: "unverified",
  UNRUNNABLE: "unrunnable",
  NOT_CONFIGURED: "not_configured",
});

const NUMBER_PATTERN = /-?\d+(?:\.\d+)?/g;

export function formatBriefNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

/**
 * Every number the command printed. Digit grouping is removed first, because a command that prints
 * 20,203,293 printed the same number as one that prints 20203293.
 */
export function readNumbers(text) {
  if (typeof text !== "string" || text.trim() === "") return [];
  const flattened = text.replace(/(\d),(?=\d{3}\b)/g, "$1");
  return (flattened.match(NUMBER_PATTERN) ?? []).map(Number).filter((value) => Number.isFinite(value));
}

export function withinTolerance(expected, observed, tolerance = 0) {
  if (expected === observed) return true;
  if (tolerance <= 0) return false;
  const scale = Math.abs(expected) || 1;
  return Math.abs(observed - expected) / scale <= tolerance;
}

/**
 * The number the brief claims must be one of the numbers the named command produced.
 */
export function checkNumberInOutput(expected, output, { tolerance = 0 } = {}) {
  const observed = readNumbers(output);
  const matched = observed.find((value) => withinTolerance(expected, value, tolerance));
  return {
    verified: matched !== undefined,
    matched: matched ?? null,
    observed,
  };
}

/**
 * Builds the check the cycle runs before it writes a numeric task. The runner is supplied by the tool
 * because the shared core does not decide how a command is executed, and it returns
 * { ok, output } for one command string.
 */
export function createReproductionVerifier({ run, tolerance = 0 }) {
  if (typeof run !== "function") {
    throw new Error("reproduction verifier requires a run function returning { ok, output }");
  }

  return async function verifyBrief(candidate) {
    const command = candidate?.reproduction;
    if (typeof command !== "string" || command.trim() === "") {
      return { status: BRIEF_VERIFICATION.UNRUNNABLE, reason: "no_reproduction_command", observed: [] };
    }

    let result;
    try {
      result = await run({ command, candidate });
    } catch (error) {
      return { status: BRIEF_VERIFICATION.UNRUNNABLE, reason: error.message, observed: [] };
    }

    if (!result || result.ok !== true) {
      return {
        status: BRIEF_VERIFICATION.UNRUNNABLE,
        reason: result?.reason ?? "reproduction command failed",
        observed: [],
      };
    }

    const { verified, matched, observed } = checkNumberInOutput(candidate.current, result.output, { tolerance });
    if (verified) {
      return { status: BRIEF_VERIFICATION.VERIFIED, reason: "current number reproduced", matched, observed };
    }
    return {
      status: BRIEF_VERIFICATION.UNVERIFIED,
      reason: `current ${formatBriefNumber(candidate.current)} is absent from the output of the reproduction command`,
      matched: null,
      observed,
    };
  };
}

/**
 * Open tasks whose recorded number no longer matches what the tool measures now. An open task with no
 * fresh observation is not drift, because a metric that was not collected this cycle was not measured
 * and a silence is not a disagreement.
 */
export function detectDrift(openTasks, observations, { tolerance = 0 } = {}) {
  const latest = new Map();
  for (const observation of observations ?? []) {
    latest.set(observation.metric, observation);
  }

  const drifts = [];
  for (const task of openTasks ?? []) {
    const observation = latest.get(task.metric);
    if (!observation) continue;
    if (typeof task.current !== "number" || !Number.isFinite(task.current)) continue;
    if (withinTolerance(task.current, observation.current, tolerance)) continue;
    drifts.push({
      issueId: task.issueId,
      metric: task.metric,
      recorded: task.current,
      observed: observation.current,
      unit: observation.unit ?? null,
      delta: observation.current - task.current,
    });
  }
  return drifts;
}

/**
 * The defect wording for a drifted brief. One line, because the defect channel carries a summary and
 * the numbers, not a narrative.
 */
export function describeDrift(drift) {
  const unit = drift.unit ? ` ${drift.unit}` : "";
  return `brief is stale: ${drift.metric} was written as ${formatBriefNumber(drift.recorded)}${unit} and now measures ${formatBriefNumber(drift.observed)}${unit}`;
}

export function describeUnverifiedBrief(candidate, verification) {
  const unit = candidate.unit ? ` ${candidate.unit}` : "";
  const observed = verification.observed?.length ? verification.observed.slice(0, 4).join(", ") : "no numbers";
  return `brief refused: ${candidate.metric} current ${formatBriefNumber(candidate.current)}${unit} was not produced by its reproduction command, which returned ${observed}`;
}
