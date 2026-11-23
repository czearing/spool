import { test, expect } from "./project-fixture";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

test("time sorting and bulk archive persist without removing native conversations", async ({ page, projectServer: server }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  const file = (status: string, id: string) => join(server.bohemia, "queues", status, `${id}.json`);
  const task = (id: string, status: string, time: string) => ({
    id, title: `Task ${id}`, status, updated_at: time, agent: "engineer", session_id: "original-session", prompt: "PRIVATE INSTRUCTIONS",
  });
  await writeFile(file("completed", "A-1"), JSON.stringify(task("A-1", "completed", "2026-10-01T10:00:00Z")));
  await writeFile(file("completed", "A-3"), JSON.stringify(task("A-3", "completed", "2026-10-01T11:00:00Z")));
  await writeFile(file("in_progress", "A-4"), JSON.stringify(task("A-4", "in_progress", "2026-10-01T12:00:00Z")));
  const original = await readFile(file("completed", "A-1"), "utf8");
  await page.goto(`${server.url}/bohemia/tasks`);
  const completed = page.getByRole("list", { name: "Completed items", exact: true });
  const order = () => completed.locator("[data-work-item-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-work-item-id")));
  await page.getByRole("button", { name: "Sort work items" }).click();
  await page.getByRole("menuitemradio", { name: "Updated: newest first" }).click();
  expect(await order()).toEqual(["A-3", "A-1"]);
  await page.getByRole("button", { name: "Sort work items" }).click();
  await page.getByRole("menuitemradio", { name: "Updated: oldest first" }).click();
  expect(await order()).toEqual(["A-1", "A-3"]);
  await page.getByRole("button", { name: "Search board" }).click();
  await page.getByRole("searchbox", { name: "Search work items" }).fill("A-1");
  await expect(completed.locator("li")).toHaveCount(1);
  await page.getByRole("button", { name: "Completed actions" }).click();
  await page.getByRole("menuitem", { name: "Move all to archive" }).click();
  const dialog = page.getByRole("dialog", { name: "Archive all completed tasks?" });
  await expect(dialog).toContainText("all 2 tasks");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(completed.locator("li")).toHaveCount(1);
  await page.getByRole("button", { name: "Completed actions" }).click();
  await page.getByRole("menuitem", { name: "Move all to archive" }).click();
  await dialog.getByRole("button", { name: "Move all to archive" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(completed.locator("li")).toHaveCount(0);
  await page.getByRole("button", { name: "Clear search and filters" }).click();
  await expect(page.locator("[data-work-item-id]")).toHaveCount(2);
  await page.getByRole("button", { name: "Failed actions" }).click();
  await page.getByRole("menuitem", { name: "Move all to archive" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Move all to archive" }).click();
  await expect(page.getByRole("list", { name: "Failed items", exact: true }).locator("li")).toHaveCount(0);
  expect(await readFile(file("completed", "A-1"), "utf8")).toBe(original);
  expect(errors).toEqual([]);
  await page.goto("about:blank"); await server.restart(); await page.goto(`${server.url}/bohemia/tasks`);
  await expect(page.locator("[data-work-item-id]")).toHaveCount(1);
  await page.getByRole("button", { name: "Archive (3)", exact: true }).click();
  await expect(page.getByRole("table", { name: "Archived work items", exact: true }).locator("tbody tr")).toHaveCount(3);
  await writeFile(file("completed", "A-1"), JSON.stringify(task("A-1", "completed", "2026-10-01T13:00:00Z")));
  await page.reload();
  await expect(completed.locator("li")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("archive endpoints reject cross-origin requests and nonterminal columns", async ({ request, projectServer: server }) => {
  const url = `${server.url}/api/projects/bohemia/tasks/archive`;
  expect((await request.post(url, { data: { status: "completed" } })).status()).toBe(403);
  expect((await request.post(url, { headers: { Origin: server.url }, data: { status: "in_progress" } })).status()).toBe(400);
  expect((await request.post(url, { headers: { Origin: server.url }, data: { status: "failed", taskId: "A-1" } })).status()).toBe(400);
});
