import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { proofFixture } from "./fixtures.js";
import { appPath } from "../artifacts.mjs";
import { compareScenarios, readBundleProofs, verifyBundleProof } from "../bundle-proof.mjs";
import { createTodo, renderTodo } from "../report.mjs";
import { runScanner } from "../scanner.mjs";

test("a complete A/B/reversal proof produces a measured task, not an estimated saving", t => {
  const f = proofFixture(t);
  const result = verifyBundleProof(f.directory, f.current);
  assert.equal(result.issue.binding, "PageContent");
  assert.ok(result.issue.initialBrotliBytes.reduction > 0);
  assert.equal(result.issue.evidence.currentClientArtifactsMatchBaseline, true);
  const report = createTodo({ issues: [result.issue], stale: [] });
  assert.equal(report.status, "validated_bundle_issues");
  assert.match(renderTodo(report), /Restoring the export reproduced/);
  assert.equal(report.automaticDispatch, false);
});

test("different raw stats fingerprints alone do not invalidate identical measured client artifacts", t => {
  const f = proofFixture(t);
  const current = { ...f.current, fingerprint: "different-compilation-metadata" };
  assert.ok(verifyBundleProof(f.directory, current).issue);
});

test("changed current asset bytes or route source invalidate the task", t => {
  const f = proofFixture(t);
  const changed = structuredClone(f.current);
  changed.assets[0].sha256 = "another-build";
  assert.match(verifyBundleProof(f.directory, changed).stale, /asset contents/);
  writeFileSync(path.join(f.repoRoot, f.sourcePath), f.afterSource);
  assert.match(verifyBundleProof(f.directory, f.current).stale, /already present/);
});

for (const failure of ["failed-browser", "skipped-browser", "missing-waterfall", "incomplete-waterfall", "invented-bytes",
  "extra-request", "extra-raw-request", "different-revision", "unrestored-source", "wrong-route", "wrong-stage",
  "wrong-body", "missing-case", "stale-policy", "unnamed-tests", "missing-worker-body", "unknown-transfer-size",
  "wrong-locale", "wrong-navigation", "invented-cdn-claim"]) {
  test(`proof cannot promote a task: ${failure}`, t => {
    const f = proofFixture(t);
    f.mutate("candidate", "browser-evidence.json", report => {
      const data = report.cases[0];
      if (failure === "failed-browser") data.assertions[0].status = "failed";
      if (failure === "skipped-browser") data.assertions[0].status = "skipped";
      if (failure === "missing-waterfall") data.waterfall = [];
      if (failure === "incomplete-waterfall") { data.waterfall.pop(); data.assetRequestCount--; }
      if (failure === "invented-bytes") data.requestedArtifactBrotliBytes = 1;
      if (failure === "extra-request") data.uniqueAssetRequests++;
      if (failure === "extra-raw-request") { data.waterfall.push(data.waterfall[0]); data.assetRequestCount++; }
      if (failure === "wrong-route") data.route = "/another-page";
      if (failure === "wrong-stage") report.label = "baseline";
      if (failure === "wrong-body") data.waterfall[0].bodySha256 = "wrong-build";
      if (failure === "missing-case") report.cases.pop();
      if (failure === "stale-policy") report.policyHash = "stale";
      if (failure === "unnamed-tests") data.assertions = [];
      if (failure === "missing-worker-body") delete data.waterfall.at(-1).bodySha256;
      if (failure === "unknown-transfer-size") data.waterfall[0].encodedBodyBytes = null;
      if (failure === "wrong-locale") data.observedLocale = "unknown";
      if (failure === "wrong-navigation") report.cases.find(item => item.mode === "navigation").sameDocumentNavigation = false;
      if (failure === "invented-cdn-claim") report.delivery = "cdn";
    });
    if (failure === "different-revision") f.mutate("candidate", "measurement.json", data => {
      data.commit = "b".repeat(40); data.build.commit = data.commit;
    });
    if (failure === "unrestored-source") f.mutate("reverted-control", "measurement.json", data => { data.patch = "still modified"; });
    assert.throws(() => verifyBundleProof(f.directory, f.current));
  });
}

test("a legacy success summary cannot become a task and does not crash collection", t => {
  const f = proofFixture(t);
  f.mutate("baseline", "measurement.json", record => { delete record.evidenceVersion; });
  assert.match(verifyBundleProof(f.directory, f.current).stale, /version-2/);
});

test("no primary-scenario savings fails even when other scenarios improve", () => {
  const baseline = ["notebooks-home-cold", "notebook-landing-cold"].map(name => ({
    name, requests: 2, brotliBytes: 100, identityBytes: 200, repeatedBrotliBytes: 100,
  }));
  const candidate = structuredClone(baseline);
  candidate[1].brotliBytes = 80;
  assert.throws(() => compareScenarios(baseline, candidate), /claimed browser scenario/);
});

test("tampered source and artifact measurements fail independently of claimed approval flags", t => {
  const f = proofFixture(t);
  f.mutate("candidate", "measurement.json", data => {
    data.verified = true; data.approved = true; data.fingerprint = "fabricated";
  });
  assert.throws(() => verifyBundleProof(f.directory, f.current), /artifacts changed/);
});

test("proof discovery reports stale evidence explicitly and requires evidence files, not approval JSON", t => {
  const f = proofFixture(t), runtime = path.join(f.root, "runtime");
  assert.deepEqual(readBundleProofs(runtime, f.current), { issues: [], stale: [] });
  const destination = path.join(runtime, "bundle-proofs", "page");
  cpSync(f.directory, destination, { recursive: true });
  writeFileSync(path.join(f.repoRoot, f.sourcePath), f.afterSource);
  const result = readBundleProofs(runtime, f.current);
  assert.equal(result.issues.length, 0);
  assert.equal(result.stale.length, 1);
  assert.match(renderTodo(createTodo(result)), /Stale proof/);
  const fake = path.join(runtime, "bundle-proofs", "approval-only");
  mkdirSync(fake);
  writeFileSync(path.join(fake, "approved.json"), '{"verified":true,"savings":1000000}');
  assert.throws(() => readBundleProofs(runtime, f.current), /ENOENT/);
});

test("the scanner publishes the verified task and withdraws it when the source is fixed, without dispatch", async t => {
  const f = proofFixture(t);
  cpSync(path.join(f.directory, "baseline", appPath), path.join(f.repoRoot, appPath), { recursive: true });
  cpSync(f.directory, path.join(f.config.runtimeDirectory, "bundle-proofs", "page"), { recursive: true });
  f.git("add", "."); f.git("commit", "-qm", "route fixture");
  let scan = { ...f.scan, commit: f.git("rev-parse", "HEAD") };
  const call = async () => ({ ...scan, ready: true, productionArtifacts: true });
  const result = await runScanner({ config: f.config, scan, call });
  assert.equal(result.verifiedIssues, 1);
  assert.equal(result.dispatched, 0);
  assert.equal(JSON.parse(readFileSync(f.config.todoJsonPath, "utf8")).todos.length, 1);
  writeFileSync(path.join(f.repoRoot, f.sourcePath), f.afterSource);
  f.git("add", "."); f.git("commit", "-qm", "fix renderer export");
  scan = { ...scan, commit: f.git("rev-parse", "HEAD") };
  const fixed = await runScanner({ config: f.config, scan, call });
  assert.equal(fixed.verifiedIssues, 0);
  assert.equal(fixed.dispatched, 0);
  const todo = JSON.parse(readFileSync(f.config.todoJsonPath, "utf8"));
  assert.deepEqual(todo.todos, []);
  assert.equal(todo.staleProofs.length, 1);
});
