import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";

test("Home defers settings and chat code until requested without losing settings focus", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-shell-loading-"));
  const project = { id: "fixture", name: "Fixture", root: join(root, "project") };
  let app, browser;
  t.after(async () => { await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [project] }));
  for (const directory of ["agents", "controls", ...["incoming", "in_progress", "completed", "failed"].map(queue => join("queues", queue))])
    await mkdir(join(project.root, directory), { recursive: true });
  await writeFile(join(project.root, "agents", "engineer.md"), "# Isolated fixture; never launch a provider.");
  app = await startProductionApp(root, [{
    name: "deferred-shell-features", enforce: "pre",
    transform(code, id) {
      id = id.replaceAll("\\", "/");
      if (id.endsWith("/src/components/settings-dialog.tsx"))
        return { code: `await new Promise(resolve => { globalThis.__releaseSettings = resolve; });\n${code}`, map: null };
      if (id.endsWith("/src/desktop/preload-agent-page.ts")) {
        const needle = "export async function preloadAgentPage() {";
        assert.ok(code.includes(needle), "Chat preload instrumentation must match the source.");
        return { code: code.replace(needle,
          `${needle}\nglobalThis.__chatPreloads = (globalThis.__chatPreloads ?? 0) + 1;`), map: null };
      }
    },
  }]);
  browser = await chromium.launch();
  const page = await browser.newPage(), errors = [];
  let models = 0, settings = 0, mutations = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/api/projects/fixture/settings") settings++;
    if (url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) mutations++;
  });
  await page.route("**/api/models", route => {
    models++;
    return route.fulfill({ json: [{ value: "gpt-5.4", label: "GPT-5.4" }] });
  });
  await page.goto(`${app.url}/#/fixture`, { waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "Activity by agent", exact: true })).toBeVisible({ timeout: 10000 });
  assert.equal(await page.evaluate(() => typeof globalThis.__releaseSettings), "undefined");
  assert.equal(await page.evaluate(() => globalThis.__chatPreloads ?? 0), 0);
  assert.equal(models, 0);
  assert.equal(settings, 0);
  const trigger = page.getByRole("button", { name: "Settings", exact: true });
  await trigger.click();
  await page.waitForFunction(() => typeof globalThis.__releaseSettings === "function");
  await expect(page.getByRole("status").filter({ hasText: "Loading settings..." })).toBeVisible();
  assert.equal(settings, 0);
  await page.evaluate(() => globalThis.__releaseSettings());
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog.getByRole("combobox", { name: "Default agent model", exact: true })).toContainText("GPT-5.4");
  await dialog.getByRole("combobox", { name: "Appearance", exact: true }).click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(trigger).toBeFocused();
  const nav = page.getByRole("navigation", { name: "Project navigation", exact: true });
  await nav.getByRole("button", { name: "Agents", exact: true }).click();
  await nav.getByRole("link", { name: "engineer", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message agent", exact: true })).toBeVisible({ timeout: 20000 });
  assert.ok(await page.evaluate(() => globalThis.__chatPreloads > 0));
  assert.equal(mutations, 0, "Opening features must not submit agent work or change project settings.");
  assert.deepEqual(errors, []);
});
