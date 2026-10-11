/**
 * Candidate selection for the docs engine. The scaffold's own rule ranks by how far a number sits
 * from its target as a ratio, which says nothing useful when every budget is a small count and some
 * budgets are zero. This ranks by total overage instead, and refuses anything under the floor so a
 * document one sentence over budget never becomes somebody's morning.
 */

export function defineDocsSelector({ minOverage = 1 } = {}) {
  if (!Number.isInteger(minOverage) || minOverage < 1) {
    throw new Error("minOverage must be a whole number of at least 1");
  }
  return function selectCandidate(observations) {
    const eligible = observations
      .filter((observation) => observation.current >= minOverage)
      .sort((a, b) => b.current - a.current || a.metric.localeCompare(b.metric));

    const ranked = eligible.slice(0, 5).map((observation) => ({
      set: observation.setKey,
      reader: observation.readerId,
      overage: observation.current,
      files: observation.files.length,
    }));

    if (eligible.length === 0) {
      return {
        candidate: null,
        reason: "no_document_set_over_budget",
        minOverage,
        considered: observations.length,
        ranked,
      };
    }

    return {
      candidate: eligible[0],
      reason: "largest_overage_above_floor",
      minOverage,
      considered: observations.length,
      ranked,
    };
  };
}
