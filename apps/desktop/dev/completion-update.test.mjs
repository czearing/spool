import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProductionApp } from "./production-app.mjs";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("completion summaries appear as full agent messages in chat without a popup or replay", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-completion-update-")), project = join(root, "project");
  let app, browser, sends = 0;
  t.after(async () => { await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "fixture", name: "Fixture", root: project }] }));
  for (const directory of ["agents", "logs", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, directory), { recursive: true });
  await writeFile(join(project, "agents", "engineer.md"), "# Isolated test; never launch a provider.");
  const task = { id: "one", title: "Completion updates", agent: "engineer", prompt: "Original work", status: "completed", session_id: "fixture-session",
    created_at: "2026-11-04T10:00:00Z", updated_at: "2026-11-04T10:01:00Z", turns: 0 };
  const taskFile = join(project, "queues", "completed", "one.json"), log = join(project, "logs", "one.log");
  await writeFile(taskFile, JSON.stringify(task));
  await writeFile(join(project, "queues", "completed", "two.json"), JSON.stringify({ ...task, id: "two", title: "No updates" }));
  const event = (type, data) => JSON.stringify({ type, timestamp: "2026-11-04T10:01:00Z", data }) + "\n";
  const complete = (id, summary) =>
    event("tool.execution_start", { toolCallId: id, toolName: "task_complete", arguments: { summary } }) +
    event("tool.execution_complete", { toolCallId: id, success: true, result: "Task marked complete." });
  const older = "Earlier investigation found the conflicting checkout.";
  const summary = "Merge-conflict repair is implemented and verified locally in the isolated worktree.\n\n" +
    "**Validation:** build, lint, typecheck and all tests passed.\n\n" +
    "Publication is blocked by repository ownership. The remote conflict remains unresolved.";
  const ordinary = "Ordinary chat stays in the conversation with its complete explanation, even when it exceeds ten words.";
  const originalLog = event("assistant.message", { content: ordinary }) +
    complete("older", older) + complete("latest", summary);
  await writeFile(log, originalLog);
  app = await startProductionApp(root);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pending = new Set();
  page.on("request", request => pending.add(request.url()));
  page.on("requestfinished", request => pending.delete(request.url()));
  page.on("requestfailed", request => pending.delete(request.url()));
  page.on("pageerror", error => console.error(error));
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/api/projects/fixture/tasks/*/conversation*", async route => {
    if (route.request().method() === "POST") sends++;
    await route.continue();
  });
  const url = `${app.url}/#/fixture/agents/engineer?task=`;
  try { await page.goto(`${url}one`, { waitUntil: "domcontentloaded" }); }
  catch (error) { console.error("Unfinished startup requests:", [...pending]); throw error; }
  const chat = page.getByRole("region", { name: "Task conversation", exact: true });
  const messages = chat.getByRole("article", { name: "engineer message", exact: true });
  await expect(messages).toHaveCount(3, { timeout: 20000 });
  await expect(chat).toContainText(ordinary);
  await expect(messages.nth(1)).toContainText(older);
  const report = messages.nth(2);
  await expect(report).toContainText("Merge-conflict repair is implemented and verified locally in the isolated worktree.");
  await expect(report).toContainText("Publication is blocked by repository ownership.");
  await expect(report.locator("strong")).toHaveText("Validation:");
  await expect(report.getByRole("button", { name: "Copy engineer message", exact: true })).toBeVisible();
  await expect(chat.getByRole("button", { name: /task_complete/ })).toHaveCount(0);
  const trigger = page.getByRole("button", { name: /^Agent update:/ });
  const details = page.getByRole("dialog", { name: "Agent updates", exact: true });
  await expect(trigger).toHaveCount(0);
  await expect(details).toHaveCount(0);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const audit = await new AxeBuilder({ page }).include('[aria-label="Task conversation"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    assert.deepEqual(audit.violations, [], `${theme} completion messages must remain accessible.`);
  }
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  await editor.fill("Keep my unsent draft.");
  await appendFile(log, event("tool.execution_start", { toolCallId: "new", toolName: "task_complete",
    arguments: { summary: "Publishing is blocked by checkout ownership." } }));
  const newMessage = messages.filter({ hasText: "Publishing is blocked by checkout ownership." });
  await expect(newMessage).toHaveCount(1);
  await expect(newMessage).toContainText("Unconfirmed");
  await expect(details).toHaveCount(0);
  await expect(editor).toBeFocused();
  await expect(editor).toContainText("Keep my unsent draft.");
  await appendFile(log, event("tool.execution_complete", { toolCallId: "new", success: false, result: "Completion rejected." }));
  await expect(newMessage).toHaveAttribute("data-status", "failed");
  await expect(newMessage.getByRole("alert")).toHaveText("Completion rejected.");
  await expect(newMessage).toHaveCount(1);
  await expect(editor).toBeFocused();
  await expect(editor).toContainText("Keep my unsent draft.");
  await page.setViewportSize({ width: 375, height: 720 });
  await newMessage.scrollIntoViewIfNeeded();
  const bounds = await newMessage.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 376, "The message must fit narrow windows.");
  await page.emulateMedia({ forcedColors: "active" });
  await expect(newMessage.getByRole("alert")).toBeVisible();
  await page.emulateMedia({ forcedColors: "none" });
  await page.reload();
  await expect(newMessage).toHaveAttribute("data-status", "failed");
  await expect(newMessage).toHaveCount(1);
  await expect(trigger).toHaveCount(0);
  await expect(details).toHaveCount(0);
  await page.goto(`${url}two`);
  await expect(page.getByText("No updates", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(trigger).toHaveCount(0);
  assert.equal(sends, 0, "Rendering, refreshing and navigating completion messages must never send a message.");
  assert.deepEqual(JSON.parse(await readFile(taskFile, "utf8")), task);
  assert.ok((await readFile(log, "utf8")).startsWith(originalLog), "The original report must remain unchanged.");
});
