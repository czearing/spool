import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync } from "node:zlib";
import { chromium } from "playwright";
import { artifactFixture, emitArtifacts } from "./fixtures.js";
import { captureBrowserEvidence } from "../capture-browser.mjs";
import { readArtifacts } from "../artifacts.mjs";
import { verifyBrowserEvidence, workflows } from "../browser-evidence.mjs";

test("real browser captures worker imports/fetches, warm bodies and same-document navigation", { timeout: 150000 }, async t => {
  const f = artifactFixture(t), target = workflows[1].route;
  const main = `
const target=${JSON.stringify(target)};
function render() {
  document.body.innerHTML=location.pathname==='/notebooks'
    ? '<a href="'+target+'">My Notebook</a>'
    : '<button aria-label="Notebooks home">Home</button><button aria-label="Collapse sidebar" onclick="this.remove()">Collapse</button><button aria-label="Close Quick Create" onclick="this.remove()">Close</button><button id="suggest">Audit Revenue Cutoff &amp; Bill-and-Hold</button><div role="textbox" aria-label="Message Copilot" contenteditable="true"></div>';
  const link=document.querySelector('a');
  if(link) link.onclick=e=>{e.preventDefault();history.pushState(null,'',target);render();};
  const home=document.querySelector('[aria-label]');
  if(home) home.onclick=()=>{history.pushState(null,'','/notebooks');render();};
  const suggest=document.querySelector('#suggest');
  if(suggest) suggest.onclick=()=>{const edit=document.querySelector('[contenteditable]');edit.textContent='Request the outstanding bill-and-hold acknowledgments';edit.focus();};
}
render(); new Worker('/assets/js/worker.js');
`;
  const emitted = emitArtifacts(f, main);
  for (const [name, text] of [
    ["assets/js/worker.js", "importScripts('/assets/js/worker-import.js'); fetch('/assets/js/worker-fetch.js').then(r=>r.text()).then(text=>postMessage(text));"],
    ["assets/js/worker-import.js", "self.workerImported = true;"],
    ["assets/js/worker-fetch.js", "self.workerFetched = true;"],
  ]) {
    const file = path.join(emitted.root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    writeFileSync(path.join(path.dirname(file), `br.${path.basename(file)}`), brotliCompressSync(Buffer.from(text)));
    emitted.stats.assets.push({ name, size: Buffer.byteLength(text) });
  }
  writeFileSync(path.join(emitted.analysis, "bundleStats.json"), JSON.stringify(emitted.stats));
  const assets = new Map(readArtifacts(f.repoRoot, { includeExcluded: true }).assets.map(asset => [
    `/${asset.name}`, readFileSync(path.join(emitted.root, asset.name)),
  ]));
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (assets.has(pathname)) {
      response.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=3600" });
      response.end(assets.get(pathname));
    } else {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<!doctype html><html lang="en"><body><script src="/assets/js/index.abc.js"></script></body></html>');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
    const report = await captureBrowserEvidence({ browser, baseURL: `http://127.0.0.1:${server.address().port}`,
      repoRoot: f.repoRoot, label: "baseline", commit: f.scan.commit });
    verifyBrowserEvidence(report, { label: "baseline", commit: f.scan.commit,
      artifacts: readArtifacts(f.repoRoot, { includeExcluded: true }) });
    for (const scenario of report.cases.filter(item => item.mode === "cold")) {
      for (const name of ["assets/js/worker.js", "assets/js/worker-import.js", "assets/js/worker-fetch.js"]) {
        assert.ok(scenario.assets.includes(name), `${scenario.id} omitted ${name}`);
      }
      assert.ok(scenario.workers.some(url => url.endsWith("/assets/js/worker.js")));
    }
    assert.ok(report.cases.filter(item => item.mode === "navigation").every(item => item.sameDocumentNavigation));
    assert.ok(report.cases.filter(item => item.mode === "warm").every(item =>
      item.waterfall.some(row => row.cache === "hit")), "Warm capture must demonstrate cached bodies");
    for (const scenario of report.cases.filter(item => item.unavailableEncodedBodyCount > 0)) {
      assert.equal(scenario.observedEncodedBodyBytes, null, "Unavailable browser cache sizes are not zero-byte transfers");
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
