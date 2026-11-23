import { test, expect } from "./project-fixture";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

test("600 tasks move immediately before the server replies, ignore an orphaned lock, and persist", async ({ page, projectServer: server }) => {
  await mkdir(join(server.bohemia, "controls"));
  await writeFile(join(server.bohemia, "controls", "ui-archive.json.lock"), "");
  await Promise.all(Array.from({ length: 600 }, (_, index) => writeFile(join(server.bohemia, "queues", "completed", `PERF-${index}.json`),
    JSON.stringify({ id: `PERF-${index}`, title: `Performance task ${index}`, status: "completed", updated_at: "2026-10-01T10:00:00Z" }))));
  let release!: () => void, requestStarted = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/tasks/archive", async (route) => { requestStarted = true; await held; await route.continue(); });
  await page.goto(`${server.url}/bohemia/tasks`);
  const completed = page.getByRole("list", { name: "Completed items", exact: true });
  await expect(completed.locator("li")).toHaveCount(601);
  await page.getByRole("button", { name: "Completed actions" }).click();
  await page.getByRole("menuitem", { name: "Move all to archive" }).click();
  const confirm = page.getByRole("dialog").getByRole("button", { name: "Move all to archive" });
  await confirm.evaluate((node) => node.addEventListener("click", () => performance.mark("archive-click"), { once: true }));
  try {
    await confirm.click();
    await expect(completed.locator("li")).toHaveCount(0);
    const elapsed = await page.evaluate(() => performance.now() - performance.getEntriesByName("archive-click")[0].startTime);
    expect(elapsed).toBeLessThan(200);
    expect(requestStarted).toBe(true);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Archive (601)", exact: true })).toBeVisible();
    expect((await readdir(join(server.bohemia, "queues", "completed"))).length).toBe(601);
    console.log(`Archive 601 tasks: ${Math.round(elapsed)}ms to visible change before server response.`);
  } finally { release(); }
  await expect(page.getByRole("button", { name: "Completed actions" })).toHaveAttribute("aria-busy", "false");
  await page.reload(); await expect(completed.locator("li")).toHaveCount(0);
  expect((await readdir(join(server.bohemia, "controls", "ui-archive"))).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  const expand = page.getByRole("button", { name: "Archive (601)", exact: true });
  await expand.evaluate((node) => node.addEventListener("click", () => performance.mark("archive-expand"), { once: true }));
  await expand.click();
  const table = page.getByRole("table", { name: "Archived work items", exact: true });
  await expect(table).toBeVisible();
  const expandMs = await page.evaluate(() => performance.now() - performance.getEntriesByName("archive-expand")[0].startTime);
  expect(expandMs).toBeLessThan(200);
  await expect(table).toHaveAttribute("aria-rowcount", "602");
  expect(await table.locator("tbody tr[data-index]").count()).toBeLessThan(40);
  const viewport = page.getByRole("region", { name: "Archived work items list", exact: true });
  await viewport.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await expect(table.locator('tr[aria-rowindex="602"]')).toBeVisible();
  await table.getByRole("button", { name: "Work item", exact: true }).click();
  await viewport.evaluate((node) => { node.scrollTop = 0; });
  await expect(table.locator('tr[aria-rowindex="2"]')).toContainText("bohemia task A-1");
  console.log(`Expand 601 archived tasks: ${Math.round(expandMs)}ms.`);
  expect(await readFile(join(server.bohemia, "controls", "ui-archive.json.lock"), "utf8")).toBe("");
});

test("rejected archive requests restore tasks and expose the error without a stuck spinner", async ({ page, projectServer: server }) => {
  await page.route("**/tasks/archive", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ status: 503, json: { error: "Archive storage is unavailable." } });
  });
  await page.goto(`${server.url}/bohemia/tasks`);
  await page.getByRole("button", { name: "Completed actions" }).click();
  await page.getByRole("menuitem", { name: "Move all to archive" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Move all to archive" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toHaveText("Archive storage is unavailable.");
  await expect(page.locator('[data-status="completed"] [data-work-item-id]')).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Move all to archive" })).toBeEnabled();
});

test("an unresponsive archive endpoint times out and restores a usable board", async ({ page, projectServer: server }) => {
  await page.route("**/tasks/archive", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5500));
    await route.abort();
  });
  await page.goto(`${server.url}/bohemia/tasks`);
  await page.getByRole("button", { name: "Completed actions" }).click();
  await page.getByRole("menuitem", { name: "Move all to archive" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Move all to archive" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("Could not confirm archiving", { timeout: 7000 });
  await expect(dialog.getByRole("button", { name: "Move all to archive" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("list", { name: "Completed items", exact: true }).locator("li")).toHaveCount(1);
});
