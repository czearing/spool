import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { brotliCompressSync } from "node:zlib";
import { acquireProcessLock } from "../../../packages/bohemia-agent-tooling/src/index.js";
import { canonicalPath } from "../../../bridge/spool-store.mjs";
import { artifactFixture, emitArtifacts } from "./fixtures.js";
import { appPath, digest, measurementVersion, readArtifacts } from "../artifacts.mjs";
import { analyzeBundleSnapshot, captureBundleSnapshot, extractRspackModules } from "../bundle-experiment.mjs";

const chunk = (id, table) => `export const __rspack_esm_id=${id};export const __rspack_esm_ids=[${id}];export const __webpack_modules__={${table}};`;
const body = "(e,t){t.value=1}";

function snapshotFixture(t, tables = [`42${body}`, `42${body}`]) {
  const f = artifactFixture(t), emitted = emitArtifacts(f);
  const names = [emitted.files[0][0], emitted.files[1][0]];
  const chart = names.map(name => ({ isAsset: true, label: name, groups: [{ id: 42, path: "./../packages/example/index.js" }] }));
  const codes = tables.map((table, index) => chunk(index + 1, table));
  emitted.stats.chunks = names.map((name, index) => ({ id: index + 1, files: [name] }));
  emitted.stats.loopCustomStats.moduleDuplication = {
    duplicateModules: [{ name: "../../packages/example/index.js", count: 2, size: 9999999 }],
  };
  const restamp = () => {
    names.forEach((name, index) => {
      const text = codes[index], file = path.join(emitted.root, name);
      writeFileSync(file, text);
      writeFileSync(path.join(path.dirname(file), `br.${path.basename(file)}`), brotliCompressSync(Buffer.from(text)));
      emitted.stats.assets.find(asset => asset.name === name).size = Buffer.byteLength(text);
      chart[index].parsedSize = Buffer.byteLength(text);
    });
    writeFileSync(path.join(emitted.analysis, "bundleStats.json"), JSON.stringify(emitted.stats));
    const html = `<script>window.chartData = ${JSON.stringify(chart)};\n</script>`;
    writeFileSync(path.join(emitted.analysis, "report.html"), html);
    const artifacts = readArtifacts(f.repoRoot);
    writeFileSync(path.join(f.repoRoot, "snapshot.json"), JSON.stringify({
      measurementVersion, artifactFingerprint: artifacts.fingerprint, reportSha256: digest(html),
      build: { ...f.scan, measurementVersion, artifactFingerprint: artifacts.fingerprint },
    }));
  };
  restamp();
  return { ...f, analysis: emitted.analysis, stats: emitted.stats, clientRoot: emitted.root, names, codes, chart, restamp };
}

test("extracts actual ESM module bodies and byte offsets, including non-ASCII prefixes", () => {
  const source = `/* \u00e9 */${chunk(1, `42${body},43:(e,t)=>{t.other=2}`)}`;
  const parsed = extractRspackModules(source);
  assert.equal(parsed.supported, true);
  assert.equal(parsed.chunkId, "1");
  assert.equal(parsed.modules.length, 2);
  assert.equal(parsed.modules[0].bodyBytes, Buffer.byteLength(body));
  for (const module of parsed.modules) {
    assert.equal(digest(Buffer.from(source).subarray(module.startByte, module.endByte)), module.bodySha256);
  }
});

test("ordinary object literals and strings are not treated as emitted module tables", () => {
  assert.equal(extractRspackModules(`const text='export const __webpack_modules__={42(e){}}'; const x={42(e){}};`).supported, false);
});

test("invalid metadata, computed registrations, duplicate IDs and invalid JS fail explicitly", () => {
  assert.throws(() => extractRspackModules("export const __webpack_modules__={42(e){}}"), /metadata/);
  assert.throws(() => extractRspackModules(chunk(1, "[42](e){}")), /registration/);
  assert.throws(() => extractRspackModules(chunk(1, "42(e){},42(e){}")), /Duplicate module/);
  assert.throws(() => extractRspackModules("export const = ;"), SyntaxError);
});

test("confirms identical emitted copies without inventing compressed savings, load timing or fixes", t => {
  const f = snapshotFixture(t);
  const report = analyzeBundleSnapshot(f.repoRoot);
  assert.equal(report.coverage.parsedAssets, 2);
  assert.equal(report.findings.length, 1);
  assert.deepEqual(report.coverage.unresolvedRawCandidates, []);
  const finding = report.findings[0];
  assert.equal(finding.kind, "byte_identical_module_copies");
  assert.equal(finding.repeatedIdentityBytes, Buffer.byteLength(body));
  assert.equal(finding.identicalBodyGroups[0].assets.length, 2);
  assert.deepEqual(finding.coListedRouteGroups, [], "Separate route groups do not establish co-loading");
  assert.equal(finding.compressedSavings, null);
  assert.equal(finding.runtimeImpact, null);
  assert.equal(finding.fixValidated, false);
  assert.equal(report.todos, undefined);
  assert.equal(report.automaticDispatch, false);
});

