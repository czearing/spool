import assert from "node:assert/strict";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProductionApp } from "./production-app.mjs";

test("configured runners reuse agent navigation and run history with read-only live logs", { timeout: 180000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-runner-logs-")), project = join(root, "fixture");
  const automation = join(project, ".runner", "automation"), runtime = join(automation, "runners", "livesite", ".runner");
  const executions = join(runtime, "executions"), run = "12345678-1234-1234-1234-123456789abc";
  for (const folder of ["agents", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, folder), { recursive: true });
  await mkdir(executions, { recursive: true });
  await writeFile(join(project, "agents", "engineer.md"), "# Engineer\nFixture instructions.\n");
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1,
    projects: [{ id: "fixture", name: "Fixture", root: project }] }));
  await writeFile(join(automation, "spool-runners.json"), JSON.stringify({ spool_dir: project,
    livesite: { enabled: false }, pr_updater: { enabled: false } }));
  await writeFile(join(runtime, "runner.log"), "actual stdout from fixture\n");
  await writeFile(join(runtime, "runner-error.log"), "actual stderr from fixture\n");
  const summary = { id: run, source: "integration", status: "failed", createdAt: "2026-10-21T19:20:00Z" };
  await writeFile(join(executions, `${run}.summary.json`), JSON.stringify(summary));
  await writeFile(join(executions, `${run}.json`), JSON.stringify({ ...summary, error: "Checkout is occupied.",
    steps: [{ id: "prepare", label: "Prepare checkout", status: "failed", error: "Checkout is occupied." }] }));
  for (let index = 0; index < 399; index++) {
    const id = `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`;
    await writeFile(join(executions, `${id}.summary.json`), JSON.stringify({ ...summary, id, status: "succeeded",
      createdAt: new Date(Date.UTC(2026, 9, 20, 0, index)).toISOString() }));
  }
  let server, browser;
  t.after(async () => { await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); });
  server = await startProductionApp(root, [{
    name: "runner-performance-counters", enforce: "pre",
    transform(code, id) {
      id = id.replaceAll("\\", "/");
      let needle, measurement;
      if (id.endsWith("/src/components/runner-overview.tsx")) {
        needle = "  const { scrollRef,"; measurement = "if (globalThis.__runnerPerf) globalThis.__runnerPerf.overviews++;";
      } else if (id.endsWith("/src/components/ui/sidebar.tsx")) {
        needle = "...props }: ItemProps) {";
        measurement = 'if (props["data-work-item-id"] && globalThis.__runnerPerf) globalThis.__runnerPerf.history++;';
      } else return;
      assert.ok(code.includes(needle), `Instrumentation no longer matches ${id}`);
      return { code: code.replace(needle, needle.endsWith("{") ? `${needle}\n${measurement}` : `${measurement}\n${needle}`), map: null };
    },
  }]);
  const origin = server.url, base = `${origin}/api/projects/fixture/runners`;
  const pageData = path => fetch(`${origin}/api/desktop/page?path=${encodeURIComponent(path)}`).then(response => response.json());
  const dashboard = await pageData("/fixture");
  assert.deepEqual(dashboard.runners.runners.map(row => row.id), ["pr-updater", "livesite"]);
  assert.equal((await pageData("/fixture/runners/livesite")).page.kind, "runner");
  assert.equal((await pageData("/fixture/runners")).redirect, "/fixture/runners/pr-updater");
  assert.equal((await fetch(`${base}/livesite/output?run=${run}`)).status, 200);
  assert.equal((await fetch(`${base}/livesite/output?run=../private`)).status, 400);
  assert.equal((await fetch(`${base}/unknown/output`)).status, 404);
  assert.equal((await fetch(`${base}/livesite/output`, { method: "POST", headers: { Origin: origin } })).status, 405);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(), errors = [], mutations = [];
  await page.addInitScript(() => {
    globalThis.__runnerPerf = { overviews: 0, history: 0, formats: 0, longTasks: [] };
    const original = Date.prototype.toLocaleString;
    Date.prototype.toLocaleString = function (...args) {
      globalThis.__runnerPerf.formats++;
      return original.apply(this, args);
    };
    const format = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format");
    Object.defineProperty(Intl.DateTimeFormat.prototype, "format", { configurable: true, get() {
      const bound = format.get.call(this);
      return (...args) => { globalThis.__runnerPerf.formats++; return bound(...args); };
    } });
    new PerformanceObserver(list => globalThis.__runnerPerf.longTasks.push(...list.getEntries().map(entry => entry.duration)))
      .observe({ type: "longtask", buffered: true });
  });
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.url().includes("/runners") && request.method() !== "GET") mutations.push(request.method());
  });
  let unavailable = false;
  const runner = { id: "livesite", enabled: true, connected: true, running: true, healthy: true, stopping: false,
    phase: "ready", lastRunAt: null, lastSuccessAt: null, lastRunFailed: false, script: "runners\\livesite\\run.mjs",
    intervalSeconds: 300, activeIntervalSeconds: 300, error: null,
    repository: { mode: "on-demand", state: "unknown", lastUpdatedAt: null, lastAttemptAt: null, error: null } };
  await page.route("**/api/projects/fixture/runners", route => {
    if (route.request().headers().accept?.includes("text/event-stream")) return route.continue();
    return route.fulfill({ status: unavailable ? 503 : 200, json: unavailable ? { error: "Unavailable" } :
      { checkedAt: new Date().toISOString(), configured: true, runners: [runner] } });
  });
  await page.goto(`${origin}/#/fixture`);
  const navigation = page.getByRole("navigation", { name: "Project navigation", exact: true });
  await expect(navigation.getByRole("link", { name: "Runners", exact: true })).toHaveCount(0);
  const sections = await navigation.getByRole("button", { expanded: false }).allTextContents();
  assert.ok(sections.findIndex(label => label.startsWith("Runners")) < sections.findIndex(label => label.startsWith("Agents")));
  await navigation.getByRole("button", { name: /^Runners/ }).click();
  await expect(navigation.getByRole("link", { name: "pr-updater", exact: true })).toBeVisible();
  await navigation.getByRole("link", { name: /^livesite\b/ }).click();
  const main = page.getByRole("main"), history = main.getByRole("navigation", { name: "Runs", exact: true });
  await expect(main.getByRole("heading", { name: "livesite", exact: true })).toBeVisible();
  await expect(history).toContainText("Idle");
  await expect(history).toContainText("Failed");
  await expect(main.getByLabel("Runner logs", { exact: true })).toContainText("actual stdout from fixture");
  await expect(main.getByLabel("Runner logs", { exact: true })).toContainText("actual stderr from fixture");
  await expect(navigation.getByLabel("Runners: 1 active session", { exact: true })).toBeVisible();
  await expect(navigation.getByLabel("livesite: 1 active session", { exact: true })).toBeVisible();
  await expect(navigation.getByLabel("pr-updater: 1 active session", { exact: true })).toHaveCount(0);
  await expect(main.getByRole("button", { name: /Save|Run now|Add runner|New chat/i })).toHaveCount(0);
  await expect(main.locator("textarea, [contenteditable=true], .react-flow")).toHaveCount(0);
  await expect(history.getByRole("link")).toHaveCount(401);
  const timestamp = await page.evaluate(() => new Date("2026-10-21T19:20:00Z").toLocaleString());
  await expect(history.locator(`[data-work-item-id="${run}"]`)).toHaveAttribute("aria-label", timestamp);
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const reset = () => page.evaluate(() => Object.assign(globalThis.__runnerPerf, { overviews: 0, history: 0, formats: 0, longTasks: [] }));
  const sample = () => page.evaluate(() => {
    const data = globalThis.__runnerPerf;
    return { overviews: data.overviews, history: data.history, formats: data.formats,
      longTasks: data.longTasks.length, maxLongTask: Math.max(0, ...data.longTasks) };
  });
  await settle();
  await reset();
  for (let index = 0; index < 2; index++)
    await page.waitForResponse(response => response.url() === base && response.request().headers().accept !== "text/event-stream");
  await settle();
  const idle = await sample();
  await reset();
  for (let index = 0; index < 3; index++) {
    await appendFile(join(runtime, "runner.log"), `new stdout line ${index}\n`);
    await expect(main.getByLabel("Runner logs", { exact: true })).toContainText(`new stdout line ${index}`, { timeout: 10000 });
  }
  await settle();
  const streaming = await sample();
  const added = "aaaaaaaa-0000-0000-0000-000000000000", addedFile = join(executions, `${added}.summary.json`);
  const addedRun = { ...summary, id: added, status: "queued", createdAt: "2026-11-04T10:00:00Z" };
  await writeFile(addedFile, JSON.stringify(addedRun));
  const newHistory = history.locator(`[data-work-item-id="${added}"]`);
  await expect(newHistory).toContainText("Queued", { timeout: 10000 });
  await expect(history.getByRole("link")).toHaveCount(402);
  await writeFile(addedFile, JSON.stringify({ ...addedRun, status: "succeeded", finishedAt: "2026-11-04T10:01:00Z" }));
  await expect(newHistory).toContainText("Succeeded", { timeout: 10000 });
  await writeFile(join(runtime, "runner.log"), "rotated stdout\n");
  await expect(main.getByLabel("Runner logs", { exact: true })).toContainText("rotated stdout", { timeout: 10000 });
  await expect(main.getByLabel("Runner logs", { exact: true })).not.toContainText("new stdout line");
  await history.locator(`[data-work-item-id="${run}"]`).click();
  await expect(main.getByLabel("Run output", { exact: true })).toContainText("[Prepare checkout] failed");
  await expect(main.getByLabel("Run output", { exact: true })).toContainText("Checkout is occupied.");
  await expect(main.getByLabel("Run output", { exact: true })).not.toContainText("rotated stdout");
  await page.reload();
  await expect(main.getByLabel("Run output", { exact: true })).toContainText("Checkout is occupied.");
  await page.goBack();
  await expect(main.getByLabel("Runner logs", { exact: true })).toContainText("rotated stdout");
  await reset();
  runner.phase = "scanning";
  await expect(history.getByText("Running", { exact: true })).toBeVisible({ timeout: 10000 });
  await settle();
  const statusChanged = await sample();
  runner.running = false; runner.connected = false; runner.healthy = false; runner.phase = "stopped";
  await expect(navigation.getByLabel("Runners: 1 active session", { exact: true })).toHaveCount(0, { timeout: 10000 });
  await expect(navigation.getByLabel("livesite: 1 active session", { exact: true })).toHaveCount(0);
  await expect(history.getByText("Stopped", { exact: true })).toBeVisible();
  runner.running = true; runner.connected = true; runner.healthy = true; runner.phase = "ready";
  await expect(navigation.getByLabel("Runners: 1 active session", { exact: true })).toBeVisible({ timeout: 10000 });
  unavailable = true;
  await expect(main.getByRole("alert")).toContainText("Runner status is unavailable.", { timeout: 10000 });
  await expect(history.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(navigation.getByLabel("Runners: 1 active session", { exact: true })).toHaveCount(0);
  unavailable = false;
  await expect(main.getByLabel("Runner logs", { exact: true })).toContainText("rotated stdout", { timeout: 10000 });
  const accessibility = await new AxeBuilder({ page }).include("main").analyze();
  assert.deepEqual(accessibility.violations.map(item => item.id), []);
  await page.setViewportSize({ width: 390, height: 844 });
  await main.getByRole("button", { name: "Open runs", exact: true }).click();
  const popup = page.getByRole("dialog");
  await expect(popup.getByRole("navigation", { name: "Runs", exact: true })).toBeVisible();
  await popup.locator(`[data-work-item-id="${run}"]`).click();
  await expect(main.getByLabel("Run output", { exact: true })).toContainText("Checkout is occupied.");
  await expect(popup).toHaveCount(0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/#/fixture/agents/engineer`);
  await expect(main.getByRole("heading", { name: "engineer", exact: true })).toBeVisible();
  await expect(main.getByRole("searchbox", { name: "Search conversations" })).toBeVisible();
  await expect(main.getByRole("button", { name: "New chat", exact: true })).toBeVisible();
  assert.deepEqual(mutations, []);
  assert.deepEqual(errors, []);
  const metrics = { count: 400, cpuThrottle: 4, idle, streaming, statusChanged };
  console.log(JSON.stringify(metrics));
  if (process.env.SPOOL_RUNNER_PERF_REPORT) await writeFile(process.env.SPOOL_RUNNER_PERF_REPORT, JSON.stringify(metrics, null, 2));
  assert.equal(idle.overviews, 0, "Unchanged runner status checks must not rerender the log view.");
  assert.equal(idle.formats, 0, "Unchanged status checks must not reformat run-history timestamps.");
  assert.equal(streaming.formats, 0, "Live output must not reformat historical run timestamps.");
  assert.equal(streaming.history, 0, "Live output must not rerender unchanged run-history rows.");
  assert.equal(statusChanged.formats, 0, "Runner activity changes must not reformat historical run timestamps.");
  assert.equal(statusChanged.history, 1, "Runner activity changes must only rerender the live-history row.");
});
