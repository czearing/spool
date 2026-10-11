/**
 * Candidate selection interface. The shared core supplies one default rule and accepts any other.
 * The default rule is a gap rule: an observation is a candidate when it is worse than its target by
 * at least the configured margin. Direction says which way is worse.
 */

export function gapRatio(observation) {
  const { current, target, direction = "lower_is_better" } = observation;
  if (target === 0) return current === 0 ? 0 : Infinity;
  const raw = direction === "higher_is_better" ? (target - current) / target : (current - target) / target;
  return raw;
}

export function defineThresholdSelector({ minGapRatio = 0.1, excludeMetrics = () => false } = {}) {
  if (typeof minGapRatio !== "number" || !Number.isFinite(minGapRatio)) {
    throw new Error("minGapRatio must be a finite number");
  }
  return function selectCandidate(observations) {
    const eligible = observations
      .filter((observation) => !excludeMetrics(observation))
      .map((observation) => ({ observation, gap: gapRatio(observation) }))
      .filter((entry) => entry.gap >= minGapRatio)
      .sort((a, b) => b.gap - a.gap);

    if (eligible.length === 0) {
      return {
        candidate: null,
        reason: "no_observation_cleared_threshold",
        minGapRatio,
        considered: observations.length,
      };
    }

    const best = eligible[0];
    return {
      candidate: { ...best.observation, gap: best.gap },
      reason: "largest_gap_above_threshold",
      minGapRatio,
      considered: observations.length,
    };
  };
}

export function assertSelector(selector) {
  if (typeof selector !== "function") {
    throw new Error("selector must be a function taking observations and returning a selection");
  }
  return selector;
}

/**
 * The queue cap. One cycle already writes at most one issue, but nothing stops a run of cycles from
 * stacking one open task per candidate on the same assignee. This wraps any selection rule and
 * refuses to produce a candidate once the number of tasks still open reaches the cap. The count comes
 * from the tool, so a task the queue could not be read for still holds its slot rather than quietly
 * freeing one.
 *
 * The ranking the wrapped rule produced is kept. A full queue is exactly the moment somebody wants to
 * know what is waiting behind it.
 */
export function defineOpenCapSelector({ selector, countOpen, maxOpenTasks }) {
  assertSelector(selector);
  if (typeof countOpen !== "function") {
    throw new Error("open cap selector requires a countOpen function");
  }
  if (!Number.isInteger(maxOpenTasks) || maxOpenTasks < 1) {
    throw new Error("maxOpenTasks must be a whole number of at least 1");
  }
  return function selectCandidate(observations) {
    const openTasks = countOpen();
    const selection = selector(observations);
    if (openTasks >= maxOpenTasks) {
      return { ...selection, candidate: null, reason: "max_open_tasks_reached", maxOpenTasks, openTasks };
    }
    return { ...selection, maxOpenTasks, openTasks };
  };
}