test("same module with different compiled exports is not byte-identical duplication", t => {
  const f = snapshotFixture(t, [`42${body}`, "42(e,t){t.other=2}"]);
  const finding = analyzeBundleSnapshot(f.repoRoot).findings[0];
  assert.equal(finding.kind, "same_module_different_emitted_bodies");
  assert.equal(finding.repeatedIdentityBytes, 0);
  assert.deepEqual(finding.identicalBodyGroups, []);
});

test("a single shared module and same-looking code with different module identities are not duplicates", t => {
  const f = snapshotFixture(t, [`42${body}`, `43${body}`]);
  f.chart[1].groups[0] = { id: 43, path: "./../packages/other/index.js" };
  f.restamp();
  assert.deepEqual(analyzeBundleSnapshot(f.repoRoot).findings, []);
});

test("missing attribution and conflicting module identities cannot create a confirmed finding", t => {
  const f = snapshotFixture(t);
  f.chart[1].groups = [];
  f.restamp();
  let report = analyzeBundleSnapshot(f.repoRoot);
  assert.equal(report.findings.length, 0);
  assert.equal(report.coverage.unattributedModules.length, 1);
  f.chart[1].groups = [{ id: 42, path: "./../packages/different/index.js" }];
  f.restamp();
  report = analyzeBundleSnapshot(f.repoRoot);
  assert.equal(report.findings.length, 0);
  assert.equal(report.coverage.attributionConflicts.length, 1);
});

test("unsupported entry format is reported as unmeasured rather than a clean bundle", t => {
  const f = snapshotFixture(t);
  f.codes[0] = "export const value = 1;";
  f.restamp();
  const report = analyzeBundleSnapshot(f.repoRoot);
  assert.equal(report.coverage.parsedAssets, 1);
  assert.equal(report.coverage.unsupportedAssets.length, 1);
  assert.equal(report.coverage.unresolvedRawCandidates.length, 1);
  assert.deepEqual(report.findings, []);
});

test("chunk IDs must match their emitted filenames in the build metadata", t => {
  const f = snapshotFixture(t);
  f.stats.chunks[1].id = 99;
  f.restamp();
  assert.throws(() => analyzeBundleSnapshot(f.repoRoot), /chunk ID does not match/);
});

test("changed artifacts or analyzer evidence fail provenance checks", t => {
  const f = snapshotFixture(t);
  const reportPath = path.join(f.analysis, "report.html");
  writeFileSync(reportPath, readFileSync(reportPath, "utf8") + "tampered");
  assert.throws(() => analyzeBundleSnapshot(f.repoRoot), /report hash mismatch/);
  f.restamp();
  writeFileSync(path.join(f.clientRoot, f.names[0]), "tampered");
  assert.throws(() => analyzeBundleSnapshot(f.repoRoot), /does not match/);
});

test("snapshot capture refuses shared-checkout destinations and competing scanner ownership", async t => {
  const f = artifactFixture(t);
  await assert.rejects(captureBundleSnapshot({
    repoRoot: f.repoRoot, receiptPath: "unused", outputDirectory: path.join(f.repoRoot, "experiment"),
  }), /outside the shared checkout/);
  const release = await acquireProcessLock(`workspace:${canonicalPath(f.repoRoot)}`, { namespace: "spool-runner" });
  try {
    await assert.rejects(captureBundleSnapshot({
      repoRoot: f.repoRoot, receiptPath: "unused", outputDirectory: path.join(f.root, "experiment"),
    }), { code: "EADDRINUSE" });
  } finally { await release(); }
});

test("snapshot capture is independent, reproducible and does not overwrite an existing directory", async t => {
  const f = artifactFixture(t), emitted = emitArtifacts(f), artifacts = readArtifacts(f.repoRoot);
  writeFileSync(path.join(emitted.analysis, "report.html"), "<script>window.chartData = [];\n</script>");
  const receiptPath = path.join(f.root, "build.json"), outputDirectory = path.join(f.root, "experiment");
  writeFileSync(receiptPath, JSON.stringify({
    ...f.scan, measurementVersion, artifactFingerprint: artifacts.fingerprint,
  }));
  await captureBundleSnapshot({ repoRoot: f.repoRoot, receiptPath, outputDirectory });
  assert.equal(readArtifacts(outputDirectory).fingerprint, artifacts.fingerprint);
  assert.ok(readFileSync(path.join(outputDirectory, appPath, "bundleAnalysis", "client", "report.html")).length);
  await assert.rejects(captureBundleSnapshot({ repoRoot: f.repoRoot, receiptPath, outputDirectory }), { code: "EEXIST" });
});
