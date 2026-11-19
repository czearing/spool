import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";

for (const navigateWhileDeleting of [false, true])
test(navigateWhileDeleting ? "agent deletion respects navigation while the request is pending" :
  "busy agents delete immediately from the UI without changing queued, active or historical jobs", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-busy-agent-delete-"));
  const project = { id: "fixture", name: "Fixture", root: join(root, "project") };
  let server, browser, releaseDelete = () => {};
  t.after(async () => { releaseDelete(); await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [project] }));
  for (const directory of ["agents", "controls", ...["incoming", "in_progress", "completed", "failed"].map(queue => join("queues", queue))])
    await mkdir(join(project.root, directory), { recursive: true });
  for (const agent of ["engineer", "reviewer"])
    await writeFile(join(project.root, "agents", `${agent}.md`), "# Fixture; never run a model.");
  const jobs = ["incoming", "in_progress", "completed", "failed"].map(queue => ({
    file: join(project.root, "queues", queue, `${queue}.json`),
    content: JSON.stringify({ id: queue, title: `${queue} work`, agent: "engineer", prompt: "Fixture",
      status: queue, updated_at: "2026-11-04T00:00:00Z" }),
  }));
  for (const job of jobs) await writeFile(job.file, job.content);
  server = await startProductionApp(root);
  const origin = server.url;
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.goto(`${origin}/#/fixture/agents/${navigateWhileDeleting ? "reviewer" : "engineer"}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /^Agents/ }).click();
  const agentLink = page.locator('a[href="#/fixture/agents/engineer"]');
  await expect(agentLink).toBeVisible();
  if (navigateWhileDeleting) {
    await agentLink.click();
    await expect(page.getByRole("heading", { name: "engineer", exact: true })).toBeVisible();
  }
  const endpoint = `${origin}/api/projects/fixture/agents/engineer`;
  assert.equal((await page.request.delete(endpoint, { headers: { Origin: "https://foreign.invalid" } })).status(), 403);
  await page.getByRole("button", { name: "Agent actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete agent", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete agent?", exact: true });
  await expect(dialog).toContainText("immediately removes");
  await expect(dialog).not.toContainText("cannot be deleted");
  const deleted = page.waitForResponse(response => response.url() === endpoint && response.request().method() === "DELETE");
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const pending = new Promise(resolve => { releaseDelete = resolve; });
  if (navigateWhileDeleting) await page.route(endpoint, async route => {
    if (route.request().method() === "DELETE") { requestStarted(); await pending; }
    await route.continue();
  });
  await dialog.getByRole("button", { name: "Delete agent", exact: true }).click();
  if (navigateWhileDeleting) {
    await started;
    await page.goBack();
    await expect(page).toHaveURL(`${origin}/#/fixture/agents/reviewer`);
    releaseDelete();
  }
  assert.equal((await deleted).status(), 204);
  await expect(page).toHaveURL(`${origin}/#/fixture${navigateWhileDeleting ? "/agents/reviewer" : ""}`);
  await expect(agentLink).toHaveCount(0);
  assert.deepEqual(await readdir(join(project.root, "agents")), ["reviewer.md"]);
  for (const job of jobs) assert.equal(await readFile(job.file, "utf8"), job.content);
  await page.reload();
  assert.equal((await page.request.get(endpoint)).status(), 404);
  await expect(agentLink).toHaveCount(0);
});

test("navigation preserves unsaved prompts and flushes saved edits before leaving", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-navigation-guard-")), project = join(root, "project");
  let app, browser;
  t.after(async () => { await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "fixture", name: "Fixture", root: project }] }));
  for (const directory of ["agents", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, directory), { recursive: true });
  for (const agent of ["engineer", "reviewer"])
    await writeFile(join(project, "agents", `${agent}.md`), "Original fixture instructions.");
  app = await startProductionApp(root);
  browser = await chromium.launch();
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/api/projects/fixture/agents/engineer", async route => {
    if (route.request().method() === "PUT") await route.fulfill({ status: 503, json: { error: "Fixture save unavailable." } });
    else await route.continue();
  });
  await page.goto(`${app.url}/#/fixture/agents/engineer/prompt`, { waitUntil: "domcontentloaded" });
  const prompt = page.getByRole("textbox", { name: "engineer prompt", exact: true });
  await expect(prompt).toBeVisible();
  await prompt.fill("Preserve my unsaved instructions.");
  await expect(page.getByLabel("Prompt save status", { exact: true })).toContainText("Not saved");
  const nav = page.getByRole("navigation", { name: "Project navigation", exact: true });
  await nav.getByRole("button", { name: "Agents", exact: true }).click();
  const reviewer = nav.getByRole("link", { name: "reviewer", exact: true });
  await reviewer.click();
  const warning = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
  await expect(warning).toBeVisible();
  await warning.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(prompt).toHaveText("Preserve my unsaved instructions.");
  await expect(page).toHaveURL(`${app.url}/#/fixture/agents/engineer/prompt`);
  await reviewer.click();
  await warning.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL(`${app.url}/#/fixture/agents/reviewer`);
  assert.equal(await readFile(join(project, "agents", "engineer.md"), "utf8"), "Original fixture instructions.");
  await page.getByRole("button", { name: "Agent actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit prompt", exact: true }).click();
  const saved = page.getByRole("textbox", { name: "reviewer prompt", exact: true });
  await expect(saved).toBeVisible();
  await saved.fill("Saved before leaving.");
  await nav.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page).toHaveURL(`${app.url}/#/fixture`);
  await expect(warning).toHaveCount(0);
  assert.equal(await readFile(join(project, "agents", "reviewer.md"), "utf8"), "Saved before leaving.");
  assert.deepEqual(errors, []);
});
