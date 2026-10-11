import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { brotliCompressSync } from "node:zlib";
import path from "node:path";
import { fixture } from "../../../bridge/test/fixtures.mjs";
import { appPath, digest, readArtifacts } from "../artifacts.mjs";
import { browserCases, browserEvidenceVersion, browserPolicyHash, observationWindowMs } from "../browser-evidence.mjs";

export function browserEvidenceFixture(artifacts, commit, label) {
  const waterfall = artifacts.assets.map(asset => ({
    url: `http://127.0.0.1:12345/${asset.name}`, asset: asset.name, status: 200,
    startTime: 0, responseEnd: 1, bodySha256: asset.sha256, decodedBodyBytes: asset.identityBytes,
    encodedBodyBytes: asset.brotliBytes, rawResponseBodyBytes: asset.brotliBytes,
    encodedBodyUnavailable: null, responseHeadersBytes: 100,
    fromServiceWorker: false, cache: "network", resourceType: asset.name.endsWith(".css") ? "stylesheet" : "script",
  }));
  return {
    version: browserEvidenceVersion, policyHash: browserPolicyHash(), label, buildCommit: commit,
    artifactFingerprint: artifacts.fingerprint, browserVersion: "fixture-browser",
    delivery: "local-production", deploymentProfile: "automation", dataSource: "mock",
    pageErrors: [], requestErrors: [],
    cases: browserCases.map(scenario => ({
      ...scenario, assertions: scenario.assertions.map(id => ({ id, status: "passed" })),
      observationWindowMs, observedLocale: scenario.locale, documentLanguage: "en-US",
      sameDocumentNavigation: scenario.mode === "navigation",
      setupWaterfall: scenario.mode === "cold" ? [] : structuredClone(waterfall), waterfall: structuredClone(waterfall),
      assets: artifacts.assets.map(asset => asset.name), uniqueAssetRequests: artifacts.assets.length,
      assetRequestCount: waterfall.length, requestedArtifactBrotliBytes: artifacts.totals.brotliBytes,
      requestedIdentityBytes: artifacts.totals.identityBytes, repeatedArtifactBrotliBytes: artifacts.totals.brotliBytes,
      observedEncodedBodyBytes: artifacts.totals.brotliBytes, knownEncodedBodyBytes: artifacts.totals.brotliBytes,
      unavailableEncodedBodyCount: 0, pageErrors: [], requestErrors: [],
    })),
  };
}

export function artifactFixture(t) {
  const f = fixture(t), repoRoot = path.join(f.root, "scan"), app = path.join(repoRoot, appPath);
  mkdirSync(app, { recursive: true });
  const git = (...args) => execFileSync("git", args, {
    cwd: repoRoot, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "-q", "-b", "master");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  writeFileSync(path.join(repoRoot, ".gitignore"), "dist/\nbundleAnalysis/\n");
  writeFileSync(path.join(repoRoot, "source.txt"), "original source\n");
  git("add", "."); git("commit", "-qm", "fixture");
  const scan = { repoRoot, branch: "master", commit: git("rev-parse", "HEAD") };
  const runtimeDirectory = path.join(f.root, "perf", ".runner");
  const config = { repoRoot, agentId: "perf", runtimeDirectory, legacyBranchPrefixes: ["perf-"],
    todoPath: path.join(runtimeDirectory, "todo.md"), todoJsonPath: path.join(runtimeDirectory, "todo.json") };
  return { ...f, app, repoRoot, git, scan, config, calls: [] };
}

export function emitArtifacts(f, contents = "export const value = 'fixture';\n".repeat(100)) {
  const files = [
    ["assets/js/index.abc.js", contents],
    ["assets/js/route.def.js", "export const route = 'fixture';\n".repeat(75)],
    ["assets/css/index.abc.css", ".fixture { color: red; }\n".repeat(50)],
    ["assets/js/strings.fr-fr.abc.js", "export const strings = 'bonjour';\n".repeat(100)],
  ];
  const root = path.join(f.app, "dist", "client"), analysis = path.join(f.app, "bundleAnalysis", "client");
  mkdirSync(analysis, { recursive: true });
  for (const [name, text] of files) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    writeFileSync(path.join(path.dirname(file), `br.${path.basename(file)}`), brotliCompressSync(Buffer.from(text)));
  }
  const stats = {
    assets: files.map(([name, text]) => ({ name, size: Buffer.byteLength(text) })),
    modules: [{ size: 999999999 }],
    loopCustomStats: { assetGroups: [
      { name: "route:__root__", assets: [files[0][0], files[2][0], files[0][0]], metricDisplayName: "Root" },
      { name: "route:/page", assets: [files[1][0], files[2][0]], metricDisplayName: "Page" },
    ] },
  };
  writeFileSync(path.join(analysis, "bundleStats.json"), JSON.stringify(stats));
  writeFileSync(path.join(analysis, "bundleBuddyConfig.json"), JSON.stringify({
    chunksToAnalyze: [], chunksToExcludeFromTotal: ["strings\\.(?!en-us)"],
  }));
  return { root, analysis, stats, files };
}

