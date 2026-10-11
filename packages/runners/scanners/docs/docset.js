/**
 * Document sets. The selected unit is a set, not always one file, because one focused pull request
 * serves one reader doing one job. A set is held together by two things and refuses to form without
 * both: one reader, and one place in the tree.
 *
 * A set can never span two readers. That is structural here, not a check: the reader is part of the
 * key a set is grouped under, so two readers cannot land in one group.
 */

import { isExcluded } from "./exclusion.js";
import { METRICS, measureFile, metricByName, reproductionCommand } from "./metrics.js";

export function readerFor(relPath, readers) {
  for (const reader of readers) {
    if (new RegExp(reader.match).test(relPath)) return reader;
  }
  return null;
}

export function directoryOf(relPath) {
  const parts = relPath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length >= 2 && (parts[0] === "apps" || parts[0] === "packages")) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts.slice(0, Math.min(2, parts.length - 1)).join("/") || parts[0] || ".";
}

export function setKey({ readerId, directory }) {
  return `${readerId}:${directory}`;
}

function overageOf({ value, budget }) {
  return Math.max(0, value - budget);
}

/**
 * Measures every file, groups the ones over budget into sets, and returns one observation per set in
 * the shape the shared scaffold accepts.
 */
export function buildDocumentSets({ repoRoot, files, budgets, readers, identifierIndex, maxFilesPerSet = 50 }) {
  const groups = new Map();
  const measured = [];
  const failures = [];

  for (const file of files) {
    if (isExcluded(file.path)) continue;
    const reader = readerFor(file.path, readers);
    if (!reader) continue;

    let numbers;
    try {
      numbers = measureFile({ repoRoot, relPath: file.path, kind: file.kind, identifierIndex });
    } catch (error) {
      failures.push({ path: file.path, error: error.message });
      continue;
    }

    const entries = [];
    let overage = 0;
    for (const metric of METRICS) {
      const result = numbers[metric.name];
      if (!result) continue;
      const budget = budgets[metric.name];
      const over = overageOf({ value: result.value, budget });
      overage += over;
      entries.push({
        metric: metric.name,
        current: result.value,
        budget,
        unit: metric.unit,
        over,
        evidence: result.evidence ?? null,
      });
    }

    measured.push({ path: file.path, kind: file.kind, overage, metrics: entries });
    if (overage === 0) continue;

    const directory = directoryOf(file.path);
    const key = setKey({ readerId: reader.id, directory });
    if (!groups.has(key)) groups.set(key, { key, reader, directory, files: [] });
    groups.get(key).files.push({ path: file.path, kind: file.kind, overage, metrics: entries });
  }

  const observations = [];
  for (const group of groups.values()) {
    const ranked = [...group.files].sort((a, b) => b.overage - a.overage || a.path.localeCompare(b.path));
    const chosen = ranked.slice(0, maxFilesPerSet);
    const overage = chosen.reduce((total, file) => total + file.overage, 0);
    const worst = chosen[0].metrics.reduce((best, entry) => (entry.over > (best?.over ?? -1) ? entry : best), null);

    observations.push({
      metric: `docs.set:${group.key}`,
      current: overage,
      target: 0,
      acceptance: 0,
      unit: "budget overages",
      direction: "lower_is_better",
      reproduction: reproductionCommand(chosen.map((file) => file.path)),
      setKey: group.key,
      readerId: group.reader.id,
      reader: group.reader.reader,
      job: group.reader.job,
      thesis: `one reader and one place in the tree, ${group.directory}`,
      directory: group.directory,
      files: chosen,
      dropped: ranked.length - chosen.length,
      worstMetric: worst?.metric ?? null,
    });
  }

  observations.sort((a, b) => b.current - a.current || a.metric.localeCompare(b.metric));
  return { observations, measured, failures };
}

/**
 * The written issue. It carries the set, the reader and the job, the numbers per file, the command
 * that recomputes them, the acceptance number, and the exclusion. Nothing else.
 */
export function renderDocsTask(candidate, { exclusionStatement, repoRoot = null } = {}) {
  const root = repoRoot || candidate.repoRoot || null;
  const branchName = candidate.branchName || null;
  const lines = [
    `document set: ${candidate.files.map((file) => file.path).join(" ")}`,
    `reader: ${candidate.reader}`,
    `job: ${candidate.job}`,
    `set holds together: ${candidate.thesis}`,
  ];

  if (branchName) {
    const repoText = root ? ` in \`${root}\`` : "";
    lines.push(
      "",
      `The branch \`${branchName}\` is checked out${repoText} and verified clean. The workspace and dependencies are already set up for you. Do not run git checkout, fetch, reset, or clean; proceed directly to your edits.`,
      "",
    );
  }

  lines.push("numbers, metric current/budget:");

  for (const file of candidate.files) {
    const over = file.metrics.filter((entry) => entry.over > 0);
    lines.push(`  ${file.path} ${over.map((entry) => `${shortMetric(entry.metric)} ${entry.current}/${entry.budget}`).join(" ")}`);
  }

  lines.push(
    `reproduction: ${candidate.reproduction}`,
    `acceptance: every number at or below its budget, total overage ${candidate.acceptance} from ${candidate.current}`,
    exclusionStatement,
    "Close this issue when the acceptance number is met, record the pull request identifier on it, and",
    "record the measured result as a line",
    "after: <number>",
  );

  return {
    title: `docs: ${candidate.directory} overage ${candidate.current}`,
    body: lines.join("\n"),
  };
}

export function shortMetric(name) {
  return metricByName(name).name.replace(/^docs\./, "");
}
