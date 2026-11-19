import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startProductionApp } from "./production-app.mjs";

test("deletes the active project from settings with confirmation, recovery, and safe navigation", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-project-delete-"));
  const projects = ["alpha", "beta"].map(id => ({ id, name: id === "alpha" ? "Alpha" : "Beta", root: join(root, id) }));
  let server, browser;
  t.after(async () => {
    await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects }));
  for (const project of projects) {
    for (const directory of ["agents", "controls", "logs", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
      await mkdir(join(project.root, directory), { recursive: true });
    await writeFile(join(project.root, "logs", "keep.txt"), "Project files are preserved");
  }
  server = await startProductionApp(root);
  const origin = server.url;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  await page.route("**/api/models", route => route.fulfill({ json: [{ value: "gpt-5.4", label: "GPT-5.4" }] }));
  await page.goto(`${origin}/#/beta`);
  await page.getByRole("button", { name: "Switch project, Beta", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Alpha", exact: true }).click();
  await expect(page.getByRole("button", { name: "Switch project, Alpha", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const remove = settings.getByRole("button", { name: "Delete active project", exact: true });
  await remove.click();
  const confirmation = page.getByRole("dialog", { name: "Delete active project?", exact: true });
  await expect(confirmation).toContainText('Remove "Alpha" from Spool?');
  await expect(confirmation).toContainText("Running agents are not stopped.");
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(remove).toBeFocused();
  assert.equal(JSON.parse(await readFile(join(root, "projects.json"), "utf8")).projects.length, 2);
  await remove.click();
  assert.deepEqual((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations, []);
  let attempts = 0;
  await page.route("**/api/projects/alpha", route => {
    assert.equal(route.request().method(), "DELETE");
    return ++attempts === 1
      ? route.fulfill({ status: 409, json: { error: "Project settings are being updated by another process. Try again." } })
      : route.continue();
  });
  await confirmation.getByRole("button", { name: "Delete project", exact: true }).click();
  await expect(confirmation.getByRole("alert")).toHaveText("Project settings are being updated by another process. Try again.");
  await expect(page).toHaveURL(`${origin}/#/alpha`);
  await confirmation.getByRole("button", { name: "Delete project", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/#/beta`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Switch project, Beta", exact: true }).click();
  await expect(page.getByRole("menuitemradio", { name: "Alpha", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  assert.deepEqual(JSON.parse(await readFile(join(root, "projects.json"), "utf8")).projects, [projects[1]]);
  assert.equal(await readFile(join(projects[0].root, "logs", "keep.txt"), "utf8"), "Project files are preserved");
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await remove.click();
  await expect(confirmation).toContainText('Remove "Beta" from Spool?');
  await confirmation.getByRole("button", { name: "Delete project", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/#/`);
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.getByText("Add a project to get started.", { exact: true })).toBeVisible();
  assert.deepEqual(JSON.parse(await readFile(join(root, "projects.json"), "utf8")).projects, []);
  assert.equal(await readFile(join(projects[1].root, "logs", "keep.txt"), "utf8"), "Project files are preserved");
});
