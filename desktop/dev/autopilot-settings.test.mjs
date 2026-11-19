import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startProductionApp } from "./production-app.mjs";

test("Autopilot settings save and restore independently of the model with an accessible switch", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-autopilot-ui-"));
  const project = { id: "fixture", name: "Fixture", root: join(root, "fixture") };
  let server, browser;
  t.after(async () => {
    await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [project] }));
  for (const directory of ["agents", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project.root, directory), { recursive: true });
  const file = join(project.root, "spool.json");
  await writeFile(file, JSON.stringify({ version: 1, defaultModel: "gpt-5.4", other: "preserved" }));
  const heartbeat = () => writeFile(join(project.root, "controls", "capabilities.json"), JSON.stringify({
    projectModelVersion: 1, autopilotVersion: 1, updatedAt: new Date().toISOString(),
  }));
  server = await startProductionApp(root);
  const origin = server.url;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  await page.route("**/api/models", route => route.fulfill({ json: [{ value: "gpt-5.4", label: "GPT-5.4" }] }));
  await page.goto(`${origin}/#/fixture`);
  const open = page.getByRole("button", { name: "Settings", exact: true });
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const toggle = dialog.getByRole("switch", { name: "Autopilot", exact: true });
  await open.click();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(open).toBeFocused();
  await open.click();
  await expect(toggle).toBeChecked();
  await toggle.focus(); await page.keyboard.press("Space");
  await expect(toggle).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(toggle).toBeChecked();
  await heartbeat();
  await dialog.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    version: 1, defaultModel: "gpt-5.4", other: "preserved", autopilot: true,
  });
  await page.reload(); await open.click();
  await expect(toggle).toBeChecked();
  assert.deepEqual((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations, []);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false);
  await toggle.click();
  await heartbeat();
  await dialog.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal(JSON.parse(await readFile(file, "utf8")).autopilot, false);
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.unroute("**/api/models");
  await page.route("**/api/models", route => route.fulfill({ status: 503,
    json: { error: "The model list is unavailable. Your saved model and other settings can still be used." } }));
  await page.reload(); await open.click();
  await expect(dialog.getByRole("alert")).toContainText("other settings can still be used");
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await heartbeat();
  await dialog.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal(JSON.parse(await readFile(file, "utf8")).autopilot, true);
  await open.click();
  await toggle.click();
  await expect(dialog.getByRole("button", { name: "Retry model loading", exact: true })).toBeVisible();
  await page.unroute("**/api/models");
  await page.route("**/api/models", route => route.fulfill({ json: [{ value: "gpt-5.4", label: "GPT-5.4" }] }));
  await dialog.getByRole("button", { name: "Retry model loading", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(toggle).not.toBeChecked();
  await heartbeat();
  await dialog.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal(JSON.parse(await readFile(file, "utf8")).autopilot, false);
});
