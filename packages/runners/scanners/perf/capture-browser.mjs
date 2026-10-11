import assert from "node:assert/strict";
import { digest, readArtifacts } from "./artifacts.mjs";
import { browserCases, browserEvidenceVersion, browserPolicyHash, observationWindowMs, workflows } from "./browser-evidence.mjs";

async function behavior(page, scenario) {
  assert.equal(new URL(page.url()).pathname.replace(/\/$/, ""), scenario.route);
  if (scenario.name === "notebooks-home") {
    await page.getByRole("link", { name: "My Notebook", exact: true }).waitFor({ state: "visible" });
  } else if (scenario.assertions.includes("composer-input")) {
    await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Close Quick Create", exact: true }).click();
    const composer = page.getByRole("textbox", { name: "Message Copilot", exact: true });
    await composer.fill("Bundle acceptance input");
    assert.equal(await composer.evaluate(element => element === document.activeElement && element.textContent === "Bundle acceptance input"), true);
  } else {
    const suggestion = page.getByRole("button", { name: "Audit Revenue Cutoff & Bill-and-Hold", exact: true });
    await suggestion.waitFor({ state: "visible" });
    await suggestion.click();
    await page.waitForFunction(() =>
      document.activeElement?.textContent?.includes("Request the outstanding bill-and-hold acknowledgments"));
  }
}

