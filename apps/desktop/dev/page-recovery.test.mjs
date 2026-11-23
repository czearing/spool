import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";

test("page and history recover temporary failures without a manual retry or losing the composer", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-page-recovery-"));
  const project = { id: "fixture", name: "Fixture", root: join(root, "project") };
  let server, browser, releaseHistory, metadataReads = 0, historyReads = 0;
  t.after(async () => { releaseHistory?.(); await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [project] }));
  for (const directory of ["agents", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project.root, directory), { recursive: true });
  await writeFile(join(project.root, "agents", "perf.md"), "# Fixture; never run a model.");
  await writeFile(join(project.root, "queues", "completed", "one.json"), JSON.stringify({
    id: "one", title: "Saved perf conversation", agent: "perf", updated_at: "2026-11-23T00:00:00Z",
  }));
  server = await startProductionApp(root);
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/api/desktop/page?*", async route => {
    if (++metadataReads === 1) await route.fulfill({ status: 503, body: "Temporary backend restart" });
    else await route.continue();
  });
  const historyReady = new Promise(resolve => { releaseHistory = resolve; });
  await page.route("**/api/projects/fixture/agents/perf/jobs?*", async route => {
    if (++historyReads === 1) await route.fulfill({ status: 503, json: { error: "History temporarily unavailable." } });
    else { await historyReady; await route.continue(); }
  });
  await page.goto(`${server.url}/#/fixture/agents/perf`, { waitUntil: "domcontentloaded" });
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  await expect(editor).toBeVisible();
  await editor.fill("Keep this unsent draft through recovery");
  await editor.evaluate(element => { window.savedComposer = element; });
  await expect.poll(() => historyReads).toBe(2);
  releaseHistory();
  await expect(page.getByRole("link", { name: "Saved perf conversation", exact: true })).toBeVisible();
  assert.equal(metadataReads, 2);
  assert.equal(historyReads, 2);
  assert.equal(await editor.evaluate(element => element === window.savedComposer), true);
  await expect(editor).toHaveText("Keep this unsent draft through recovery");
  await expect(page.getByRole("button", { name: /^Retry/ })).toHaveCount(0);
  await expect(page.getByText("Request aborted", { exact: true })).toHaveCount(0);
});
