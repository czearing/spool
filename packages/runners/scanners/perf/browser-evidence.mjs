import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { digest } from "./artifacts.mjs";

export const browserEvidenceVersion = 2;
export const observationWindowMs = 5000;
const notebook = Buffer.from(JSON.stringify({ w: { i: "my-notebook" } })).toString("base64url");
export const workflows = [
  { name: "notebooks-home", route: "/notebooks", assertions: ["route-ready", "notebook-card-visible"] },
  { name: "notebook-landing", route: `/notebook/${notebook}`, assertions: ["route-ready", "suggestion-focus"] },
];
export const browserCases = [
  ...["cold", "warm", "navigation"].flatMap(mode => workflows.map(workflow => ({
    ...workflow, id: `${workflow.name}-${mode}`, mode, locale: "en-US", viewport: { width: 1440, height: 1000 },
  }))),
  ...["mobile", "alternate-locale"].flatMap(profile => workflows.map(workflow => ({
    ...workflow, id: `${workflow.name}-${profile}`, mode: "cold",
    locale: profile === "alternate-locale" ? "fr-FR" : "en-US",
    viewport: profile === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    assertions: profile === "mobile" && workflow.name === "notebook-landing"
      ? ["route-ready", "mobile-panels-dismissed", "composer-input"] : workflow.assertions,
  }))),
];
export const primaryScenario = "notebooks-home-cold";

export function browserPolicyHash() {
  return digest(JSON.stringify({
    version: browserEvidenceVersion, cases: browserCases, observationWindowMs,
    verifier: digest(readFileSync(new URL("./browser-evidence.mjs", import.meta.url))),
    collector: digest(readFileSync(new URL("./capture-browser.mjs", import.meta.url))),
    runner: digest(readFileSync(new URL("./browser-runner.mjs", import.meta.url))),
  }));
}

const nonnegative = value => Number.isSafeInteger(value) && value >= 0;

