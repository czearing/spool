import { test, expect } from "./project-fixture";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const toasts = (page: import("@playwright/test").Page) => page.locator('li[data-state="open"]').filter({ hasText: "Job completed" });
test("new settled jobs toast once across route navigation; old history and edits stay quiet", async ({ page, projectServer: server }) => {
  const initial = page.waitForResponse((response) => response.url().endsWith("/bohemia/live"));
  await page.goto(`${server.url}/bohemia`); await initial;
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await expect(toasts(page)).toHaveCount(0);
  const file = join(server.bohemia, "queues", "completed", "FRESH.json");
  await writeFile(file, JSON.stringify({ id: "FRESH", title: "Fresh completed job", agent: "engineer", turns: 1,
    updated_at: new Date().toISOString(), provider: { pid: 123, token: "still-settling" } }));
  const pending = page.waitForResponse((response) => response.url().endsWith("/bohemia/live"));
  await pending; await expect(toasts(page)).toHaveCount(0);
  const task = JSON.parse(await readFile(file, "utf8")); task.provider = null;
  await writeFile(file, JSON.stringify(task));
  await expect(toasts(page)).toHaveCount(1, { timeout: 10000 });
  await expect(toasts(page)).toContainText("engineer: Fresh completed job");
  await toasts(page).hover();
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(toasts(page)).toHaveCount(1);
  await toasts(page).getByRole("button", { name: "Dismiss notification", exact: true }).click();
  await writeFile(file, JSON.stringify({ ...task, title: "Renamed after completion", updated_at: new Date().toISOString() }));
  await page.waitForResponse((response) => response.url().endsWith("/bohemia/live"));
  await expect(toasts(page)).toHaveCount(0);
  await writeFile(file, JSON.stringify({ ...task, turns: 2, error: "Runner failed after the role marked completion" }));
  await page.waitForResponse((response) => response.url().endsWith("/bohemia/live"));
  await expect(toasts(page)).toHaveCount(0);
  await writeFile(file, JSON.stringify({ ...task, turns: 2 }));
  await expect(toasts(page)).toHaveCount(1, { timeout: 10000 });
  await page.reload();
  await page.waitForResponse((response) => response.url().endsWith("/bohemia/live"));
  await expect(toasts(page)).toHaveCount(0);
});
test("completion batches queue behind three visible toasts and failures recover without replaying history", async ({ page, projectServer: server }) => {
  let failed = false;
  await page.route("**/api/projects/bohemia/live", (route) => failed
    ? route.fulfill({ status: 503, json: { error: "Offline" } }) : route.continue());
  const initial = page.waitForResponse((response) => response.url().endsWith("/bohemia/live"));
  await page.goto(`${server.url}/bohemia`); await initial;
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  failed = true;
  await expect(page.getByRole("alert").filter({ hasText: "Live activity unavailable" })).toBeVisible({ timeout: 10000 });
  for (let index = 0; index < 4; index++) await writeFile(join(server.bohemia, "queues", "completed", `NEW-${index}.json`),
    JSON.stringify({ id: `NEW-${index}`, title: `Completed item ${index}`, agent: "engineer", turns: 1 }));
  failed = false;
  await expect(toasts(page)).toHaveCount(3, { timeout: 10000 });
  await toasts(page).first().hover();
  await expect(toasts(page).first()).toContainText("Completed item 0");
  await toasts(page).first().getByRole("button", { name: "Dismiss notification" }).click();
  await expect(toasts(page)).toHaveCount(3);
  await expect(toasts(page).last()).toContainText("Completed item 3");
  for (let index = 0; index < 3; index++) await toasts(page).first().getByRole("button", { name: "Dismiss notification" }).click();
  await expect(toasts(page)).toHaveCount(0);
  await rename(join(server.bohemia, "queues", "failed", "A-2.json"), join(server.bohemia, "queues", "completed", "A-2.json"));
  await expect(toasts(page)).toHaveCount(1, { timeout: 10000 });
});
