export function observationChanges(previous, detected) {
  const current = {};
  const changed = [];
  for (const pr of detected) {
    const key = `${pr.repository}#${pr.id}`;
    const signature = JSON.stringify({
      title: pr.title,
      eligible: pr.eligible,
      sourceCommit: pr.sourceCommit,
      reasons: pr.reasons,
    });
    current[key] = signature;
    if (previous[key] !== signature) changed.push(pr);
  }
  return { changed, current };
}

export function scanActivityDecision(previousSignature, lastLoggedAt, summary, now, heartbeatMs = 600_000, force = false) {
  const signature = JSON.stringify(summary);
  const log = force || signature !== previousSignature || now - lastLoggedAt >= heartbeatMs;
  return { log, signature, lastLoggedAt: log ? now : lastLoggedAt };
}
