export function totalMs(steps) {
  return (steps || []).reduce((total, step) => total + (Number.isFinite(step.ms) ? step.ms : 0), 0);
}

export function stepTimings(steps) {
  const usable = (steps || []).filter(step => Number.isFinite(step.ms));
  if (!usable.length) return null;
  const byStep = {};
  for (const step of [...usable].sort((left, right) => right.ms - left.ms)) byStep[step.name] = step.ms;
  return { totalMs: totalMs(usable), ...byStep };
}
