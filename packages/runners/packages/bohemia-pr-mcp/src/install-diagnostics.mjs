export function installFailure(error) {
  const source = String(error?.message || error);
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const causes = lines.filter(line => /ERR_PNPM_|ERR!|ENOSPC|EACCES|EPERM|EEXIST|ELIFECYCLE|fatal:|error:|error TS/i.test(line));
  const summary = (causes.length ? causes : lines.slice(-12)).slice(-12);
  return `${summary.map(line => `Error: ${line}`).join("\n")}\n\nCaptured install diagnostics:\n${source}`;
}
