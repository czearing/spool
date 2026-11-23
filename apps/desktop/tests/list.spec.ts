import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const story = (name = "sorting", theme = "light") =>
  `http://127.0.0.1:6006/iframe.html?id=components-list--${name}&viewMode=story&globals=theme:${theme}`;
const rows = (page: Page) => page.getByRole("table", { name: "Work items", exact: true }).locator("tbody tr");
const titles = (page: Page) => rows(page).getByRole("rowheader");
const owners = async (page: Page) => (await titles(page).allTextContents()).map((text) => text.replace(/^Task \d+/, ""));

for (const theme of ["light", "dark"]) {
  test(`${theme}: native list sorting cycles, preserves ties and focus, and exposes accessible icons`, async ({ page }) => {
    await page.goto(story("sorting", theme));
    const table = page.getByRole("table", { name: "Work items", exact: true });
    const button = table.getByRole("button", { name: "Work item", exact: true });
    await button.focus();
    await expect(button).toHaveCSS("outline-style", "none");
    await expect(button.locator(":scope > span:not([aria-hidden])")).toHaveCSS("text-decoration-line", "underline");
    await page.keyboard.press("Enter");
    await expect(table.getByRole("columnheader", { name: "Work item", exact: true })).toHaveAttribute("aria-sort", "ascending");
    expect(await owners(page)).toEqual(["Documentation", "Accessibility", "Performance", "Design system"]);
    await expect(button).toBeFocused();
    await page.keyboard.press("Space");
    expect(await owners(page)).toEqual(["Design system", "Accessibility", "Performance", "Documentation"]);
    await expect(table.locator("[aria-sort]")).toHaveCount(1);
    await page.keyboard.press("Enter");
    expect(await owners(page)).toEqual(["Design system", "Accessibility", "Documentation", "Performance"]);
    await expect(table.locator("[aria-sort]")).toHaveCount(0);
    await expect(table).toHaveAccessibleDescription(/Column header buttons sort/);
    await expect(titles(page).first()).toHaveAccessibleName("Task 10 Design system");
    const icon = titles(page).first().locator("svg");
    await expect(icon).toHaveCSS("width", "16px");
    await expect(icon.locator("..")).toHaveAttribute("aria-hidden", "true");
    const results = await new AxeBuilder({ page }).include("#storybook-root").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
  });
}

test("numeric and date sorting use raw values, keep missing values last, and reset other headers", async ({ page }) => {
  await page.goto(story());
  const points = page.getByRole("button", { name: "Points", exact: true });
  await points.click();
  expect(await owners(page)).toEqual(["Design system", "Performance", "Accessibility", "Documentation"]);
  await points.click();
  expect(await owners(page)).toEqual(["Accessibility", "Design system", "Performance", "Documentation"]);
  await page.getByRole("button", { name: "Updated", exact: true }).click();
  expect(await owners(page)).toEqual(["Performance", "Design system", "Accessibility", "Documentation"]);
  await expect(page.locator("th[aria-sort]")).toHaveCount(1);
  await page.getByRole("button", { name: "Updated", exact: true }).click();
  expect(await owners(page)).toEqual(["Accessibility", "Design system", "Performance", "Documentation"]);
});

