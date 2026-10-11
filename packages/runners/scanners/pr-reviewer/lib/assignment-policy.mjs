export function applyReviewerAssignmentPolicy(detected, state) {
  const initialized = Array.isArray(state.reviewerAssignments);
  const previousAssignments = new Set(state.reviewerAssignments || []);
  const previousExemptions = new Set(state.ageExemptReviewerAssignments || []);
  const currentAssignments = detected.map((pr) => String(pr.id));
  const nextExemptions = new Set();

  const adjusted = detected.map((pr) => {
    const id = String(pr.id);
    const newlyAssigned = initialized && !previousAssignments.has(id);
    const baselineCurrent = !initialized && !pr.olderThanMaxAge;
    const ageExempt = previousExemptions.has(id) || newlyAssigned || baselineCurrent;
    if (ageExempt) nextExemptions.add(id);
    if (!pr.olderThanMaxAge || !ageExempt) return pr;

    const reasons = pr.reasons.filter((reason) => !reason.startsWith("older than "));
    return {
      ...pr,
      eligible: reasons.length === 0,
      reasons,
      newlyAssignedReviewer: newlyAssigned,
    };
  });

  return {
    detected: adjusted,
    eligible: adjusted.filter((pr) => pr.eligible),
    reviewerAssignments: currentAssignments.sort(),
    ageExemptReviewerAssignments: [...nextExemptions].sort(),
    removedReviewerAssignments: initialized
      ? [...previousAssignments].filter((id) => !currentAssignments.includes(id)).sort()
      : [],
  };
}
