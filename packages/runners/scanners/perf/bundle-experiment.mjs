import path from "node:path";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse } from "acorn";
import { acquireProcessLock, readRunnerJson, writeRunnerJson } from "../../packages/bohemia-agent-tooling/src/index.js";
import { canonicalPath, samePath } from "../../bridge/spool-store.mjs";
import { assertRevision } from "./build.mjs";
import { appPath, digest, measurementVersion, readArtifacts } from "./artifacts.mjs";

export async function captureBundleSnapshot({ repoRoot, receiptPath, outputDirectory }) {
  const source = canonicalPath(repoRoot);
  const target = existsSync(outputDirectory) ? canonicalPath(outputDirectory) :
    path.join(canonicalPath(path.dirname(outputDirectory)), path.basename(outputDirectory)).toLowerCase();
  if (target === source || target.startsWith(`${source}${path.sep}`)) {
    throw new Error("The experiment snapshot must be outside the shared checkout");
  }
  const release = await acquireProcessLock(`workspace:${source}`, { namespace: "spool-runner" });
  try {
    const build = readRunnerJson(receiptPath);
    if (build?.measurementVersion !== measurementVersion || !samePath(build.repoRoot, repoRoot)) {
      throw new Error("Snapshot requires the production build receipt for this checkout");
    }
    assertRevision(build);
    const artifacts = readArtifacts(repoRoot);
    if (artifacts.fingerprint !== build.artifactFingerprint) throw new Error("Production artifact fingerprint mismatch");
    mkdirSync(outputDirectory);
    const relativeAnalysis = path.join(appPath, "bundleAnalysis", "client");
    const relativeClient = path.join(appPath, "dist", "client");
    const copy = relative => {
      const destination = path.join(outputDirectory, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(path.join(repoRoot, relative), destination);
    };
    for (const name of ["bundleStats.json", "bundleBuddyConfig.json", "report.html"]) {
      copy(path.join(relativeAnalysis, name));
    }
    for (const asset of artifacts.assets) {
      copy(path.join(relativeClient, asset.name));
      if (asset.brotliBytes !== null) {
        copy(path.join(relativeClient, path.dirname(asset.name), `br.${path.basename(asset.name)}`));
      }
    }
    assertRevision(build);
    if (readArtifacts(outputDirectory).fingerprint !== artifacts.fingerprint) {
      throw new Error("Copied artifacts do not match the production build");
    }
    writeRunnerJson(path.join(outputDirectory, "snapshot.json"), {
      capturedAt: new Date().toISOString(), measurementVersion, build,
      artifactFingerprint: artifacts.fingerprint,
      reportSha256: digest(readFileSync(path.join(outputDirectory, relativeAnalysis, "report.html"))),
    });
  } finally {
    await release();
  }
}

export function extractRspackModules(source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const exports = new Map();
  for (const node of ast.body) {
    if (node.type !== "ExportNamedDeclaration" || node.declaration?.type !== "VariableDeclaration") continue;
    for (const declaration of node.declaration.declarations) {
      if (declaration.id.type === "Identifier") exports.set(declaration.id.name, declaration.init);
    }
  }
  const table = exports.get("__webpack_modules__");
  if (!table) return { supported: false, reason: "No exported Rspack ESM module table", modules: [] };
  const chunkId = exports.get("__rspack_esm_id"), chunkIds = exports.get("__rspack_esm_ids");
  if (chunkId?.type !== "Literal" || chunkIds?.type !== "ArrayExpression" ||
      !chunkIds.elements.some(node => node?.type === "Literal" && node.value === chunkId.value) ||
      table.type !== "ObjectExpression") {
    throw new Error("Invalid Rspack ESM chunk metadata/module table");
  }
  const ids = new Set();
  const modules = table.properties.map(property => {
    if (property.type !== "Property" || property.computed || property.kind !== "init" ||
        !["FunctionExpression", "ArrowFunctionExpression"].includes(property.value.type)) {
      throw new Error("Unsupported Rspack module registration");
    }
    const id = String(property.key.type === "Identifier" ? property.key.name : property.key.value);
    if (ids.has(id)) throw new Error(`Duplicate module registration: ${id}`);
    ids.add(id);
    const startByte = Buffer.byteLength(source.slice(0, property.value.start));
    const body = Buffer.from(source.slice(property.value.start, property.value.end));
    return { id, startByte, endByte: startByte + body.length, bodyBytes: body.length, bodySha256: digest(body) };
  });
  return { supported: true, chunkId: String(chunkId.value), modules };
}

function readChart(html) {
  const marker = "window.chartData = ";
  const start = html.indexOf(marker);
  if (start < 0 || html.indexOf(marker, start + marker.length) >= 0) throw new Error("Ambiguous or missing analyzer chart");
  const end = html.indexOf(";\n", start);
  if (end < 0) throw new Error("Unterminated analyzer chart");
  const chart = JSON.parse(html.slice(start + marker.length, end));
  if (!Array.isArray(chart)) throw new Error("Invalid analyzer chart");
  return chart;
}

function moduleNames(asset) {
  const names = new Map();
  const visit = node => {
    if (node.id != null && typeof node.path === "string") {
      const id = String(node.id), name = path.posix.normalize(node.path).replace(/^(?:\.\.\/)+/, "");
      const values = names.get(id) ?? new Set();
      values.add(name);
      names.set(id, values);
    }
    for (const child of node.groups ?? []) visit(child);
  };
  visit(asset);
  return names;
}

export function analyzeBundleSnapshot(directory) {
  const snapshot = readRunnerJson(path.join(directory, "snapshot.json"));
  if (snapshot?.measurementVersion !== measurementVersion || !/^[a-f0-9]{40}$/i.test(snapshot.build?.commit ?? "")) {
    throw new Error("Invalid production snapshot provenance");
  }
  const artifacts = readArtifacts(directory);
  if (artifacts.fingerprint !== snapshot.artifactFingerprint ||
      artifacts.fingerprint !== snapshot.build.artifactFingerprint) throw new Error("Snapshot artifact fingerprint mismatch");
  const analysis = path.join(directory, appPath, "bundleAnalysis", "client");
  const html = readFileSync(path.join(analysis, "report.html"));
  if (digest(html) !== snapshot.reportSha256) throw new Error("Snapshot analyzer report hash mismatch");
  const chart = new Map();
  for (const asset of readChart(html.toString("utf8"))) {
    if (!asset.isAsset || typeof asset.label !== "string" || chart.has(asset.label)) throw new Error("Invalid analyzer asset");
    chart.set(asset.label, asset);
  }
  const stats = JSON.parse(readFileSync(path.join(analysis, "bundleStats.json"), "utf8"));
  const byModule = new Map(), unsupportedAssets = [], unattributedModules = [];
  let parsedAssets = 0, parsedModules = 0;
  for (const asset of artifacts.assets.filter(asset => /\.(?:js|mjs)$/.test(asset.name))) {
    const chartAsset = chart.get(asset.name);
    if (!chartAsset || chartAsset.parsedSize !== asset.identityBytes) {
      throw new Error(`Analyzer asset does not match the emitted file: ${asset.name}`);
    }
    const source = readFileSync(path.join(directory, appPath, "dist", "client", asset.name), "utf8");
    const parsed = extractRspackModules(source);
    if (!parsed.supported) {
      unsupportedAssets.push({ asset: asset.name, reason: parsed.reason });
      continue;
    }
    if (!stats.chunks.some(chunk => String(chunk.id) === parsed.chunkId && chunk.files.includes(asset.name))) {
      throw new Error(`Emitted chunk ID does not match build stats: ${asset.name}`);
    }
    parsedAssets++;
    parsedModules += parsed.modules.length;
    const names = moduleNames(chartAsset);
    for (const module of parsed.modules) {
      const identities = names.get(module.id);
      if (identities?.size !== 1) {
        unattributedModules.push({ asset: asset.name, moduleId: module.id, reason: "Missing or ambiguous source attribution" });
        continue;
      }
      const name = [...identities][0];
      const copies = byModule.get(module.id) ?? [];
      copies.push({ ...module, source: name, asset: asset.name, assetSha256: asset.sha256 });
      byModule.set(module.id, copies);
    }
  }
  const findings = [], attributionConflicts = [];
  for (const [moduleId, copies] of byModule) {
    if (copies.length < 2) continue;
    if (new Set(copies.map(copy => copy.source)).size !== 1) {
      attributionConflicts.push({ moduleId, copies });
      continue;
    }
    const identical = new Map();
    for (const copy of copies) {
      const group = identical.get(copy.bodySha256) ?? [];
      group.push(copy);
      identical.set(copy.bodySha256, group);
    }
    const identicalBodyGroups = [...identical.values()].filter(group => group.length > 1).map(group => ({
      bodySha256: group[0].bodySha256, bodyBytes: group[0].bodyBytes, assets: group.map(copy => copy.asset),
      repeatedIdentityBytes: (group.length - 1) * group[0].bodyBytes,
    }));
    findings.push({
      moduleId, source: copies[0].source,
      kind: identicalBodyGroups.length ? "byte_identical_module_copies" : "same_module_different_emitted_bodies",
      copies, identicalBodyGroups,
      repeatedIdentityBytes: identicalBodyGroups.reduce((sum, group) => sum + group.repeatedIdentityBytes, 0),
      coListedRouteGroups: artifacts.groups.filter(group =>
        copies.filter(copy => group.assets.includes(copy.asset)).length > 1).map(group => group.name),
      compressedSavings: null, runtimeImpact: null, fixValidated: false,
    });
  }
  findings.sort((a, b) => b.repeatedIdentityBytes - a.repeatedIdentityBytes || a.source.localeCompare(b.source));
  const rawCandidates = stats.loopCustomStats.moduleDuplication?.duplicateModules;
  if (rawCandidates != null && (!Array.isArray(rawCandidates) ||
      rawCandidates.some(candidate => typeof candidate.name !== "string"))) throw new Error("Invalid duplicate-module metadata");
  const candidateName = name => path.posix.normalize(name).replace(/^(?:\.\.\/)+/, "").replace(/ \(concatenated\)$/, "");
  const confirmedSources = new Set(findings.map(finding => candidateName(finding.source)));
  const unresolvedRawCandidates = rawCandidates?.filter(candidate => !confirmedSources.has(candidateName(candidate.name))) ?? null;
  return {
    version: 1, mode: "isolated-bundle-experiment", automaticDispatch: false,
    build: snapshot.build, artifactFingerprint: artifacts.fingerprint,
    detector: "rspack-esm-module-identity-v1",
    rawDuplicateCandidates: rawCandidates?.length ?? null,
    coverage: { parsedAssets, parsedModules, unsupportedAssets, unattributedModules, attributionConflicts, unresolvedRawCandidates },
    findings,
    limitations: [
      "Repeated identity bytes are exact uncompressed function-body bytes, not removable bytes or compressed savings.",
      "Identical wrapper bytes do not establish equivalent execution contexts or safe removal.",
      "Different emitted bodies may contain different used exports; they are not interchangeable copies.",
      "Route-group co-listing does not establish that a browser downloads both files.",
      "Only exported Rspack ESM module tables are analyzed; unsupported entry bundles are explicitly reported.",
      "Import reasons and a behavior-preserving comparative rebuild are still required before prescribing a fix.",
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = new Map(), allowed = new Set(["--snapshot", "--repo-root", "--receipt"]);
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index], value = process.argv[index + 1];
      if (!allowed.has(key) || args.has(key) || !value || value.startsWith("--")) throw new Error(`Invalid argument: ${key}`);
      args.set(key, path.resolve(value));
    }
    if (!args.has("--snapshot")) throw new Error("Use --snapshot <isolated-directory>");
    if (args.has("--repo-root") !== args.has("--receipt")) throw new Error("Capture requires both --repo-root and --receipt");
    if (args.has("--repo-root")) {
      await captureBundleSnapshot({
        repoRoot: args.get("--repo-root"), receiptPath: args.get("--receipt"), outputDirectory: args.get("--snapshot"),
      });
    }
    process.stdout.write(`${JSON.stringify(analyzeBundleSnapshot(args.get("--snapshot")), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
