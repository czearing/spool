import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startProductionApp } from "./production-app.mjs";

test("agent titles save through native settings without renaming agents or overwriting concurrent edits", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-agent-title-"));
  const project = { id: "fixture", name: "Fixture", root: join(root, "project") };
  let server, browser;
  t.after(async () => { await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [project] }));
  for (const directory of ["agents", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project.root, directory), { recursive: true });
  const file = join(project.root, "agents", "engineer.md");
  const original = "---\r\ndescription: Keep this\r\ncustom_hint: preserved\r\n---\r\n# Original instructions\r\n";
  await writeFile(file, original);
  const heartbeat = () => writeFile(join(project.root, "controls", "capabilities.json"), JSON.stringify({
    agentSettingsVersion: 1, updatedAt: new Date().toISOString(),
  }));
  await heartbeat();
  server = await startProductionApp(root);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.route("**/api/models", route => route.fulfill({ json: [{ value: "gpt-5.4", label: "GPT-5.4" }] }));
  const origin = server.url, endpoint = `${origin}/api/projects/fixture/agents/engineer/settings`;
  await page.goto(`${origin}/#/fixture/agents/engineer`);
  const open = async () => {
    await page.getByRole("button", { name: "Agent actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  };
  const dialog = page.getByRole("dialog", { name: "Agent settings", exact: true });
  const title = dialog.getByRole("textbox", { name: "Title", exact: true });
  const save = dialog.getByRole("button", { name: "Save settings", exact: true });
  await open();
  await expect(title).toHaveValue("engineer");
  await title.fill("Discarded title");
  await page.keyboard.press("Escape");
  assert.equal(await readFile(file, "utf8"), original);
  await open();
  await expect(title).toHaveValue("engineer");
  await title.fill("   ");
  await expect(save).toBeDisabled();
  await title.fill('Release "Engineer": ---');
  assert.deepEqual((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations, []);
  assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false);
  await heartbeat(); await save.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: 'Release "Engineer": ---', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: 'Release "Engineer": ---', exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  const navigation = page.getByRole("navigation", { name: "Project navigation", exact: true });
  await navigation.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(navigation.getByRole("link", { name: 'Release "Engineer": ---', exact: true })).toHaveAttribute("href", "#/fixture/agents/engineer");
  await page.keyboard.press("Escape");
  const saved = await readFile(file, "utf8");
  assert.match(saved, /description: Keep this\r\ncustom_hint: preserved\r\n/);
  assert.ok(saved.endsWith("# Original instructions\r\n"));
  assert.deepEqual(await readdir(join(project.root, "agents")), ["engineer.md"]);
  await open(); await expect(title).toHaveValue('Release "Engineer": ---');
  await title.fill("Stale change");
  const changed = saved + "External prompt edit.\r\n";
  await writeFile(file, changed);
  await heartbeat(); await save.click();
  await expect(dialog.getByRole("alert")).toContainText("Agent changed");
  await expect(title).toHaveValue("Stale change");
  assert.equal(await readFile(file, "utf8"), changed);
  await dialog.getByRole("button", { name: "Reload settings", exact: true }).click();
  await expect(title).toHaveValue('Release "Engineer": ---');
  await title.fill("Final title");
  let reject = true;
  await page.route(endpoint, async route => {
    if (reject && route.request().method() === "PUT") {
      reject = false;
      return route.fulfill({ status: 503, json: { error: "Fixture temporary save failure" } });
    }
    await route.continue();
  });
  await heartbeat(); await save.click();
  await expect(dialog.getByRole("alert")).toContainText("Fixture temporary save failure");
  await expect(title).toHaveValue("Final title");
  assert.equal(await readFile(file, "utf8"), changed);
  await dialog.getByRole("button", { name: "Reload settings", exact: true }).click();
  await expect(title).toHaveValue('Release "Engineer": ---');
  await title.fill("Final title");
  await heartbeat(); await save.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Final title", exact: true })).toBeVisible();
  assert.ok((await readFile(file, "utf8")).endsWith("External prompt edit.\r\n"));
  const current = await (await page.request.get(endpoint)).json();
  const input = { model: current.model, max_concurrent_runs: current.maxConcurrentRuns, revision: current.revision };
  for (const invalid of ["", " ", "Bad\nTitle", "x".repeat(121)]) {
    const response = await page.request.put(endpoint, { headers: { Origin: origin }, data: { ...input, title: invalid } });
    assert.equal(response.status(), 400, await response.text());
  }
});
