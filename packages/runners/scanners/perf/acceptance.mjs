import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpoolStore, readJson, samePath, writeJson } from "../../bridge/spool-store.mjs";
import { digest, readArtifacts } from "./artifacts.mjs";
import { browserPolicyHash, primaryScenario, verifyBrowserEvidence } from "./browser-evidence.mjs";
import { compareScenarios, footprint, readControlledProof } from "./bundle-proof.mjs";
import { benchmark, rootMetric, sourceState } from "./benchmark.mjs";
import { captureProductionBrowser } from "./browser-runner.mjs";

export function bundleContract(issue) {
  assert.equal(issue.evidence.version, 2);
  return {
    kind: "bundle-v2", version: 2, item: issue.id, proofDirectory: issue.evidence.directory,
    policyHash: issue.evidence.policyHash, baselineFingerprint: issue.evidence.baselineFingerprint,
    candidateFingerprint: issue.evidence.candidateFingerprint, primaryScenario,
    sourcePath: issue.sourcePath, baselineCommit: issue.evidence.observedCommit,
    rootMaxBytes: issue.initialBrotliBytes.after, totalMaxBytes: issue.totalBrotliBytes.before,
    verifier: fileURLToPath(new URL("./verify-task.mjs", import.meta.url)),
  };
}

function loadTask(root, id) {
  const store = new SpoolStore(root), task = store.task(id), metadata = store.metadata(id);
  assert.ok(task, "Bundle task is missing");
  assert.equal(task.acceptance?.kind, "bundle-v2", "Task has no bundle acceptance contract");
  assert.deepEqual(metadata?.acceptance, task.acceptance, "Runner contract is missing or changed");
  const registry = readJson(path.join(store.records, "bundle-contracts", `${id}.json`));
  assert.ok(registry && registry.taskId === id && registry.agent === task.agent &&
    samePath(registry.workspace, task.workspace), "Bundle ownership registry is missing or inconsistent");
  assert.deepEqual(registry.acceptance, task.acceptance);
  assert.equal(registry.branch, metadata.preparation.branch);
  assert.ok(task.session_id, "Bundle task must retain its actual execution session");
  const contract = task.acceptance;
  assert.equal(contract.version, 2);
  assert.equal(contract.policyHash, browserPolicyHash(), "Bundle evidence policy changed; a fresh approved experiment is required");
  assert.ok(samePath(contract.verifier, fileURLToPath(new URL("./verify-task.mjs", import.meta.url))), "Wrong acceptance verifier");
  const state = sourceState(task.workspace);
  const dirt = execFileSync("git", ["status", "--porcelain"], {
    cwd: task.workspace, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(dirt.trim(), "", "Bundle acceptance requires a clean committed checkout");
  assert.equal(state.branch, registry.branch, "Task branch changed");
  const proof = readControlledProof(contract.proofDirectory);
  assert.equal(proof.before.artifacts.fingerprint, contract.baselineFingerprint);
  assert.equal(proof.after.artifacts.fingerprint, contract.candidateFingerprint);
  assert.equal(proof.sourcePath, contract.sourcePath);
  assert.equal(contract.item, `unused-route-export-${proof.binding}`);
  assert.match(contract.baselineCommit, /^[a-f0-9]{40}$/i);
  execFileSync("git", ["merge-base", "--is-ancestor", contract.baselineCommit, state.commit], {
    cwd: task.workspace, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 60000,
  });
  assert.equal(proof.rootAfter.brotliBytes, contract.rootMaxBytes);
  assert.equal(proof.before.artifacts.totals.brotliBytes, contract.totalMaxBytes);
  assert.equal(contract.primaryScenario, primaryScenario);
  return { store, task, metadata, registry, contract, state, proof, contractHash: digest(JSON.stringify(contract)) };
}

function candidateArtifacts(context) {
  const { task, contract, proof } = context;
  const source = readFileSync(path.join(task.workspace, ...contract.sourcePath.split(/[\\/]/)), "utf8").replaceAll("\r\n", "\n");
  assert.equal(source, proof.after.source, "Task change no longer matches the approved source experiment");
  const artifacts = readArtifacts(task.workspace);
  assert.equal(footprint(artifacts), footprint(proof.after.artifacts), "Current artifacts differ from the approved candidate");
  const all = readArtifacts(task.workspace, { includeExcluded: true });
  assert.equal(footprint(all), footprint(proof.after.browserArtifacts), "Browser/locale artifacts differ from the approved candidate");
  const value = artifacts.groups.find(group => group.name === "route:__root__").brotliBytes;
  assert.ok(value <= contract.rootMaxBytes && artifacts.totals.brotliBytes <= contract.totalMaxBytes);
  return { artifacts, all, value };
}

function resultPath(context) {
  return path.join(context.store.records, "bundle-evidence", context.task.id, `${context.state.commit}.json`);
}

function validateCapture(context, evidence, measured) {
  assert.equal(evidence.version, 2);
  assert.equal(evidence.taskId, context.task.id);
  assert.equal(evidence.sessionId, context.task.session_id);
  assert.equal(evidence.contractHash, context.contractHash, "Acceptance belongs to another task contract");
  assert.deepEqual(evidence.source, context.state, "Acceptance is stale for the current checkout");
  assert.equal(evidence.artifactFingerprint, measured.artifacts.fingerprint, "Acceptance assets changed");
  const scenarios = verifyBrowserEvidence(evidence.browser, {
    label: "acceptance", commit: context.state.commit, artifacts: measured.all,
  });
  compareScenarios(context.proof.before.scenarios, scenarios);
  assert.equal(evidence.browser.browserVersion, context.proof.before.browser.browserVersion,
    "Browser version differs from the approved experiment");
  return scenarios;
}

export async function recordBundleAcceptance({ root, taskId, headCommit, call, capture = captureProductionBrowser }) {
  const context = loadTask(root, taskId);
  if (headCommit !== undefined) assert.equal(context.state.commit, headCommit, "Publication revision changed");
  const file = resultPath(context);
  if (existsSync(file)) {
    const evidence = readJson(file);
    validateCapture(context, evidence, candidateArtifacts(context));
    return verifyBundleAcceptance({ root, taskId, headCommit });
  }
  const measurement = await benchmark({ repoRoot: context.task.workspace, call });
  assert.equal(measurement.commit, context.state.commit);
  const measured = candidateArtifacts(context);
  const browser = await capture({ repoRoot: context.task.workspace, label: "acceptance", commit: context.state.commit });
  assert.deepEqual(sourceState(context.task.workspace), context.state, "Source changed during independent acceptance");
  const evidence = { version: 2, taskId, sessionId: context.task.session_id, contractHash: context.contractHash,
    source: context.state, artifactFingerprint: measured.artifacts.fingerprint, browser, capturedAt: new Date().toISOString() };
  validateCapture(context, evidence, candidateArtifacts(context));
  writeJson(file, evidence);
  return verifyBundleAcceptance({ root, taskId, headCommit });
}

export function verifyBundleAcceptance({ root, taskId, headCommit, requirePublication = false }) {
  const context = loadTask(root, taskId);
  if (headCommit !== undefined) assert.equal(context.state.commit, headCommit, "Publication revision changed");
  const measured = candidateArtifacts(context), file = resultPath(context), evidence = readJson(file);
  assert.ok(evidence, "Independent bundle acceptance is missing; publish through the checked publisher to run it");
  const scenarios = validateCapture(context, evidence, measured);
  const evidenceHash = digest(readFileSync(file));
  let publication = null;
  if (requirePublication) {
    publication = readJson(path.join(context.store.records, "bundle-publications", `${taskId}.json`));
    const creator = readJson(path.join(context.store.records, "native-creators", `${taskId}.json`));
    assert.ok(publication && creator?.verified === true, "Verified bundle publication is missing");
    assert.equal(publication.taskId, taskId);
    assert.equal(publication.sessionId, context.task.session_id);
    assert.equal(publication.commit, context.state.commit, "Published bundle result is stale");
    assert.equal(publication.evidenceHash, evidenceHash, "Published browser evidence changed");
    assert.equal(publication.contractHash, context.contractHash);
    assert.equal(publication.prId, creator.prId);
    assert.equal(publication.originId, creator.originId);
    assert.equal(publication.branch, context.state.branch);
    assert.equal(creator.branch, context.state.branch);
    assert.equal(creator.taskId, taskId);
    assert.equal(creator.sessionId, context.task.session_id);
    assert.equal(creator.agent, context.task.agent);
    assert.ok(samePath(creator.workspace, context.task.workspace));
  }
  assert.deepEqual(sourceState(context.task.workspace), context.state, "Source changed during verification");
  return { version: 2, status: "verified", taskId, sessionId: context.task.session_id,
    contractHash: context.contractHash, evidenceHash, commit: context.state.commit, branch: context.state.branch,
    metric: rootMetric, value: measured.value, scenarios, prId: publication?.prId ?? null };
}

export function recordBundlePublication({ root, taskId, headCommit, pr }) {
  const result = verifyBundleAcceptance({ root, taskId, headCommit });
  const store = new SpoolStore(root), creator = readJson(path.join(store.records, "native-creators", `${taskId}.json`));
  assert.ok(creator?.verified && creator.originId && creator.taskId === taskId, "Original publication receipt missing");
  assert.equal(creator.sessionId, result.sessionId);
  assert.equal(String(pr.pullRequestId), creator.prId);
  assert.equal(pr.sourceRefName, `refs/heads/${result.branch}`);
  assert.equal(pr.lastMergeSourceCommit?.commitId, headCommit, "Remote PR changed before bundle delivery verification");
  assert.ok(pr.description?.startsWith(`<!-- bohemia-origin:${creator.originId} -->`));
  writeJson(path.join(store.records, "bundle-publications", `${taskId}.json`),
    { ...result, prId: creator.prId, originId: creator.originId, verifiedAt: new Date().toISOString() });
  return verifyBundleAcceptance({ root, taskId, headCommit, requirePublication: true });
}
