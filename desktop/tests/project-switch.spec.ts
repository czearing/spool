import { test, expect, workItemTotal } from "./project-fixture";
import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

test("configured projects switch routes without mixing queue data", async ({ page, projectServer: server }) => {
  await writeFile(server.registry, JSON.stringify({ version: 1, projects: [
    { id: "bohemia", name: "Bohemia", root: server.bohemia },
    { id: "book-cook", name: "Book Cook", root: server.bookCook },
  ] }));
  const total = workItemTotal(page);
  await page.goto(`${server.url}/bohemia`); await expect(total).toHaveText("2 work items");
  await page.getByRole("link", { name: "Tasks", exact: true }).click(); await expect(page.locator("[data-work-item-id]")).toHaveCount(2);
  const choose = async (name: string) => {
    await page.getByRole("button", { name: /^Switch project,/ }).click();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
  };
  await choose("Book Cook"); await expect(page).toHaveURL(`${server.url}/book-cook/tasks`);
  await expect(page.locator("[data-work-item-id]")).toHaveCount(3);
  expect(await page.locator("[data-work-item-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-work-item-id")).sort())).toEqual(["B-1", "B-2", "B-3"]);
  expect(await page.content()).not.toContain("PRIVATE TASK PROMPT"); expect(await page.content()).not.toContain(server.root);
  await page.getByRole("link", { name: "Home", exact: true }).click(); await expect(total).toHaveText("3 work items");
  await page.reload(); await expect(total).toHaveText("3 work items");
  await page.goBack(); await expect(page).toHaveURL(`${server.url}/book-cook/tasks`);
  await page.goBack(); await expect(page).toHaveURL(`${server.url}/bohemia/tasks`);
  await expect(page.getByRole("button", { name: "Switch project, Bohemia" })).toBeVisible();
  await expect(page.locator("[data-work-item-id]")).toHaveCount(2);
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await choose("Book Cook"); await expect(page).toHaveURL(`${server.url}/book-cook`); await expect(total).toHaveText("3 work items");
  await rename(join(server.bookCook, "queues", "incoming", "B-1.json"), join(server.bookCook, "queues", "completed", "B-1.json"));
  await page.reload(); await expect(total).toHaveText("3 work items");
});
