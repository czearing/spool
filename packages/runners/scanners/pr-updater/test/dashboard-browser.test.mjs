import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createDashboardHandler } from "../lib/dashboard-handler.mjs";

// Opt in with an existing Playwright module and browser; this test installs nothing.
test("browser refresh, lazy details, failures, recovery and history work without page reloads", {
  skip: !process.env.DASHBOARD_PLAYWRIGHT_MODULE || !process.env.DASHBOARD_BROWSER_EXECUTABLE,
  timeout: 60_000,
}, async (t) => {
  const root = path.resolve("test-runtime", `dashboard-browser-${randomUUID()}`);
  const runtime = path.join(root, "pr-updater", ".runner");
  fs.mkdirSync(runtime, { recursive: true });
  const previousEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TEMP = root;
  process.env.TMP = root;
  let context;
  let server;
  t.after(async () => {
    await context?.close();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { chromium } = await import(pathToFileURL(process.env.DASHBOARD_PLAYWRIGHT_MODULE).href);
  const statusFile = path.join(runtime, "status.json");
  const writeStatus = (title) => fs.writeFileSync(statusFile, JSON.stringify({
    lastScan: new Date().toISOString(), pullRequests: [{ id: "7", title, ready: false }],
  }));
  writeStatus("before refresh");
  const evidence = '<script>window.injected = true</script>\n' + "complete evidence ".repeat(500);
  const jobs = [
    { jobId: "old-active", prId: "active-without-watch", state: "dispatched", at: "2020-01-01T00:00:00Z" },
    ...Array.from({ length: 25 }, (_, index) => ({
      jobId: `job-${index}`, prId: `pr-${index}`, state: "failed", error: evidence,
      at: new Date(Date.UTC(2026, 8, 10, 0, index)).toISOString(),
    })),
  ];
  fs.writeFileSync(path.join(runtime, "jobs.jsonl"), jobs.map((job) => JSON.stringify(job)).join("\n"));
  fs.writeFileSync(path.join(runtime, "activity.jsonl"), "");
  let failSummary = false;
  let invalidSummary = false;
  let hangSummary = false;
  let failDetail = true;
  let metricReads = 0;
  const routes = [];
  const handler = createDashboardHandler(path.dirname(runtime), {
    metrics: async () => {
      metricReads++;
      return [];
    },
  });
  server = http.createServer((request, response) => {
    routes.push(request.url);
    if (hangSummary && request.url === "/summary.json") {
      return;
    } else if (invalidSummary && request.url === "/summary.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"summary":{}}');
    } else if ((failSummary && request.url === "/summary.json") ||
        (failDetail && request.url.startsWith("/job?"))) {
      response.writeHead(503);
      response.end("unavailable");
    } else handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(path.join(root, "browser-profile"), {
    executablePath: process.env.DASHBOARD_BROWSER_EXECUTABLE,
    headless: true,
    artifactsDir: path.join(root, "artifacts"),
    downloadsPath: path.join(root, "downloads"),
    tracesDir: path.join(root, "traces"),
    env: { ...process.env },
  });
  const external = [];
  await context.route("**/*", (route) => {
    if (route.request().url().startsWith(origin + "/")) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  const scriptErrors = [];
  page.on("pageerror", (error) => scriptErrors.push(error.message));
  await page.addInitScript(() => {
    const timeout = window.setTimeout;
    window.setTimeout = (callback, ms, ...args) => timeout(callback, ms === 30_000 ? 100 : ms, ...args);
    window.documentMarker = "same document";
    const abortTimeout = AbortSignal.timeout;
    AbortSignal.timeout = (ms) => abortTimeout(ms === 10000 ? 1000 : ms);
  });
  await page.goto(origin);
  assert.match(await page.locator("#live").innerText(), /before refresh/);
  assert.equal(await page.locator("#ado-usage, #ado-state").count(), 0);
  assert.doesNotMatch(await page.locator("body").innerText(), /Active jobs|ADO usage|active-without-watch/);
  assert.equal(await page.locator("pre.log").count(), 0, "logs are not embedded in the initial page");
  const details = page.locator("details[data-job-url]").first();
  await details.locator("summary").click();
  await page.waitForFunction(() => document.querySelector("[data-job-error]")?.textContent.includes("Details unavailable"));
  assert.equal(await details.getByRole("link", { name: "Open full timings, errors and transcript" }).count(), 1);
  failDetail = false;
  await details.locator("summary").click();
  await details.locator("summary").click();
  await page.waitForFunction(() => document.querySelector("details[data-job-url]")?.dataset.loaded === "done");
  assert.equal(await details.locator("pre.log").textContent(), evidence);
  assert.equal(await page.evaluate(() => window.injected), undefined, "transcript remains text");
  const detailRequests = () => routes.filter((route) => route.startsWith("/job?")).length;
  assert.equal(detailRequests(), 2);
  writeStatus("after refresh");
  await page.waitForFunction(() => document.querySelector("#live")?.textContent.includes("after refresh"));
  assert.equal(await page.evaluate(() => window.documentMarker), "same document");
  assert.equal(await details.getAttribute("open"), "");
  assert.equal(await details.locator("pre.log").textContent(), evidence);
  assert.equal(routes.filter((route) => route === "/").length, 1, "summary does not reload the document");
  await details.locator("summary").click();
  await details.locator("summary").click();
  assert.equal(detailRequests(), 2, "reopening loaded details does not refetch");
  failSummary = true;
  await page.waitForFunction(() => document.querySelector("#refresh-state")?.textContent.includes("failed"));
  assert.match(await page.locator("#live").innerText(), /after refresh/);
  assert.equal(await details.locator("pre.log").textContent(), evidence);
  failSummary = false;
  writeStatus("recovered refresh");
  await page.waitForFunction(() => document.querySelector("#live")?.textContent.includes("recovered refresh") &&
    !document.querySelector("#refresh-state")?.textContent);
  invalidSummary = true;
  await page.waitForFunction(() => document.querySelector("#refresh-state")?.textContent.includes("failed"));
  assert.match(await page.locator("#live").innerText(), /recovered refresh/);
  invalidSummary = false;
  await page.waitForFunction(() => !document.querySelector("#refresh-state")?.textContent);
  hangSummary = true;
  await page.waitForFunction(() => document.querySelector("#refresh-state")?.textContent.includes("failed"));
  assert.match(await page.locator("#live").innerText(), /recovered refresh/);
  hangSummary = false;
  await page.waitForFunction(() => !document.querySelector("#refresh-state")?.textContent);
  await page.getByRole("link", { name: "Older history" }).click();
  assert.equal(new URL(page.url()).pathname, "/history");
  assert.equal(await page.locator("details[data-job-url]").count(), 5);
  await page.locator("details[data-job-url]").first().locator("summary").click();
  await page.waitForFunction(() => document.querySelector("details[data-job-url]")?.dataset.loaded === "done");
  assert.equal(await page.locator("pre.log").textContent(), evidence);
  assert.deepEqual(scriptErrors, []);
  assert.equal(metricReads, 0, "normal page and history never fetch ADO metrics");
  assert.ok(!routes.some((route) => route.startsWith("/ado.json")));
  assert.deepEqual(external, [], "all browser dashboard requests stay on the local listener");
});
