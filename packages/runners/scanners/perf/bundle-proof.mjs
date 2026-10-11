import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { digest, readArtifacts } from "./artifacts.mjs";
import { browserPolicyHash, primaryScenario, verifyBrowserEvidence } from "./browser-evidence.mjs";

const normalized = text => text.replaceAll("\r\n", "\n");
const readJson = file => JSON.parse(readFileSync(file, "utf8"));
export const footprint = artifacts => digest(JSON.stringify({
  measurementVersion: artifacts.measurementVersion,
  assets: [...artifacts.assets].sort((a, b) => a.name.localeCompare(b.name)),
  groups: artifacts.groups.map(group => ({ name: group.name, assets: [...group.assets].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  exclusions: artifacts.exclusions,
}));

export function readStage(directory, label) {
  const root = path.join(directory, label);
  const record = readJson(path.join(root, "measurement.json"));
  const artifacts = readArtifacts(root);
  const source = readFileSync(path.join(root, "source-before-or-after.tsx"), "utf8");
  assert.equal(record.evidenceVersion, 2, "A fresh version-2 proof is required");
  assert.equal(record.label, label, "Proof stage label mismatch");
  assert.equal(record.fingerprint, artifacts.fingerprint, "Proof artifacts changed");
  assert.equal(record.sourceSha256, digest(source), "Proof source changed");
  assert.equal(record.patchSha256, digest(record.patch), "Proof patch changed");
  assert.equal(record.build.ready, true, "Proof build was not ready");
  assert.equal(record.build.productionArtifacts, true, "Proof was not a production artifact build");
  assert.equal(record.build.commit, record.commit, "Proof build revision mismatch");
  assert.match(record.commit, /^[a-f0-9]{40}$/i, "Proof requires an exact build revision");
  const browserArtifacts = readArtifacts(root, { includeExcluded: true });
  const browser = readJson(path.join(root, "browser-evidence.json"));
  const scenarios = verifyBrowserEvidence(browser, { label, commit: record.commit, artifacts: browserArtifacts });
  return { root, record, artifacts, browserArtifacts, browser, scenarios, source: normalized(source) };
}

export function compareScenarios(baseline, candidate) {
  return baseline.map(before => {
    const after = candidate.find(scenario => scenario.name === before.name);
    assert.ok(after, `Missing scenario ${before.name}`);
    for (const field of ["requests", "brotliBytes", "identityBytes", "repeatedBrotliBytes"]) {
      assert.ok(after[field] <= before[field], `Scenario ${field} increased: ${before.name}`);
    }
    if (before.name === primaryScenario) {
      assert.ok(after.brotliBytes < before.brotliBytes, "No payload improvement in the claimed browser scenario");
    }
    return { name: before.name, baseline: before, candidate: after };
  });
}

export function readControlledProof(directory) {
  const before = readStage(directory, "baseline");
  const after = readStage(directory, "candidate");
  const control = readStage(directory, "reverted-control");
  assert.equal(before.record.patch, "", "Baseline must be unmodified");
  assert.equal(control.record.patch, "", "Reversal must restore unmodified source");
  assert.equal(before.record.commit, after.record.commit, "Different A/B revisions");
  assert.equal(before.record.commit, control.record.commit, "Different reversal revision");
  assert.equal(before.artifacts.fingerprint, control.artifacts.fingerprint, "Reversal did not reproduce the baseline");
  assert.equal(before.browserArtifacts.fingerprint, control.browserArtifacts.fingerprint, "Reversal locale artifacts differ");
  assert.equal(after.browser.browserVersion, before.browser.browserVersion, "Browser version changed between stages");
  assert.equal(control.browser.browserVersion, before.browser.browserVersion, "Reversal used a different browser");
  for (const scenario of before.scenarios) {
    const reverted = control.scenarios.find(item => item.name === scenario.name);
    for (const field of ["requests", "brotliBytes", "identityBytes", "repeatedBrotliBytes"]) {
      assert.equal(reverted[field], scenario[field], `Browser reversal differs: ${scenario.name}/${field}`);
    }
  }
  assert.equal(before.source, control.source, "Reversal source differs");
  const sourcePath = before.record.sourcePath;
  assert.match(sourcePath, /^apps[\\/]new-office[\\/]src[\\/]routes[\\/][^\\/]+\.tsx$/);
  assert.equal(after.record.sourcePath, sourcePath);
  assert.equal(control.record.sourcePath, sourcePath);
  const exports = [...before.source.matchAll(/^export function ([A-Z]\w*)\(/gm)];
  const removed = exports.filter(match =>
    before.source.replace(`export function ${match[1]}(`, `function ${match[1]}(`) === after.source);
  assert.equal(removed.length, 1, "Proof must change only one renderer export");
  const binding = removed[0][1];
  const gitPath = sourcePath.replaceAll("\\", "/");
  assert.equal((after.record.patch.match(/^diff --git /gm) ?? []).length, 1, "Proof changed other source files");
  assert.ok(after.record.patch.includes(`diff --git a/${gitPath} b/${gitPath}`), "Proof patch targets another file");
  const rootBefore = before.artifacts.groups.find(group => group.name === "route:__root__");
  const rootAfter = after.artifacts.groups.find(group => group.name === "route:__root__");
  assert.ok(rootBefore.brotliBytes !== null && rootAfter.brotliBytes !== null);
  assert.ok(rootAfter.brotliBytes < rootBefore.brotliBytes, "No initial payload reduction");
  assert.ok(after.artifacts.totals.brotliBytes !== null && before.artifacts.totals.brotliBytes !== null);
  assert.ok(after.artifacts.totals.brotliBytes <= before.artifacts.totals.brotliBytes, "Total bundle payload increased");
  assert.deepEqual(after.artifacts.groups.map(group => group.name).sort(), before.artifacts.groups.map(group => group.name).sort());
  assert.equal(after.artifacts.assets.length, before.artifacts.assets.length, "Artifact count changed");
  const scenarios = compareScenarios(before.scenarios, after.scenarios);
  return { before, after, control, binding, sourcePath, rootBefore, rootAfter, scenarios };
}

export function verifyBundleProof(directory, current) {
  const record = readJson(path.join(directory, "baseline", "measurement.json"));
  if (record.evidenceVersion !== 2) return { stale: "Legacy browser proof requires fresh scenario-bound version-2 captures; no task can be released" };
  const { before, after, control, binding, sourcePath, rootBefore, rootAfter, scenarios } = readControlledProof(directory);
  const currentSourcePath = path.join(current.build.repoRoot, ...sourcePath.split(/[\\/]/));
  if (!existsSync(currentSourcePath)) return { stale: "The measured route source no longer exists" };
  const currentSource = normalized(readFileSync(currentSourcePath, "utf8"));
  if (currentSource === after.source) return { stale: "The measured export removal is already present" };
  if (currentSource !== before.source) return { stale: "The route source no longer matches the measured issue" };
  if (footprint(current) !== footprint(before.artifacts)) {
    return { stale: "Client asset contents or route groups changed; repeat the controlled experiment" };
  }
  if (footprint(readArtifacts(current.build.repoRoot, { includeExcluded: true })) !== footprint(before.browserArtifacts)) {
    return { stale: "Browser artifacts including locale variants changed; repeat the controlled experiment" };
  }
  return { issue: {
    id: `unused-route-export-${binding}`, status: "validated_bundle_issue",
    title: `Keep ${binding} inside its existing lazy route`,
    sourcePath, binding,
    action: `Remove the unused export modifier from ${binding}; keep the function and existing route split unchanged.`,
    initialBrotliBytes: { before: rootBefore.brotliBytes, after: rootAfter.brotliBytes,
      reduction: rootBefore.brotliBytes - rootAfter.brotliBytes },
    totalBrotliBytes: { before: before.artifacts.totals.brotliBytes, after: after.artifacts.totals.brotliBytes },
    scenarios,
    evidence: { directory, measuredCommit: before.record.commit, observedCommit: current.build.commit,
      version: 2, policyHash: browserPolicyHash(), primaryScenario,
      baselineFingerprint: before.artifacts.fingerprint, candidateFingerprint: after.artifacts.fingerprint,
      reversalFingerprint: control.artifacts.fingerprint, currentClientArtifactsMatchBaseline: true },
    acceptance: [
      "Preserve rendering and suggestion-to-composer interaction in the production browser workflows.",
      "Retain all route groups without increasing any declared scenario's asset-request count or payload.",
      "Reproduce a strict payload reduction in the claimed cold notebooks-home scenario.",
    ],
    limitations: "JS/CSS production artifact bodies with the build's locale exclusions, and local browser request sets; not a CDN-transfer or latency improvement claim.",
  } };
}

export function readBundleProofs(runtimeDirectory, current) {
  const directory = path.join(runtimeDirectory, "bundle-proofs");
  if (!existsSync(directory)) return { issues: [], stale: [] };
  const issues = [], stale = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const result = verifyBundleProof(path.join(directory, entry.name), current);
    if (result.issue) issues.push(result.issue);
    else stale.push({ proof: entry.name, reason: result.stale });
  }
  return { issues, stale };
}