export async function captureBrowserEvidence({ browser, baseURL, repoRoot, label, commit }) {
  assert.ok(["baseline", "candidate", "reverted-control", "acceptance"].includes(label));
  const origin = new URL(baseURL);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "Capture requires an owned loopback production server");
  const artifacts = readArtifacts(repoRoot, { includeExcluded: true });
  const byName = new Map(artifacts.assets.map(asset => [asset.name, asset]));
  const policyHash = browserPolicyHash();
  const report = {
    version: browserEvidenceVersion, policyHash, label, buildCommit: commit, artifactFingerprint: artifacts.fingerprint,
    browserVersion: browser.version(), delivery: "local-production", deploymentProfile: "automation", dataSource: "mock",
    pageErrors: [], requestErrors: [], cases: [],
    limitations: "Automation/mock production workflows and declared browser locales only; document language is recorded separately. Artifact sidecar bodies are not observed CDN transfer or latency improvements. Unknown cache provenance stays unknown.",
  };
  for (const scenario of browserCases) {
    const context = await browser.newContext({ locale: scenario.locale, viewport: scenario.viewport, serviceWorkers: "allow" });
    context.setDefaultTimeout(30000);
    const page = await context.newPage();
    const pageErrors = [], requestErrors = [], pending = new Set(), requests = new Set(), captures = [], workers = [];
    let phase = scenario.mode === "cold" ? "measurement" : "setup", recording = true;
    const isAsset = url => /\/assets\/.*\.(?:js|mjs|css)(?:\?|$)/.test(url);
    context.on("weberror", error => pageErrors.push(error.error().message));
    page.on("worker", worker => workers.push(worker.url()));
    context.on("request", request => { if (recording && isAsset(request.url())) { pending.add(request); requests.add(request); } });
    context.on("requestfailed", request => {
      if (recording && isAsset(request.url())) { pending.delete(request); requestErrors.push(`${request.url()}: ${request.failure()?.errorText}`); }
    });
    context.on("requestfinished", request => pending.delete(request));
    context.on("response", response => {
      if (!recording || !isAsset(response.url())) return;
      const capturePhase = phase;
      const promise = (async () => {
        assert.equal(response.status(), 200, response.url());
        assert.equal(await response.finished(), null, response.url());
        const request = response.request(), assetName = decodeURIComponent(new URL(response.url()).pathname).replace(/^\//, "");
        const asset = byName.get(assetName);
        assert.ok(asset && asset.brotliBytes !== null, `Unexpected production asset ${assetName}`);
        const body = await response.body();
        assert.equal(digest(body), asset.sha256, `Browser received another build: ${assetName}`);
        const sizes = await request.sizes();
        return { phase: capturePhase, request, record: {
          url: response.url(), asset: assetName, status: response.status(), resourceType: request.resourceType(),
          bodySha256: digest(body), decodedBodyBytes: body.length,
          encodedBodyBytes: sizes.responseBodySize < 0 ? null : sizes.responseBodySize,
          rawResponseBodyBytes: sizes.responseBodySize,
          encodedBodyUnavailable: sizes.responseBodySize < 0 ? "browser-size-unavailable" : null,
          responseHeadersBytes: sizes.responseHeadersSize, fromServiceWorker: response.fromServiceWorker(),
          cache: "unknown", ...request.timing(),
        } };
      })();
      // Observe rejected captures immediately; Promise.all below still propagates the failure.
      promise.catch(error => requestErrors.push(error.message));
      captures.push(promise);
    });
    try {
      if (scenario.mode !== "cold") {
        const warmup = scenario.mode === "navigation" ? workflows.find(item => item.name !== scenario.name) : scenario;
        const response = await page.goto(new URL(warmup.route, baseURL).href, { waitUntil: "load" });
        assert.equal(response?.status(), 200);
        await behavior(page, warmup);
        await page.waitForTimeout(observationWindowMs);
        assert.equal(pending.size, 0, "Unfinished warmup asset requests; evidence incomplete");
        await Promise.all(captures);
        phase = "measurement";
      }
      let sameDocumentNavigation = false;
      if (scenario.mode === "navigation") {
        const token = `${scenario.id}-${Date.now()}`;
        await page.evaluate(value => { window.__spoolBundleNavigation = value; }, token);
        if (scenario.name === "notebooks-home") await page.getByRole("button", { name: "Notebooks home", exact: true }).click();
        else await page.getByRole("link", { name: "My Notebook", exact: true }).click();
        await page.waitForURL(url => url.pathname.replace(/\/$/, "") === scenario.route);
        sameDocumentNavigation = await page.evaluate(value => window.__spoolBundleNavigation === value, token);
        assert.equal(sameDocumentNavigation, true, "Navigation performed a document reload");
      } else {
        const response = await page.goto(new URL(scenario.route, baseURL).href, { waitUntil: "load" });
        assert.equal(response?.status(), 200);
      }
      await behavior(page, scenario);
      await page.waitForTimeout(observationWindowMs);
      assert.equal(pending.size, 0, "Unfinished asset requests at the observation boundary");
      recording = false;
      const observed = await Promise.all(captures);
      assert.equal(observed.length, requests.size, "Some asset requests were not captured");
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(requestErrors, []);
      const timing = await page.evaluate(() => performance.getEntriesByType("resource").map(entry => ({
        url: entry.name, transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize,
      })));
      for (const { record, phase: capturedPhase } of observed) {
        const entries = timing.filter(entry => entry.url === record.url && entry.encodedBodySize > 0);
        if (capturedPhase === "measurement" && entries.length === 1 &&
            observed.filter(item => item.phase === "measurement" && item.record.url === record.url).length === 1) {
          record.cache = entries[0].transferSize === 0 ? "hit" : "network";
        }
      }
      const waterfall = observed.filter(item => item.phase === "measurement").map(item => item.record);
      const assets = [...new Set(waterfall.map(item => item.asset))].sort();
      const unavailableEncodedBodyCount = waterfall.filter(item => item.encodedBodyBytes === null).length;
      const knownEncodedBodyBytes = waterfall.reduce((sum, item) => sum + (item.encodedBodyBytes ?? 0), 0);
      report.cases.push({
        ...scenario, assertions: scenario.assertions.map(id => ({ id, status: "passed" })),
        observedLocale: await page.evaluate(() => navigator.language),
        documentLanguage: await page.evaluate(() => document.documentElement.lang),
        observationWindowMs, sameDocumentNavigation, workers,
        setupWaterfall: observed.filter(item => item.phase === "setup").map(item => item.record),
        waterfall, assets, assetRequestCount: waterfall.length, uniqueAssetRequests: assets.length,
        requestedArtifactBrotliBytes: assets.reduce((sum, name) => sum + byName.get(name).brotliBytes, 0),
        requestedIdentityBytes: assets.reduce((sum, name) => sum + byName.get(name).identityBytes, 0),
        repeatedArtifactBrotliBytes: waterfall.reduce((sum, item) => sum + byName.get(item.asset).brotliBytes, 0),
        knownEncodedBodyBytes, unavailableEncodedBodyCount,
        observedEncodedBodyBytes: unavailableEncodedBodyCount ? null : knownEncodedBodyBytes,
        pageErrors, requestErrors,
      });
    } catch (error) {
      throw new Error(`Browser case ${label}/${scenario.id} failed: ${error.message}`, { cause: error });
    } finally { await context.close(); }
  }
  assert.equal(browserPolicyHash(), policyHash, "Browser policy changed during capture");
  assert.equal(readArtifacts(repoRoot, { includeExcluded: true }).fingerprint, artifacts.fingerprint,
    "Production assets changed during capture");
  return report;
}
