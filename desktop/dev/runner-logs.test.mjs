import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("configured runners reuse agent navigation and run history with read-only live logs", { timeout: 90000 }, async t => {
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
  let server, browser;
  t.after(async () => { await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); });
  server = await createServer({ root: resolve(import.meta.dirname, ".."), spoolDataDirectory: root,
    server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`, base = `${origin}/api/projects/fixture/runners`;
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
  await appendFile(join(runtime, "runner.log"), "new stdout line\n");
  await expect(main.getByLabel("Runner logs", { exact: true })).toContainText("new stdout line", { timeout: 10000 });
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
  runner.phase = "scanning";
  await expect(history.getByText("Running", { exact: true })).toBeVisible({ timeout: 10000 });
  runner.running = false; runner.connected = false; runner.phase = "stopped";
  await expect(navigation.getByLabel("Runners: 1 active session", { exact: true })).toHaveCount(0, { timeout: 10000 });
  await expect(navigation.getByLabel("livesite: 1 active session", { exact: true })).toHaveCount(0);
  runner.running = true; runner.connected = true; runner.phase = "ready";
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
});
