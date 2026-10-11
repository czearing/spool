import { measurementVersion } from "./artifacts.mjs";

const comparable = (a, b) => !!b && a.measurementVersion === b.measurementVersion &&
  a.build.platform === b.build.platform && a.build.architecture === b.build.architecture &&
  a.build.collectorNode === b.build.collectorNode && JSON.stringify(a.exclusions) === JSON.stringify(b.exclusions);

export function createInventory(current, previous = null) {
  const canCompare = comparable(current, previous);
  const baselineGroups = new Map(canCompare ? previous.groups.map(group => [group.name, group]) : []);
  const byAssetSet = new Map();
  for (const group of current.groups) {
    const prior = baselineGroups.get(group.name);
    const delta = prior?.brotliBytes != null && group.brotliBytes !== null
      ? group.brotliBytes - prior.brotliBytes : null;
    const key = JSON.stringify([group.assets, prior?.brotliBytes ?? null]);
    // Asset groups can overlap; identical measurements are one observation.
    const existing = byAssetSet.get(key);
    if (existing) { existing.relatedGroups.push(group.name); continue; }
    byAssetSet.set(key, {
      id: group.name, label: group.label,
      status: "artifact_measurement_only", kind: group.brotliBytes === null ? "brotli_sidecar_absent"
        : delta > 0 ? "artifact_increase" : prior ? "artifact_inventory" : "initial_inventory",
      identityBytes: group.identityBytes, brotliBytes: group.brotliBytes,
      baselineBrotliBytes: prior?.brotliBytes ?? null, deltaBrotliBytes: delta,
      assets: group.assets, missingBrotli: group.missingBrotli, relatedGroups: [],
      runtimeImpact: null, potentialSavings: null,
    });
  }
  const observations = [...byAssetSet.values()].sort((a, b) =>
    Number(b.kind === "artifact_increase") - Number(a.kind === "artifact_increase") ||
    (b.deltaBrotliBytes ?? 0) - (a.deltaBrotliBytes ?? 0) ||
    (b.brotliBytes ?? -1) - (a.brotliBytes ?? -1) || a.id.localeCompare(b.id));
  return {
    version: 3, measurementVersion, generatedAt: new Date().toISOString(), mode: "artifact-inventory",
    performanceValidation: "not_performed",
    dispatchHolding: "Artifact observations are not verified performance issues; no automatic handoffs",
    scan: { repoRoot: current.build.repoRoot, branch: current.build.branch, commit: current.build.commit },
    build: current.build, artifactFingerprint: current.fingerprint,
    baseline: previous ? { commit: previous.build.commit, builtAt: previous.build.builtAt, comparable: canCompare } : null,
    comparison: canCompare ? "previous_successful_revision" : previous ? "incompatible_baseline" : "first_inventory",
    scope: "Locally built production client JS/CSS, with the build's locale exclusions; excludes SSR, source maps and other asset types.",
    measurement: "Actual emitted file lengths and validated repository-generated Brotli sidecars, not source sizes or estimated module sizes.",
    limitations: [
      "Artifact body sizes are not observed CDN transfer sizes or user-experience measurements.",
      "Route groups include sibling chunks, can overlap, and are not complete navigation waterfalls. Never sum group totals.",
      "Missing Brotli sidecars are unknown compressed sizes, not zero or an assumed gzip size.",
      "An absent Brotli sidecar does not establish a compression or runtime performance defect.",
      "No arbitrary byte targets, severity scores, claimed runtime savings, or automatic assignments.",
    ],
    totals: current.totals, excludedAssets: current.excludedAssets, exclusions: current.exclusions,
    observations, groups: current.groups, assets: current.assets,
  };
}

const bytes = value => value === null ? "unknown" : `${(value / 1024).toFixed(1)} KiB`;
const escapeCell = value => String(value).replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");

