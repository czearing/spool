import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./project-fixture";

test("ellipsis menu supports keyboard editing, confirmation cancellation and focus restoration", async ({ page, projectServer: server }) => {
  const file = join(server.bohemia, "agents", "engineer.md"), before = await readFile(file, "utf8");
  await page.goto(`${server.url}/bohemia/agents/engineer`);
  const trigger = page.getByRole("button", { name: "Agent actions", exact: true });
  await expect(page.getByRole("link", { name: "Edit prompt", exact: true })).toHaveCount(0);
  await trigger.focus(); await page.keyboard.press("ArrowDown");
  const edit = page.getByRole("menuitem", { name: "Edit prompt", exact: true });
  await expect(edit).toBeFocused();
  await expect(edit).toHaveAttribute("href", "/bohemia/agents/engineer/prompt");
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Delete agent?", exact: true });
  await expect(dialog).toContainText("engineer"); await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape"); await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
  expect(await readFile(file, "utf8")).toBe(before);
  await trigger.click(); await edit.click();
  await expect(page.getByRole("textbox", { name: "engineer prompt", exact: true })).toBeVisible();
});
test("confirmed deletion persists, removes navigation immediately and preserves all job history", async ({ page, projectServer: server }) => {
  const archive = join(server.bohemia, "queues", ".runner-archive"); await mkdir(archive);
  const records = [join(server.bohemia, "queues", "completed", "A-1.json"), join(archive, "OLD-attempt.json")];
  await writeFile(records[1], '{"id":"OLD","agent":"engineer","title":"Earlier work","status":"failed","updated_at":"2026-09-29T12:00:00Z"}');
  const before = await Promise.all(records.map((file) => readFile(file, "utf8")));
  await page.goto(`${server.url}/bohemia/agents/engineer`);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("link", { name: "engineer", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Agent actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete agent", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete agent", exact: true }).click();
  await expect(page).toHaveURL(`${server.url}/bohemia`);
  await expect(page.getByRole("link", { name: "engineer", exact: true })).toHaveCount(0);
  expect(await readdir(join(server.bohemia, "agents"))).toEqual(["reviewer.md"]);
  expect(await Promise.all(records.map((file) => readFile(file, "utf8")))).toEqual(before);
  await server.restart(); await page.reload();
  expect((await page.goto(`${server.url}/bohemia/agents/engineer`))?.status()).toBe(404);
  expect((await page.goto(`${server.url}/bohemia/agents/engineer/prompt`))?.status()).toBe(404);
});
for (const queue of ["incoming", "in_progress"]) test(`deletion reports ${queue} work without deleting the agent or its task`, async ({ page, projectServer: server }) => {
  const task = join(server.bohemia, "queues", queue, "BUSY.json"), content = '{"id":"BUSY","title":"Pending work","agent":"engineer","status":"failed"}';
  await writeFile(task, content);
  await page.goto(`${server.url}/bohemia/agents/engineer`);
  await page.getByRole("button", { name: "Agent actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete agent", exact: true }).click();
  const dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "Delete agent", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("queued or in-progress work");
  expect(await readFile(task, "utf8")).toBe(content);
  expect(await readdir(join(server.bohemia, "agents"))).toEqual(["engineer.md", "reviewer.md"]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Agent actions", exact: true })).toBeFocused();
});
test("failed deletion stays visible and can be retried without dismissing the dialog", async ({ page, projectServer: server }) => {
  let fail = true;
  await page.route("**/api/projects/bohemia/agents/engineer", (route) => route.request().method() === "DELETE" && fail
    ? route.fulfill({ status: 503, json: { error: "Storage unavailable" } }) : route.continue());
  await page.goto(`${server.url}/bohemia/agents/engineer`);
  await page.getByRole("button", { name: "Agent actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete agent", exact: true }).click();
  const dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "Delete agent", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Storage unavailable");
  fail = false; await dialog.getByRole("button", { name: "Delete agent", exact: true }).click();
  await expect(page).toHaveURL(`${server.url}/bohemia`);
});
test("DELETE rejects foreign and missing origins and cannot target another project", async ({ request, projectServer: server }) => {
  const endpoint = `${server.url}/api/projects/bohemia/agents/engineer`;
  expect((await request.delete(endpoint, { headers: { Origin: "http://foreign.example" } })).status()).toBe(403);
  expect((await request.delete(endpoint)).status()).toBe(403);
  expect((await request.delete(`${server.url}/api/projects/book-cook/agents/cook`, { headers: { Origin: server.url } })).status()).toBe(404);
  expect(await readdir(join(server.bohemia, "agents"))).toEqual(["engineer.md", "reviewer.md"]);
  expect(await readFile(join(server.bookCook, "agents", "cook.md"), "utf8")).toContain("Recipe instructions.");
});
test("mobile ellipsis menu and confirmation remain inside the viewport", async ({ page, projectServer: server }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${server.url}/bohemia/agents/engineer`);
  await page.getByRole("button", { name: "Agent actions", exact: true }).click();
  await expect(page.getByRole("menu")).toBeInViewport();
  await page.getByRole("menuitem", { name: "Delete agent", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
