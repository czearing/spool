export function markRecoveredAlerts(state, assessments, now) {
  for (const assessment of assessments) {
    if (assessment.kind !== "healthy" || !assessment.build?.definitionId) continue;
    const token = `:${assessment.build.definitionId}:`;
    const recoveredAt = assessment.build.finishTime || now.toISOString();
    for (const [key, alert] of Object.entries(state.alerts)) {
      if (key.startsWith("flaky_capacity:")) continue;
      if (key.includes(token) && !alert.recoveredAt) alert.recoveredAt = recoveredAt;
    }
  }
}

export function alertDue(state, assessment, now, cooldownHours) {
  const previous = state.alerts[assessment.key];
  if (!previous || previous.recoveredAt) return true;
  const effectiveCooldown = assessment.cooldownHours || cooldownHours;
  return now.getTime() - new Date(previous.assignedAt).getTime() >= effectiveCooldown * 3_600_000;
}

export function recordAssignedAlert(state, key, { now, attempt, submissionId, issue }) {
  if (issue === null) return false;
  if (typeof issue?.id !== "string" || !issue.id) throw new Error("Incident assignment did not return a confirmed issue");
  state.alerts[key] = {
    assignedAt: now.toISOString(),
    attempt,
    submissionId,
    issueId: issue.id,
    identifier: issue.identifier || null,
  };
  return true;
}

export function migrateLegacyAlerts(state, assessments) {
  const previousAssessments = state.lastAssessment?.assessments || [];
  for (const assessment of assessments) {
    if (assessment.kind !== "flaky_capacity" || state.alerts[assessment.key]) continue;
    const previous = previousAssessments.find((item) => (
      item.kind === "flaky"
      && /flaky test cap exceeded/i.test(item.summary)
      && item.build?.definitionId === assessment.build?.definitionId
      && state.alerts[item.key]
    ));
    if (!previous) continue;
    state.alerts[assessment.key] = {
      ...state.alerts[previous.key],
      migratedFrom: previous.key,
    };
  }
}