export function renderInventory(report) {
  const rows = report.observations.map(todo => `| ${escapeCell(todo.id)} | ${bytes(todo.brotliBytes)} | ${bytes(todo.identityBytes)} | ${
    todo.deltaBrotliBytes === null ? (report.baseline ? "not comparable" : "no baseline")
      : `${todo.deltaBrotliBytes >= 0 ? "+" : "-"}${bytes(Math.abs(todo.deltaBrotliBytes))}`
  } | ${todo.kind.replaceAll("_", " ")} |`);
  const assets = [...report.assets].sort((a, b) => (b.brotliBytes ?? -1) - (a.brotliBytes ?? -1)).slice(0, 15);
  return [
    "# Artifact size inventory - not performance issues", "",
    "**Measurements only. Do not create fix tasks or change product code based on this inventory alone.**", "",
    `Generated: ${report.generatedAt}`,
    `Commit: \`${report.scan.commit}\``,
    `Build: production release through \`bohemia_build\`; completed ${report.build.builtAt}.`,
    `Baseline: ${report.baseline ? `\`${report.baseline.commit}\` (${report.comparison})` : "none - first inventory; no regression or savings claim."}`,
    "", report.scope, "", report.measurement, "",
    `Unique included assets: ${report.assets.length}. Identity: ${bytes(report.totals.identityBytes)}. Brotli: ${bytes(report.totals.brotliBytes)}.`,
    "", "## Artifact observations", "",
    "Ordered by measured increase when comparable, then current Brotli size. Group totals overlap.",
    "A large asset or byte increase does not establish a performance defect. Runtime validation has not been performed.", "",
    "| Asset group | Brotli body | Identity body | Change | Evidence |",
    "| --- | ---: | ---: | ---: | --- |", ...rows, "",
    "## Largest emitted assets", "",
    "| Asset | Brotli body | Identity body |",
    "| --- | ---: | ---: |",
    ...assets.map(asset => `| ${escapeCell(asset.name)} | ${bytes(asset.brotliBytes)} | ${bytes(asset.identityBytes)} |`),
    "", "## Measurement boundaries", "",
    ...report.limitations.map(note => `- ${note}`),
    ...report.totals.missingBrotli.map(name => `- Missing Brotli sidecar: \`${name}\``),
    "", "Full asset hashes, group membership and build provenance are in the neighboring `inventory.json`.", "",
  ].join("\n");
}

export function createTodo({ issues = [], stale = [] } = {}) {
  return {
    version: 4,
    mode: issues.length ? "validated-bundle-issues" : "validation-required",
    status: issues.length ? "validated_bundle_issues" : "performance_validation_unavailable",
    automaticDispatch: false,
    todos: issues,
    staleProofs: stale,
    explanation: "Artifact sizes alone are not issues. Tasks require paired production builds, passing browser workflows, request-set checks and a reversal control matching current client artifacts.",
    inventory: { json: "inventory.json", markdown: "inventory.md", containsVerifiedPerformanceIssues: false },
    requiredEvidence: [
      "A specific reproducible user scenario and affected production build revision.",
      "A narrow source change with a measured bundle reduction, not merely a large asset or byte increase.",
      "Retained production artifacts, browser request evidence, behavior checks and a reversal control.",
      "An acceptance criterion independent of the implementation agent, with review before assignment.",
    ],
  };
}

export function renderTodo(todo) {
  if (todo.todos.length) {
    return [
      "# Validated bundle performance todos", "",
      "**No automatic handoff. These are measured bundle-payload improvements, not latency claims.**", "",
      ...todo.todos.flatMap(issue => [
        `## ${issue.title}`, "",
        `- [ ] ${issue.action}`,
        `Source: \`${issue.sourcePath}\``,
        `Initial JS/CSS Brotli bodies: ${issue.initialBrotliBytes.before} -> ${issue.initialBrotliBytes.after} bytes (${issue.initialBrotliBytes.reduction} fewer).`,
        `Total included JS/CSS Brotli bodies: ${issue.totalBrotliBytes.before} -> ${issue.totalBrotliBytes.after} bytes.`,
        ...issue.scenarios.map(scenario =>
          `${scenario.name}: ${scenario.baseline.requests} -> ${scenario.candidate.requests} asset requests; ${scenario.baseline.brotliBytes} -> ${scenario.candidate.brotliBytes} Brotli artifact bytes.`),
        `Measured on \`${issue.evidence.measuredCommit}\`; source and client artifacts matched at scan \`${issue.evidence.observedCommit}\`.`,
        "Restoring the export reproduced the original artifact fingerprint exactly.",
        ...issue.acceptance.map(condition => `- Acceptance: ${condition}`),
        issue.limitations,
        `Evidence: \`${issue.evidence.directory}\``, "",
      ]),
    ].join("\n");
  }
  return [
    "# Verified performance todos", "",
    "**No verified performance issues are available. No automatic handoff.**", "",
    todo.explanation, "",
    "An empty list does not mean the application is fast or free of performance problems.", "",
    "Measured sizes remain available separately in `inventory.md` and `inventory.json`.",
    "Those files are observations, not tasks or instructions to optimize product code.", "",
    "## Evidence required before adding a performance task", "",
    ...todo.requiredEvidence.map(item => `- ${item}`), "",
    ...todo.staleProofs.map(proof => `Stale proof \`${proof.proof}\`: ${proof.reason}.`), "",
    "Artifact observations cannot populate this list. A matching controlled bundle experiment is required.", "",
  ].join("\n");
}
