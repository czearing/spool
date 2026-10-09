import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { getProjects } from "../src/lib/projects";
import { readSpoolArchive } from "../src/lib/spool-archive";
import { spoolQueues } from "../src/lib/spool-model";

test("Tasks displays actual archived attempts without conflating repeated task IDs", async ({ page }) => {
  const project = (await getProjects()).find((project) => project.id === "bohemia")!;
  const expected = await readSpoolArchive(project.root);
  await page.goto("/bohemia/tasks");
  const archive = page.getByRole("region", { name: "Archive", exact: true });
  const trigger = archive.getByRole("button", { name: `Archive (${expected.length})`, exact: true });
  await expect(trigger).toHaveAttribute("aria-expanded", "false"); await trigger.click();
  const table = archive.getByRole("table", { name: "Archived work items", exact: true });
  await expect(table).toBeVisible();
  const rows = await table.locator("tbody tr").evaluateAll((rows) => rows.map((row) => ({
    title: row.querySelector("td")?.textContent, status: row.querySelectorAll("td")[1]?.textContent,
    updatedAt: row.querySelector("time")?.getAttribute("datetime"),
  })));
  expect(rows).toEqual(expected.map((item) => ({
    title: item.title + item.id, status: spoolQueues.find((queue) => queue.id === item.status)!.label, updatedAt: item.updatedAt,
  })));
  expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});
for (const height of [844, 1600]) test(`large boards and archives stay capped at viewport height ${height}`, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height });
  await page.goto("http://127.0.0.1:6006/iframe.html?id=kanban-readonlyboard--with-archive&viewMode=story");
  const board = page.getByRole("region", { name: "Work items", exact: true });
  await expect(board.locator("[data-work-item-id]")).toHaveCount(600);
  const frame = board.locator("..");
  expect((await frame.boundingBox())!.height).toBeLessThanOrEqual(512);
  const completed = page.getByRole("list", { name: "Completed items", exact: true });
  const heading = page.getByRole("heading", { name: "Completed", exact: true });
  const headerY = (await heading.boundingBox())!.y;
  await completed.locator("li").last().scrollIntoViewIfNeeded();
  expect(await completed.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  expect((await heading.boundingBox())!.y).toBe(headerY);
  await page.getByRole("button", { name: "Archive (120)", exact: true }).click();
  const list = page.getByRole("region", { name: "Archived work items list", exact: true });
  await expect(list.getByRole("row")).toHaveCount(121);
  expect((await list.boundingBox())!.height).toBeLessThanOrEqual(320);
  await list.locator("tbody tr").last().scrollIntoViewIfNeeded();
  await expect(list.locator("tbody tr").last()).toBeInViewport();
  expect(await list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  expect((await frame.boundingBox())!.height).toBeLessThanOrEqual(512);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await list.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await list.evaluate((node) => { node.scrollTop = 0; node.scrollLeft = node.scrollWidth; });
  await expect(list.getByRole("columnheader", { name: "Updated (UTC)", exact: true })).toBeInViewport();
});