export function verifyBrowserEvidence(report, { label, commit, artifacts }) {
  assert.equal(report.version, browserEvidenceVersion, "Browser evidence requires a fresh version-2 capture");
  assert.equal(report.policyHash, browserPolicyHash(), "Browser test policy changed; recapture evidence");
  assert.equal(report.label, label, "Browser stage mismatch");
  assert.equal(report.buildCommit, commit, "Browser build revision mismatch");
  assert.equal(report.artifactFingerprint, artifacts.fingerprint, "Browser artifact fingerprint mismatch");
  assert.equal(report.delivery, "local-production", "Unsupported delivery claim");
  assert.equal(report.deploymentProfile, "automation");
  assert.equal(report.dataSource, "mock");
  assert.ok(typeof report.browserVersion === "string" && report.browserVersion.length > 0);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.requestErrors, []);
  assert.equal(report.cases.length, browserCases.length, "Incomplete browser coverage");
  assert.equal(new Set(report.cases.map(item => item.id)).size, browserCases.length, "Duplicate browser scenario");
  const byName = new Map(artifacts.assets.map(asset => [asset.name, asset]));
  return browserCases.map(expected => {
    const observed = report.cases.find(item => item.id === expected.id);
    assert.ok(observed, `Missing browser scenario ${expected.id}`);
    for (const field of ["id", "name", "route", "mode", "locale", "viewport"]) {
      assert.deepEqual(observed[field], expected[field], `Browser scenario ${expected.id}: wrong ${field}`);
    }
    assert.equal(observed.observationWindowMs, observationWindowMs);
    assert.equal(observed.observedLocale, expected.locale);
    assert.ok(typeof observed.documentLanguage === "string", "Document language must be recorded");
    assert.deepEqual(observed.assertions, expected.assertions.map(id => ({ id, status: "passed" })),
      `Named behavior assertions missing or failed: ${expected.id}`);
    assert.deepEqual(observed.pageErrors, []);
    assert.deepEqual(observed.requestErrors, []);
    assert.ok(Array.isArray(observed.waterfall) && Array.isArray(observed.setupWaterfall));
    if (expected.mode !== "cold") assert.ok(observed.setupWaterfall.length > 0, "Missing warmup/navigation evidence");
    else assert.equal(observed.setupWaterfall.length, 0, "Cold scenario was warmed");
    if (expected.mode === "navigation") assert.equal(observed.sameDocumentNavigation, true);
    const measured = new Map();
    let repeatedBrotliBytes = 0, encodedBodyBytes = 0, unavailableEncodedBodyCount = 0;
    for (const [phase, rows] of [["setup", observed.setupWaterfall], ["measurement", observed.waterfall]]) {
      for (const request of rows) {
        const asset = byName.get(request.asset);
        assert.ok(asset && asset.brotliBytes !== null, `Unknown or uncompressed browser asset: ${request.asset}`);
        assert.equal(request.status, 200, "Unsuccessful browser asset");
        assert.equal(request.bodySha256, asset.sha256, "Browser received a different asset body");
        assert.equal(request.decodedBodyBytes, asset.identityBytes);
        assert.ok(Number.isSafeInteger(request.rawResponseBodyBytes), "Missing raw browser size");
        if (request.rawResponseBodyBytes < 0) {
          assert.equal(request.encodedBodyBytes, null, "Unavailable transfer must not be reported as zero");
          assert.equal(request.encodedBodyUnavailable, "browser-size-unavailable");
        } else {
          assert.ok(nonnegative(request.encodedBodyBytes), "Missing observed response size");
          assert.equal(request.encodedBodyBytes, request.rawResponseBodyBytes);
          assert.equal(request.encodedBodyUnavailable, null);
        }
        assert.ok(nonnegative(request.responseHeadersBytes), "Missing observed header size");
        assert.ok(Number.isFinite(request.startTime) && Number.isFinite(request.responseEnd) && request.responseEnd >= 0,
          "Missing request timing");
        assert.ok(["script", "stylesheet", "other", "fetch"].includes(request.resourceType));
        assert.equal(typeof request.fromServiceWorker, "boolean");
        assert.ok(["hit", "network", "unknown"].includes(request.cache));
        const url = new URL(request.url);
        assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Local evidence contains an unexpected asset origin");
        assert.equal(decodeURIComponent(url.pathname).replace(/^\//, ""), request.asset, "Asset URL/path mismatch");
        if (phase === "measurement") {
          measured.set(asset.name, asset);
          repeatedBrotliBytes += asset.brotliBytes;
          if (request.encodedBodyBytes === null) unavailableEncodedBodyCount++;
          else encodedBodyBytes += request.encodedBodyBytes;
        }
      }
    }
    if (expected.mode === "cold") {
      assert.ok([...measured.keys()].some(name => /^assets\/js\/index\./.test(name)), "Cold capture omitted the entry bundle");
    }
    const assets = [...measured.keys()].sort();
    const brotliBytes = [...measured.values()].reduce((sum, asset) => sum + asset.brotliBytes, 0);
    const identityBytes = [...measured.values()].reduce((sum, asset) => sum + asset.identityBytes, 0);
    assert.deepEqual(observed.assets, assets);
    assert.equal(observed.uniqueAssetRequests, assets.length);
    assert.equal(observed.assetRequestCount, observed.waterfall.length);
    assert.equal(observed.requestedArtifactBrotliBytes, brotliBytes);
    assert.equal(observed.requestedIdentityBytes, identityBytes);
    assert.equal(observed.repeatedArtifactBrotliBytes, repeatedBrotliBytes);
    assert.equal(observed.unavailableEncodedBodyCount, unavailableEncodedBodyCount);
    assert.equal(observed.knownEncodedBodyBytes, encodedBodyBytes);
    assert.equal(observed.observedEncodedBodyBytes, unavailableEncodedBodyCount ? null : encodedBodyBytes);
    return { name: expected.id, requests: observed.waterfall.length, uniqueAssets: assets.length,
      brotliBytes, identityBytes, repeatedBrotliBytes,
      observedEncodedBodyBytes: unavailableEncodedBodyCount ? null : encodedBodyBytes, unavailableEncodedBodyCount };
  });
}
