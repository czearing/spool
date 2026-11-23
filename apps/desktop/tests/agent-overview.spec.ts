import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./project-fixture";

async function job(root: string, queue: string, file: string, fields: Record<string, unknown> = {}) {
  await mkdir(join(root, "queues", queue), { recursive: true });
  const path = join(root, "queues", queue, `${file}.json`);
  await writeFile(path, JSON.stringify({ id: file, agent: "engineer", title: `Work ${file}`, status: "failed",
    updated_at: "2026-09-29T20:45:00Z", prompt: "PRIVATE TASK PROMPT", ...fields }));
  return path;
}
test("agent sidebar opens searchable conversations without fetching prompts or duplicating archived attempts", async ({ page, projectServer: server }) => {
  await job(server.bohemia, "in_progress", "CURRENT");
  await job(server.bohemia, "incoming", "QUEUED");
  await job(server.bohemia, "in_progress", "OTHER", { agent: "reviewer" });
  await job(server.bohemia, "completed", "DONE");
  await job(server.bohemia, ".runner-archive", "DONE-old", { id: "DONE", updated_at: "2026-09-28T16:30:00Z" });
  const original = await readFile(join(server.bohemia, "agents", "engineer.md"), "utf8");
  await page.goto(server.url); await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("link", { name: "engineer", exact: true }).click();
  await expect(page.getByRole("heading", { name: "engineer", exact: true })).toBeVisible();
  const history = page.getByRole("navigation", { name: "Conversations", exact: true });
  await expect(history.getByRole("link")).toHaveCount(3);
  await expect(history).not.toContainText("Work OTHER");
  await expect(page.getByRole("textbox", { name: "Message agent" })).toBeVisible();
  expect(await page.content()).not.toContain("PRIVATE TASK PROMPT");
  expect(await page.content()).not.toContain("Original instructions.");
  await page.getByRole("searchbox", { name: "Search conversations" }).fill("DONE");
  await expect(history.getByRole("link")).toHaveCount(1);
  await expect(history.getByRole("link")).toHaveAccessibleName("Work DONE");
  expect(await readFile(join(server.bohemia, "agents", "engineer.md"), "utf8")).toBe(original);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});
test("live history updates status and title without resetting search or the draft", async ({ page, projectServer: server }) => {
  const current = await job(server.bohemia, "in_progress", "CURRENT");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/projects/bohemia/live", async (route) => { await gate; await route.continue(); });
  try {
    await page.goto(`${server.url}/bohemia/agents/engineer`);
    const row = page.getByRole("link", { name: "Work CURRENT", exact: true });
    await expect(row).toContainText("In progress");
    const editor = page.getByRole("textbox", { name: "Message agent" });
    await editor.fill("Keep my new conversation draft.");
    await page.getByRole("searchbox", { name: "Search conversations" }).fill("Work");
    const completed = join(server.bohemia, "queues", "completed", "CURRENT.json");
    await rename(current, completed); release();
    await expect(row).toContainText("Completed", { timeout: 10000 });
    const updated = JSON.parse(await readFile(completed, "utf8"));
    await writeFile(`${completed}.tmp`, JSON.stringify({ ...updated, title: "Work updated", updated_at: "2026-09-29T22:00:00Z" }));
    await rename(`${completed}.tmp`, completed);
    await expect(page.getByRole("link", { name: "Work updated", exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("searchbox")).toHaveValue("Work");
    await expect(editor).toHaveText("Keep my new conversation draft.");
  } finally { release(); }
});
test("Edit prompt retains autosave and returns to conversations", async ({ page, projectServer: server }) => {
  await page.goto(`${server.url}/bohemia/agents/engineer`);
  await page.getByRole("button", { name: "Agent actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit prompt", exact: true }).click();
  await expect(page).toHaveURL(`${server.url}/bohemia/agents/engineer/prompt`);
  await page.getByRole("textbox", { name: "engineer prompt", exact: true }).fill("Saved before returning to conversations");
  await page.getByRole("main").getByRole("link", { name: "engineer", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message agent" })).toBeVisible();
  expect(await readFile(join(server.bohemia, "agents", "engineer.md"), "utf8")).toContain("Saved before returning to conversations");
});
test("empty and unknown agents are distinct, with project-scoped history", async ({ page, projectServer: server }) => {
  await job(server.bohemia, "completed", "ENGINEER");
  await page.goto(`${server.url}/bohemia/agents/reviewer`);
  await expect(page.getByText("No conversations yet.", { exact: true })).toBeVisible();
  await writeFile(server.registry, JSON.stringify({ version: 1, projects: [
    { id: "bohemia", name: "Bohemia", root: server.bohemia }, { id: "book-cook", name: "Book Cook", root: server.bookCook },
  ] }));
  await writeFile(join(server.bookCook, "agents", "engineer.md"), "# Engineer");
  await page.goto(`${server.url}/book-cook/agents/engineer`);
  await expect(page.getByText("No conversations yet.", { exact: true })).toBeVisible();
  expect((await page.goto(`${server.url}/bohemia/agents/unknown`))?.status()).toBe(404);
});
test("conversation metadata renders without JavaScript", async ({ browser, projectServer: server }) => {
  await job(server.bohemia, "completed", "DONE");
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage(); await page.goto(`${server.url}/bohemia/agents/engineer`);
    await expect(page.getByRole("navigation", { name: "Conversations", exact: true })).toContainText("Work DONE");
    await expect(page.getByRole("button", { name: "Agent actions", exact: true })).toBeVisible();
  } finally { await context.close(); }
});
test("mobile conversation history is bounded and closes after selection without viewport overflow", async ({ page, projectServer: server }) => {
  await Promise.all(Array.from({ length: 30 }, (_, i) => job(server.bohemia, "completed", `JOB-${i}`)));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${server.url}/bohemia/agents/engineer`);
  await page.getByRole("button", { name: "Open conversations", exact: true }).click();
  const history = page.getByRole("navigation", { name: "Conversations", exact: true }).filter({ visible: true });
  expect(await history.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await history.getByRole("link", { name: "Work JOB-0", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open conversations" })).toHaveAttribute("data-state", "closed");
  await expect(page.getByRole("region", { name: "Task conversation" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const theme of ["light", "dark"]) test(`Storybook agent conversations use shared controls in ${theme} mode`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`http://127.0.0.1:6006/iframe.html?id=agents-overview--default&viewMode=story&globals=theme:${theme}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  const editor = page.getByRole("textbox", { name: "Message agent" });
  await expect(editor).toBeVisible();
  const greeting = await page.getByRole("heading", { name: "What would you like to work on?" }).boundingBox();
  expect(greeting!.y).toBeGreaterThan(200);
  await editor.fill("Outline a new chapter");
  await editor.press("Enter");
  const history = page.getByRole("navigation", { name: "Conversations", exact: true });
  await expect(history.getByRole("link", { name: "Outline a new chapter", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "Task conversation" })).toContainText("Outline a new chapter");
  expect((await new AxeBuilder({ page }).include("#storybook-root").withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open conversations" }).click();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What would you like to work on?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open conversations" })).toHaveAttribute("data-state", "closed");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
