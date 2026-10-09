import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readSpoolItems, spoolQueues } from "../src/lib/spool";

test("the main UI displays every local work item under its actual queue status", async ({ page }) => {
  const items = await readSpoolItems();
  await page.goto("/bohemia/tasks");
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  const board = page.getByRole("region", { name: "Work items", exact: true });
  await expect(board.getByRole("heading")).toHaveText(spoolQueues.map((queue) => queue.label));
  for (const queue of spoolQueues) {
    const expected = items.filter((item) => item.status === queue.id);
    const lane = board.getByRole("region", { name: queue.label, exact: true });
    await expect(lane).toHaveAttribute("data-status", queue.id);
    const rows = await lane.locator("[data-work-item-id]").evaluateAll((nodes) => nodes.map((node) => ({
      id: node.getAttribute("data-work-item-id"), title: node.querySelector("span:last-child")?.textContent,
    })));
    expect(rows).toEqual(expected.map(({ id, title }) => ({ id, title })));
    await expect(lane.getByLabel(`${expected.length} of ${expected.length} ${queue.label} tasks`, { exact: true })).toHaveText(String(expected.length));
  }
  await expect(board.getByRole("button")).toHaveCount(0);
  await expect(board.locator("input,textarea,select,[draggable=true],[aria-roledescription=draggable]")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Archive", exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});
test("work items are server-rendered without JavaScript or a client task-list request", async ({ browser, page }) => {
  const items = await readSpoolItems();
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const document = await context.newPage(); await document.goto("http://127.0.0.1:3000/bohemia/tasks");
    await expect(document.locator("[data-work-item-id]")).toHaveCount(items.length);
    await expect(document.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
    if (items.length) await expect(document.locator("[data-work-item-id]").first().locator("span").last()).toBeVisible();
  } finally { await context.close(); }
  const dataRequests: string[] = [];
  page.on("request", (request) => { if (["fetch", "xhr"].includes(request.resourceType())) dataRequests.push(request.url()); });
  await page.goto("/bohemia/tasks"); await expect(page.locator("[data-work-item-id]")).toHaveCount(items.length);
  expect(dataRequests.filter((url) => /\/api\/projects\/[^/]+\/tasks/.test(url))).toEqual([]);
});
test("large snapshots scroll within columns and remain read-only on mobile", async ({ page }) => {
  await page.goto("http://127.0.0.1:6006/iframe.html?id=kanban-readonlyboard--large&viewMode=story");
  await expect(page.locator("[data-work-item-id]")).toHaveCount(600);
  const list = page.getByRole("list", { name: "Completed items", exact: true });
  const initialHeader = await page.getByRole("heading", { name: "Completed", exact: true }).boundingBox();
  await list.locator("li").last().scrollIntoViewIfNeeded();
  await expect(list.locator("li").last()).toBeInViewport();
  expect(await list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  expect((await page.getByRole("heading", { name: "Completed", exact: true }).boundingBox())!.y).toBe(initialHeader!.y);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("button")).toHaveCount(0);
  const laneScroll = page.locator("#board-items").locator("..");
  expect(await laneScroll.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await laneScroll.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
  const finalList = page.getByRole("list", { name: "Blocked items", exact: true });
  await expect(finalList.locator("li").first().locator("span").last()).toBeVisible();
  await finalList.locator("li").last().scrollIntoViewIfNeeded();
  await expect(finalList.locator("li").last()).toBeInViewport();
});
