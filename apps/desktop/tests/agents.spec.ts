import { test, expect } from "./project-fixture";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";

test("Agents starts collapsed and the centered document has contextual tools, not a save button", async ({ page, projectServer: server }) => {
  await page.setViewportSize({ width: 1440, height: 960 }); await page.goto(server.url);
  const accordion = page.getByRole("button", { name: "Agents", exact: true });
  await expect(accordion).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("link", { name: "engineer", exact: true })).toBeHidden();
  await accordion.focus(); await page.keyboard.press("Enter");
  await page.getByRole("link", { name: "engineer", exact: true }).click();
  await page.getByRole("button", { name: "Agent actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit prompt", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "engineer prompt", exact: true });
  await expect(editor).toContainText("Original instructions.");
  await expect(page.getByRole("button", { name: "Save prompt", exact: true })).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "Text formatting", exact: true })).toHaveCount(0);
  const bounds = (await editor.boundingBox())!, main = (await page.getByRole("main").boundingBox())!;
  expect(Math.abs(bounds.x + bounds.width / 2 - (main.x + main.width / 2))).toBeLessThan(1);
  expect(bounds.width).toBeLessThanOrEqual(768);
  await page.getByRole("button", { name: "Editing tools", exact: true }).click();
  await expect(page.getByRole("toolbar", { name: "Text formatting", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});
test("typing autosaves the last keystroke to the real file without touching configuration or tasks", async ({ page, projectServer: server }) => {
  const file = join(server.bohemia, "agents", "engineer.md"), before = await readFile(file, "utf8");
  const task = join(server.bohemia, "queues", "completed", "A-1.json"), originalTask = await readFile(task, "utf8");
  await page.goto(`${server.url}/bohemia/agents/engineer/prompt`);
  const editor = page.getByRole("textbox", { name: "engineer prompt", exact: true });
  await editor.click(); await editor.press("Control+End"); await page.keyboard.press("ArrowDown"); await page.keyboard.type(" Last character!");
  await expect.poll(() => readFile(file, "utf8")).toContain("Last character!");
  await expect(page.getByRole("status", { name: "Prompt save status", exact: true })).toHaveText("All changes saved");
  const saved = await readFile(file, "utf8");
  expect(saved.split("# Engineer")[0]).toBe(before.split("# Engineer")[0]);
  expect(saved.replaceAll("\r\n", "")).not.toContain("\n"); expect(saved).not.toContain("```javascript");
  expect(await readFile(task, "utf8")).toBe(originalTask);
  await server.restart(); await page.reload(); await expect(editor).toContainText("Last character!");
});
test("sidebar navigation flushes pending edits instead of asking to discard normal typing", async ({ page, projectServer: server }) => {
  await page.goto(`${server.url}/bohemia/agents/engineer/prompt`);
  await page.getByRole("textbox", { name: "engineer prompt", exact: true }).fill("Save before navigating");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("link", { name: "reviewer", exact: true }).click();
  await expect(page.getByRole("heading", { name: "reviewer", exact: true })).toBeVisible();
  expect(await readFile(join(server.bohemia, "agents", "engineer.md"), "utf8")).toContain("Save before navigating");
  await expect(page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true })).toHaveCount(0);
});
test("external prompt changes update a clean editor without navigation or a page reload", async ({ page, projectServer: server }) => {
  await page.goto(`${server.url}/bohemia/agents/engineer/prompt`);
  const editor = page.getByRole("textbox", { name: "engineer prompt", exact: true });
  await expect(editor).toContainText("Original instructions.");
  await writeFile(join(server.bohemia, "agents", "engineer.md"), "---\nmodel: external\n---\nChanged on disk\n");
  await expect(editor).toHaveText("Changed on disk", { timeout: 8000 });
  await expect(page.getByRole("status", { name: "Prompt save status", exact: true })).toHaveText("All changes saved");
});
test("failed autosaves preserve the draft and recover through retry without disabling the editor", async ({ page, projectServer: server }) => {
  let failed = true;
  await page.route("**/api/projects/bohemia/agents/engineer", (route) => route.request().method() === "PUT" && failed
    ? route.fulfill({ status: 503, json: { error: "Write unavailable" } }) : route.continue());
  await page.goto(`${server.url}/bohemia/agents/engineer/prompt`);
  const editor = page.getByRole("textbox", { name: "engineer prompt", exact: true });
  await editor.fill("Draft stays editable");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Write unavailable");
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.fill("Latest preserved draft"); failed = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => readFile(join(server.bohemia, "agents", "engineer.md"), "utf8")).toContain("Latest preserved draft");
});
test("conflicts never overwrite external changes and reload requires explicit confirmation", async ({ page, projectServer: server }) => {
  await page.route("**/api/projects/bohemia/agents/engineer", async (route) => {
    if (route.request().method() === "PUT") {
      await writeFile(join(server.bohemia, "agents", "engineer.md"), "---\nmodel: latest\n---\nExternal version\n");
    }
    await route.continue();
  });
  await page.goto(`${server.url}/bohemia/agents/engineer/prompt`);
  const editor = page.getByRole("textbox", { name: "engineer prompt", exact: true });
  await editor.fill("My unsaved draft");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("changed");
  await expect(editor).toContainText("My unsaved draft");
  await page.getByRole("button", { name: "Reload latest", exact: true }).click();
  await page.getByRole("dialog", { name: "Reload the latest prompt?", exact: true }).getByRole("button", { name: "Reload latest", exact: true }).click();
  await expect(editor).toContainText("External version");
});
test("mobile document and collapsed sidebar remain within the viewport", async ({ page, projectServer: server }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(server.url);
  await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("link", { name: "engineer", exact: true }).click();
  await page.getByRole("button", { name: "Agent actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit prompt", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "engineer prompt", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("prompt API still rejects foreign origins and stale revisions", async ({ request, projectServer: server }) => {
  const file = join(server.bohemia, "agents", "engineer.md"), before = await readFile(file, "utf8");
  const endpoint = `${server.url}/api/projects/bohemia/agents/engineer`, data = { prompt: "Forbidden", revision: "a".repeat(64) };
  expect((await request.put(endpoint, { data, headers: { Origin: "http://foreign.example" } })).status()).toBe(403);
  expect((await request.put(endpoint, { data, headers: { Origin: server.url } })).status()).toBe(409);
  const read = await request.get(endpoint); expect(read.status()).toBe(200); expect(read.headers()["cache-control"]).toBe("no-store");
  expect(await readFile(file, "utf8")).toBe(before);
});
test("typing during a delayed save persists the newest text in order and never locks the editor", async ({ page, projectServer: server }) => {
  let release!: () => void, started!: () => void, writes = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; }), firstWrite = new Promise<void>((resolve) => { started = resolve; });
  await page.route("**/api/projects/bohemia/agents/engineer", async (route) => {
    if (route.request().method() !== "PUT") { await route.continue(); return; }
    if (++writes === 1) {
      const response = await route.fetch(); started(); await gate; await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await page.goto(`${server.url}/bohemia/agents/engineer/prompt`);
    const editor = page.getByRole("textbox", { name: "engineer prompt", exact: true });
    await editor.fill("First version"); await firstWrite;
    await expect(editor).toHaveAttribute("contenteditable", "true"); await editor.fill("Newest version with final keystroke!");
    release();
    await expect.poll(() => readFile(join(server.bohemia, "agents", "engineer.md"), "utf8")).toContain("Newest version with final keystroke!");
    await expect(page.getByRole("status", { name: "Prompt save status", exact: true })).toHaveText("All changes saved");
    expect(writes).toBe(2);
  } finally { release(); }
});
test("closing a page flushes its most recent edit to disk", async ({ page, projectServer: server }) => {
  await page.goto(`${server.url}/bohemia/agents/engineer/prompt`);
  await page.getByRole("textbox", { name: "engineer prompt", exact: true }).fill("Final edit before closing");
  page.on("dialog", (dialog) => dialog.accept());
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => readFile(join(server.bohemia, "agents", "engineer.md"), "utf8"), { timeout: 8000 })
    .toContain("Final edit before closing");
});