test("default sort, controlled reset, and custom ordering are independent", async ({ page }) => {
  await page.goto(story("initially-sorted"));
  await expect(page.getByRole("columnheader", { name: "Points", exact: true })).toHaveAttribute("aria-sort", "descending");
  expect(await owners(page)).toEqual(["Accessibility", "Design system", "Performance", "Documentation"]);
  await page.goto(story("controlled"));
  await page.getByRole("button", { name: "Points", exact: true }).click();
  await expect(page.getByText("estimate: asc", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reset sorting" }).click();
  expect(await owners(page)).toEqual(["Design system", "Accessibility", "Documentation", "Performance"]);
  await expect(page.locator("th[aria-sort]")).toHaveCount(0);
  await page.goto(story("custom-order"));
  await page.getByRole("button", { name: "Status", exact: true }).click();
  expect(await owners(page)).toEqual(["Documentation", "Accessibility", "Design system", "Performance"]);
});

test("manual sorting reports state without sorting supplied rows", async ({ page }) => {
  await page.goto(story("manual-sorting"));
  await page.getByRole("button", { name: "Work item", exact: true }).click();
  expect(await owners(page)).toEqual(["Design system", "Accessibility", "Documentation", "Performance"]);
  await expect(page.getByText("Requested: title asc", { exact: true })).toBeVisible();
});

test("empty, initial loading, refreshing, and errors are explicit", async ({ page }) => {
  await page.goto(story("empty"));
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).getByRole("cell")).toHaveAttribute("colspan", "4");
  await expect(rows(page)).toContainText("No archived work.");
  await page.goto(story("loading"));
  await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("status")).toHaveText("Loading items...");
  await expect(page.getByRole("button", { name: "Work item", exact: true })).toBeDisabled();
  await page.goto(story("refreshing"));
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByRole("status")).toHaveText("Loading items...");
  await expect(page.locator("#storybook-root div").filter({ hasText: /^Loading items\.\.\.$/ }).last()).toBeVisible();
  await page.goto(story("error"));
  await expect(page.getByRole("alert")).toHaveText("Work items could not be loaded. Please try again.");
  await expect(titles(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Work item", exact: true })).toBeDisabled();
});

test("row actions are native controls and never sort a column", async ({ page }) => {
  await page.goto(story("with-actions"));
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await expect(page.locator("th[aria-sort]")).toHaveCount(0);
  const trigger = page.getByRole("button", { name: "Open item: Task 10, Design system", exact: true });
  await trigger.click();
  await expect(page.getByText("Opened Design system", { exact: true })).toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page.locator("th[aria-sort]")).toHaveCount(0);
});

test("compact spacing, narrow scrolling, RTL alignment, zoom, and forced colors retain controls", async ({ page }) => {
  await page.goto(story("compact", "dark"));
  await expect(titles(page).first()).toHaveCSS("padding-top", "4px");
  await page.goto(story("sorting", "dark"));
  await expect(titles(page).first()).toHaveCSS("padding-top", "8px");
  await expect(titles(page).first()).toHaveCSS("text-align", "start");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("html").evaluate((element) => { element.setAttribute("dir", "rtl"); element.style.fontSize = "200%"; });
  const region = page.getByRole("region", { name: "Work items list" });
  const points = page.getByRole("button", { name: "Points", exact: true });
  await expect(page.getByRole("columnheader", { name: "Points", exact: true })).toHaveCSS("text-align", "end");
  await points.click();
  await expect(page.getByRole("columnheader", { name: "Points", exact: true })).toHaveAttribute("aria-sort", "ascending");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await region.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(region).toBeFocused();
  await page.emulateMedia({ forcedColors: "active" });
  await points.focus();
  await expect(points).toHaveCSS("outline-style", "none");
  await expect(points.locator(":scope > span:not([aria-hidden])")).toHaveCSS("text-decoration-line", "underline");
  await expect(points.locator(":scope > span:not([aria-hidden])")).toHaveCSS("text-decoration-thickness", "2px");
});

test("sorting archived rows does not start dragging and sorted rows still restore", async ({ page }) => {
  await page.goto("http://127.0.0.1:6006/iframe.html?id=workroom-board--with-archive&viewMode=story");
  await page.getByRole("button", { name: "Archive (2)", exact: true }).click();
  const archive = page.getByRole("region", { name: "Archive", exact: true });
  await archive.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
  await archive.getByRole("button", { name: "Work item", exact: true }).click();
  await expect(archive.locator('[data-dragging="true"]')).toHaveCount(0);
  const row = archive.locator("#work-item-archived-1");
  await row.focus();
  await page.keyboard.press("Space");
  await expect(row).toHaveAttribute("data-dragging", "true");
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("region", { name: "Completed", exact: true })).toHaveAttribute("data-over", "true");
  await page.keyboard.press("Space");
  await expect(page.getByRole("region", { name: "Completed", exact: true }).locator("#work-item-archived-1")).toBeFocused();
  await expect(archive.getByRole("button", { name: "Archive (1)", exact: true })).toBeVisible();
});