export function buildCall(f, contents) {
  return async (tool, args) => {
    f.calls.push({ tool, args });
    if (tool === "bohemia_build") emitArtifacts(f, contents);
    return { ready: true, ...f.scan, productionArtifacts: tool === "bohemia_build" };
  };
}

export function proofFixture(t) {
  const f = artifactFixture(t);
  const directory = path.join(f.root, "proof");
  const sourcePath = path.join(appPath, "src", "routes", "page.tsx");
  const beforeSource = "export function PageContent(){return 'page';}\n";
  const afterSource = beforeSource.replace("export function", "function");
  emitArtifacts(f, "export const value = 'larger payload for the initial entry';\n".repeat(200));
  const beforeArtifacts = readArtifacts(f.repoRoot);
  const write = (file, data) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  };
  write(path.join(f.repoRoot, sourcePath), beforeSource);
  for (const label of ["baseline", "reverted-control", "candidate"]) {
    if (label === "candidate") emitArtifacts(f, "export const value=1;");
    const stage = path.join(directory, label);
    const artifacts = readArtifacts(f.repoRoot);
    const source = label === "candidate" ? afterSource : beforeSource;
    cpSync(path.join(f.repoRoot, appPath), path.join(stage, appPath), { recursive: true });
    write(path.join(stage, "source-before-or-after.tsx"), source);
    const patch = label === "candidate"
      ? `diff --git a/${sourcePath.replaceAll("\\", "/")} b/${sourcePath.replaceAll("\\", "/")}\n-export function PageContent\n+function PageContent`
      : "";
    write(path.join(stage, "measurement.json"), {
      evidenceVersion: 2, label, sourcePath, sourceSha256: digest(source), commit: f.scan.commit,
      fingerprint: artifacts.fingerprint,
      build: { ready: true, productionArtifacts: true, commit: f.scan.commit },
      patch, patchSha256: digest(patch),
    });
    write(path.join(stage, "browser-evidence.json"),
      browserEvidenceFixture(readArtifacts(stage, { includeExcluded: true }), f.scan.commit, label));
    if (label !== "reverted-control") {
      write(path.join(stage, "playwright-result.json"), {
        errors: [], stats: { expected: 2, unexpected: 0, flaky: 0, skipped: 0 },
      });
      for (const scenario of ["notebooks-home", "notebook-landing"]) {
        write(path.join(stage, `${scenario}-browser.json`), {
          scenario, buildCommit: f.scan.commit, artifactFingerprint: artifacts.fingerprint,
          pageErrors: [], requestErrors: [], observationWindowAfterReadyMs: 5_000,
          waterfall: artifacts.assets.map(asset => ({ asset: asset.name, status: 200, startTime: 0, responseEnd: 1 })),
          assets: artifacts.assets.map(asset => asset.name), uniqueAssetRequests: artifacts.assets.length,
          assetRequestCount: artifacts.assets.length,
          requestedIdentityBytes: artifacts.totals.identityBytes,
          requestedArtifactBrotliBytes: artifacts.totals.brotliBytes,
        });
      }
      cpSync(path.join(directory, "baseline", appPath), path.join(f.repoRoot, appPath), { recursive: true });
    }
  }
  const current = { ...beforeArtifacts, build: { ...f.scan } };
  const mutate = (label, file, transform) => {
    const target = path.join(directory, label, file);
    const data = JSON.parse(readFileSync(target, "utf8"));
    transform(data);
    writeFileSync(target, JSON.stringify(data));
  };
  return { ...f, directory, sourcePath, current, beforeSource, afterSource, mutate };
}
