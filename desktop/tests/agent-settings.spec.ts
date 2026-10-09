import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./spool-task-fixture";

test("agent dropdown preserves instructions, restores focus and supports project inheritance on mobile", async ({ page, projectServer: server, scheduler }) => {
  void scheduler;
  const file = join(server.bohemia, "agents", "engineer.md"), before = await readFile(file, "utf8");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${server.url}/bohemia/agents/engineer`);
  const trigger = page.getByRole("button", { name: "Agent actions", exact: true });
  await trigger.click(); await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Agent settings", exact: true });
  const model = dialog.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toContainText("unchanged-model");
  await expect(dialog.getByRole("textbox", { name: "Description", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("combobox", { name: "Appearance", exact: true })).toHaveCount(0);
  await model.click(); await page.getByRole("option", { name: "Use project default", exact: true }).click();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  await dialog.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
  expect((await readFile(file, "utf8")).split("---")[2]).toBe(before.split("---")[2]);
  await page.reload(); await trigger.click(); await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(model).toContainText("Use project default");
  await model.click(); await page.getByRole("option", { name: "GPT-5.4", exact: true }).click();
  await dialog.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(dialog).toBeHidden();
  const saved = await readFile(file, "utf8");
  expect(saved).toContain('model: "gpt-5.4"\r\n');
  expect(saved).toContain("description: Fixture engineer\r\n");
  expect(saved.split("---")[2]).toBe(before.split("---")[2]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("conflicting changes are explicit and cannot overwrite prompt edits; cancel does not save", async ({ page, projectServer: server, scheduler }) => {
  void scheduler;
  const file = join(server.bohemia, "agents", "engineer.md");
  await page.goto(`${server.url}/bohemia/agents/engineer`);
  await page.getByRole("button", { name: "Agent actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Agent settings", exact: true });
  const model = dialog.getByRole("combobox", { name: "Model", exact: true });
  await model.click(); await page.getByRole("option", { name: "Use project default", exact: true }).click();
  const changed = (await readFile(file, "utf8")) + "External prompt edit.\r\n";
  await writeFile(file, changed);
  await dialog.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Agent changed");
  expect(await readFile(file, "utf8")).toBe(changed);
  await dialog.getByRole("button", { name: "Reload settings", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(model).toContainText("unchanged-model");
  await model.click(); await page.getByRole("option", { name: "Use project default", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await readFile(file, "utf8")).toBe(changed);
});

test("settings writes reject foreign origins, unavailable agents, invalid models and old daemons", async ({ request, projectServer: server }) => {
  const endpoint = `${server.url}/api/projects/bohemia/settings`, headers = { Origin: server.url };
  const current = await (await request.get(endpoint)).json();
  expect((await request.put(endpoint, { data: { ...current, model: "gpt-5.4" } })).status()).toBe(403);
  expect((await request.put(endpoint, { headers: { Origin: "http://foreign.example" }, data: current })).status()).toBe(403);
  expect((await request.put(endpoint, { headers, data: current })).status()).toBe(503);
  expect((await request.put(endpoint, { headers, data: { ...current, model: null } })).status()).toBe(400);
  expect((await request.get(`${server.url}/api/projects/missing/settings`)).status()).toBe(404);
  expect((await request.get(`${server.url}/api/projects/bohemia/agents/missing/settings`)).status()).toBe(404);
  const catalog = await (await request.get(`${server.url}/api/models`)).json();
  expect(catalog).toEqual(expect.arrayContaining([{ value: "gpt-5.4", label: "GPT-5.4" }]));
  expect((await request.put(endpoint, { headers, data: { ...current, model: "not-a-real-provider-model" } })).status()).toBe(400);
});

test("catalog failures remain visible and recoverable without a free-text fallback", async ({ page, projectServer: server }) => {
  await page.route("**/api/models", (route) => route.fulfill({ status: 503, json: { error: "Model discovery unavailable" } }));
  await page.goto(`${server.url}/bohemia`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog.getByRole("alert")).toHaveText("Model discovery unavailable");
  await expect(dialog.getByRole("button", { name: "Save settings", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await page.unroute("**/api/models");
  await dialog.getByRole("button", { name: "Reload settings", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  const model = dialog.getByRole("combobox", { name: "Default agent model", exact: true });
  await expect(model).toBeEnabled({ timeout: 25000 });
  await expect(model).toContainText("GPT-5.4");
});
