import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const boardStory = "http://127.0.0.1:6006/iframe.html?id=workroom-board--default&viewMode=story";

test("has no automated WCAG A/AA accessibility violations", async ({ page }) => {
  await page.goto(boardStory);
  await expect(page.getByRole("region", { name: "Work items", exact: true }).locator('[id^="work-item-"]')).toHaveCount(6);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
});

test("renders a horizontal board with semantic groups and neutral controls", async ({ page }) => {
  await page.goto(boardStory);
  const board = page.getByRole("region", { name: "Work items", exact: true });
  await expect(board).toBeVisible();
  await expect(board.getByRole("heading")).toHaveText(["Backlog", "In progress", "Completed", "Blocked"]);
  const headers = await board.getByRole("heading").all();
  const boxes = await Promise.all(headers.map((header) => header.boundingBox()));
  for (let i = 1; i < boxes.length; i++) {
    expect(boxes[i]!.y).toBe(boxes[0]!.y);
    expect(boxes[i]!.x).toBeGreaterThan(boxes[i - 1]!.x);
  }
  await expect(board.locator('[id^="work-item-"]')).toHaveCount(6);
  await expect(page.locator("aside, nav, input, select, textarea")).toHaveCount(0);
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Filter by status", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sort work items", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Add view|Manage view|settings|subgroup/i })).toHaveCount(0);
  await expect(board.locator('[data-status="in-progress"]')).toHaveAccessibleName("In progress");
  await expect(board.locator('[data-status="completed"]')).toHaveAccessibleName("Completed");
  await expect(board.locator('[data-status="blocked"]')).toHaveAccessibleName("Blocked");
});

test("keeps columns horizontal on mobile with scrolling inside the board", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(boardStory);
  const board = page.getByRole("region", { name: "Work items", exact: true });
  const first = await board.getByRole("heading").first().boundingBox();
  const last = await board.getByRole("heading").last().boundingBox();
  expect(first!.y).toBe(last!.y);
  expect(last!.x).toBeGreaterThan(first!.x);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
