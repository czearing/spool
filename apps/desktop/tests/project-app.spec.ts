import { expect, test, type Locator } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readSpoolItems } from "../src/lib/spool";
import { workItemTotal } from "./project-fixture";

const appearance = (locator: Locator) => locator.evaluate((node) => {
  const css = getComputedStyle(node);
  return Object.fromEntries(["height", "width", "padding", "gap", "border-color", "border-radius", "background-color",
    "color", "font-size", "font-weight", "box-shadow"].map((property) => [property, css.getPropertyValue(property)]));
});
test("the app uses the exact Storybook sidebar switcher and navigation presentation", async ({ page, context }) => {
  const reference = await context.newPage();
  try {
    await reference.goto("http://127.0.0.1:6006/iframe.html?id=components-sidebar--default&viewMode=story&globals=theme:light");
    await expect(reference.getByRole("button", { name: "Switch workspace, Spool" })).toBeVisible();
    await page.goto("/bohemia"); await page.evaluate(() => document.fonts.ready);
    const switcher = page.getByRole("button", { name: "Switch project, Bohemia" });
    expect(await appearance(switcher)).toEqual(await appearance(reference.getByRole("button", { name: "Switch workspace, Spool" })));
    expect(await appearance(page.getByRole("link", { name: "Home", exact: true })))
      .toEqual(await appearance(reference.getByRole("link", { name: /^Work items/ })));
    expect(await appearance(page.getByRole("link", { name: "Tasks", exact: true })))
      .toEqual(await appearance(reference.getByRole("link", { name: "Overview", exact: true })));
    await expect(switcher.getByRole("img", { name: "Bohemia" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Overview timeline", exact: true })).toHaveText("Last 7 days");
    await expect(switcher).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  } finally { await reference.close(); }
});
test("Home shows the configured project's task total and cost breakdown without status cards", async ({ page }) => {
  const now = new Date(), start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 6 * 86400000;
  const expected = (await readSpoolItems()).filter((item) =>
    Date.parse(item.updatedAt ?? "") >= start && Date.parse(item.updatedAt ?? "") <= now.getTime()).length;
  await page.goto("/"); await expect(page).toHaveURL(/\/bohemia$/);
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await expect(page.locator("main dl")).toHaveCount(0);
  await expect(workItemTotal(page)).toHaveText(`${expected} work items`);
  await expect(page.getByRole("heading", { name: "Cost by agent", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Current status", exact: true })).toHaveCount(0);
  await expect(page.locator("[data-work-item-id]")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});
test("Tasks retains navigation, history and direct-route support", async ({ page }) => {
  await page.goto("/bohemia"); await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(page).toHaveURL(/\/bohemia\/tasks$/);
  await expect(page.getByRole("link", { name: "Tasks", exact: true })).toHaveAttribute("aria-current", "page");
  await page.reload(); await expect(page.getByRole("region", { name: "Work items", exact: true })).toBeVisible();
  await page.goBack(); await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await page.goForward(); await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
});
test("the shared project menu opens the existing dialog and restores focus on cancellation", async ({ page }) => {
  await page.goto("/bohemia");
  const trigger = page.getByRole("button", { name: "Switch project, Bohemia" });
  await trigger.focus(); await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemradio", { name: "Bohemia", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("menuitemradio", { name: /not configured/ })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Create project...", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create project", exact: true });
  await expect(dialog.getByRole("textbox", { name: /^Project name/ })).toBeFocused();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape"); await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
  for (const route of ["/unknown", "/book-cook/tasks"]) expect((await page.goto(route))?.status()).toBe(404);
});
test("mobile opens the same vertical sidebar rather than restyling it into tabs", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/bohemia/tasks");
  expect((await page.getByRole("main").boundingBox())!.width).toBe(390);
  await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  const sidebar = page.getByRole("dialog", { name: "Project navigation", exact: true });
  await expect(sidebar.getByRole("button", { name: "Switch project, Bohemia" })).toBeVisible();
  const home = sidebar.getByRole("link", { name: "Home", exact: true });
  const tasks = sidebar.getByRole("link", { name: "Tasks", exact: true });
  expect((await tasks.boundingBox())!.y).toBeGreaterThan((await home.boundingBox())!.y);
  await sidebar.getByRole("button", { name: "Switch project, Bohemia" }).click();
  await expect(page.getByRole("menuitemradio", { name: "Bohemia", exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await home.click();
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible(); await expect(sidebar).toHaveCount(0);
  await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  await page.getByRole("dialog").getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  expect((await page.getByRole("main").boundingBox())!.width).toBe(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && scrollY === 0)).toBe(true);
});
test("Home and native navigation remain server-rendered without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage(); await page.goto("http://127.0.0.1:3000/bohemia");
    await expect(page.getByLabel("Total recorded cost", { exact: true })).toHaveText(/^(?:\$[\d,]+\.\d{2}|<\$0.01|Unavailable)$/);
    await expect(page.getByRole("table", { name: "Cost by agent data", exact: true })).toBeAttached();
    await page.getByRole("link", { name: "Tasks", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  } finally { await context.close(); }
});
