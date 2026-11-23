import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./project-fixture";

test("live board searches title, ID and assignee, combines real status filters and keeps queue files unchanged", async ({ page, projectServer: server }) => {
  const file = join(server.bohemia, "queues", "completed", "A-1.json");
  const task = { id: "A-1", title: "Review rendering", status: "completed", agent: "engineer", prompt: "PRIVATE" };
  await writeFile(file, JSON.stringify(task)); const before = await readFile(file, "utf8");
  await page.goto(`${server.url}/bohemia/tasks`);
  await page.getByRole("button", { name: "Search board", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search work items" });
  for (const query of ["rendering", "a-1", "engineer"]) {
    await search.fill(query); await expect(page.locator("[data-work-item-id]")).toHaveCount(1);
    await expect(page.locator('[data-work-item-id="A-1"]')).toBeVisible();
  }
  await page.getByRole("button", { name: "Filter by status", exact: true }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Incoming", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitemcheckbox", { name: "Backlog", exact: true })).toHaveCount(0);
  await page.getByRole("menuitemcheckbox", { name: "Failed", exact: true }).click(); await page.keyboard.press("Escape");
  await expect(page.locator("[data-work-item-id]")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "0 matching tasks" })).toBeVisible();
  await page.getByRole("button", { name: "Clear search and filters", exact: true }).click();
  await expect(page.locator("[data-work-item-id]")).toHaveCount(2);
  await search.press("Escape"); await expect(page.getByRole("button", { name: "Search board", exact: true })).toBeFocused();
  expect(await readFile(file, "utf8")).toBe(before);
  await expect(page.locator('[draggable="true"],[aria-roledescription="draggable"]')).toHaveCount(0);
});
test("sorting and search survive live queue refreshes and remain view-only", async ({ page, projectServer: server }) => {
  for (const [id, title] of [["B-1", "Task 10"], ["B-2", "Task 2"]]) {
    await writeFile(join(server.bohemia, "queues", "incoming", `${id}.json`), JSON.stringify({ id, title, agent: "engineer" }));
  }
  await page.goto(`${server.url}/bohemia/tasks`);
  await page.getByRole("button", { name: "Search board", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search work items" }).fill("Task");
  await page.getByRole("button", { name: "Sort work items", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Title: A to Z", exact: true }).click();
  const list = page.getByRole("list", { name: "Incoming items", exact: true });
  expect(await list.locator("[data-work-item-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-work-item-id")))).toEqual(["B-2", "B-1"]);
  await writeFile(join(server.bohemia, "queues", "incoming", "B-3.json"), JSON.stringify({ id: "B-3", title: "Task 1", agent: "engineer" }));
  await expect(list.locator("[data-work-item-id]")).toHaveCount(3, { timeout: 10000 });
  await expect(page.getByRole("searchbox", { name: "Search work items" })).toHaveValue("Task");
  expect(await list.locator("[data-work-item-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-work-item-id")))).toEqual(["B-3", "B-2", "B-1"]);
  await page.getByRole("button", { name: "Sort work items", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Default order", exact: true }).click();
  expect(await list.locator("[data-work-item-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-work-item-id")))).toEqual(["B-1", "B-2", "B-3"]);
});
test("search controls and new task fields fit on mobile", async ({ page, projectServer: server }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${server.url}/bohemia/tasks`);
  await page.getByRole("button", { name: "Search board", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search work items" }).fill("A-1");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Instructions", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("Storybook task form serializes the shared editor and submits its local demo", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:6006/iframe.html?id=tasks-new-task--default&viewMode=story");
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Title", exact: true }).fill("Storybook work item");
  await dialog.getByRole("combobox", { name: "Agent", exact: true }).click();
  await page.getByRole("option", { name: "reviewer", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: /^Working folder/ })).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "Instructions", exact: true }).fill("Review the changes.");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Demo task" })).toContainText("assigned to reviewer.");
  expect(errors).toEqual([]);
});
test("composer follows the inspected title-description-action-row layout on desktop and mobile", async ({ page, projectServer: server }) => {
  await page.goto(`${server.url}/bohemia/tasks`);
  await page.getByRole("button", { name: "New", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New task", exact: true });
  await expect(dialog).toHaveCSS("opacity", "1");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const title = dialog.getByRole("textbox", { name: "Title", exact: true });
    await expect(title).toHaveCSS("font-weight", "600");
    await expect(title).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    const bounds = await Promise.all([dialog, title, dialog.getByRole("textbox", { name: "Instructions", exact: true }),
      dialog.getByRole("combobox", { name: "Agent", exact: true }), dialog.getByRole("button", { name: "Create", exact: true })].map((element) => element.boundingBox()));
    if (bounds.some((box) => !box)) throw new Error("Missing composer control.");
    const [frame, heading, instructions, agent, create] = bounds.map((box) => box!);
    expect(frame.height).toBeLessThan(280);
    expect(heading.y + heading.height).toBeLessThan(instructions.y);
    expect(instructions.y + instructions.height).toBeLessThan(agent.y);
    expect(Math.abs(agent.x - heading.x)).toBeLessThan(2);
    expect(Math.abs(create.x + create.width - (frame.x + frame.width - 24))).toBeLessThan(2);
    expect(Math.abs(agent.y + agent.height / 2 - (create.y + create.height / 2))).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await dialog.getByRole("combobox", { name: "Agent", exact: true }).focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("e"); await page.keyboard.press("Enter");
  await expect(dialog.getByRole("combobox", { name: "Agent", exact: true })).toHaveText("engineer");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeFocused();
});
