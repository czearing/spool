import { test, expect } from "./project-fixture";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";

for (const mobile of [false, true]) test(`${mobile ? "mobile" : "desktop"} sidebar reuses agent actions without nested interactive elements`, async ({ page, projectServer: server }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${server.url}/bohemia/agents/engineer`);
  if (mobile) await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const trigger = page.getByRole("button", { name: "engineer actions", exact: true });
  await expect(trigger).toBeVisible();
  expect(await trigger.evaluate((element) => element.closest("a") === null)).toBe(true);
  await trigger.focus(); await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText(["Edit prompt", "Settings", "Delete agent"]);
  await expect(menu.getByRole("menuitem", { name: "Edit prompt", exact: true })).toHaveAttribute("href", "/bohemia/agents/engineer/prompt");
  await menu.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Agent settings", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toContainText("unchanged-model");
  if (mobile) {
    const navigationLayer = await page.locator('[data-density][aria-label="Project navigation"]').evaluate((node) => Number(getComputedStyle(node).zIndex));
    expect(await dialog.evaluate((node) => Number(getComputedStyle(node).zIndex))).toBeGreaterThan(navigationLayer);
  }
  await dialog.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByRole("option", { name: "Use project default", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toContainText("Use project default");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
  await trigger.click(); await menu.getByRole("menuitem", { name: "Delete agent", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Delete agent?", exact: true });
  await expect(confirm).toContainText("engineer");
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("sidebar and page menus have identical entries and deleting another agent preserves the current page", async ({ page, projectServer: server }) => {
  await page.goto(`${server.url}/bohemia/agents/engineer`);
  await page.getByRole("button", { name: "Agent actions", exact: true }).click();
  const menu = page.getByRole("menu"), entries = await menu.getByRole("menuitem").allTextContents();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("link", { name: "reviewer", exact: true }).hover();
  await page.getByRole("button", { name: "reviewer actions", exact: true }).click();
  await expect(menu.getByRole("menuitem")).toHaveText(entries);
  const before = await readFile(join(server.bohemia, "agents", "engineer.md"), "utf8");
  await menu.getByRole("menuitem", { name: "Delete agent", exact: true }).click();
  await page.getByRole("dialog", { name: "Delete agent?", exact: true }).getByRole("button", { name: "Delete agent", exact: true }).click();
  await expect(page.getByRole("button", { name: "reviewer actions", exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(`${server.url}/bohemia/agents/engineer`);
  await expect(page.getByRole("heading", { name: "engineer", exact: true })).toBeVisible();
  expect(await readdir(join(server.bohemia, "agents"))).toEqual(["engineer.md"]);
  expect(await readFile(join(server.bohemia, "agents", "engineer.md"), "utf8")).toBe(before);
});
