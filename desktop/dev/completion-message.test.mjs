import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";

test("completion summaries render as full chat messages without a popup or function call", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-completion-message-")), previous = { ...process.env };
  const project = { id: "fixture", name: "Fixture", root: join(root, "project") };
  let server, browser, sends = 0;
  t.after(async () => {
    await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  process.env.SPOOL_DATA_DIR = root;
  await writeFile(join(root, "connections.json"), JSON.stringify({ SPOOL_PROJECTS_FILE: join(root, "projects.json") }));
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [project] }));
  for (const folder of ["agents", "logs", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project.root, folder), { recursive: true });
  await writeFile(join(project.root, "agents", "engineer.md"), "# Fixture; never run a model.");
  const task = { id: "one", title: "Completion messages", agent: "engineer", prompt: "Original work",
    status: "completed", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), session_id: "fixture" };
  await writeFile(join(project.root, "queues", "completed", "one.json"), JSON.stringify(task));
  const summary = "Merge-conflict repair is implemented and verified locally in the isolated worktree.\n\n" +
    "**Validation:** build, lint, typecheck and all tests passed.\n\nPublication is blocked by repository ownership.";
  const event = (type, data) => JSON.stringify({ type, timestamp: "2026-11-04T10:01:00Z", data }) + "\n";
  await writeFile(join(project.root, "logs", "one.log"),
    event("assistant.message", { content: "Checking the fix." }) +
    event("tool.execution_start", { toolCallId: "done", toolName: "task_complete", arguments: { summary } }) +
    event("tool.execution_complete", { toolCallId: "done", success: true, result: "Task marked complete." }));
  server = await createServer({ root: resolve(import.meta.dirname, ".."), spoolDataDirectory: root,
    server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/api/projects/fixture/tasks/one/conversation*", async route => {
    if (route.request().method() === "POST") sends++;
    await route.continue();
  });
  await page.goto(`${origin}/#/fixture/agents/engineer?task=one`, { waitUntil: "domcontentloaded" });
  const chat = page.getByRole("region", { name: "Task conversation", exact: true });
  const messages = chat.getByRole("article", { name: "engineer message", exact: true });
  await expect(messages).toHaveCount(2, { timeout: 30000 });
  const report = messages.last();
  await expect(report).toContainText("Merge-conflict repair is implemented and verified locally in the isolated worktree.");
  await expect(report).toContainText("Publication is blocked by repository ownership.");
  await expect(report.locator("strong")).toHaveText("Validation:");
  await expect(report.getByRole("button", { name: "Copy engineer message", exact: true })).toBeVisible();
  await expect(chat.getByRole("button", { name: /task_complete/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Agent update:/ })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Agent updates", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(messages).toHaveCount(2);
  await expect(report).toContainText("Publication is blocked by repository ownership.");
  assert.equal(sends, 0, "Reading and refreshing completion messages must never send a message.");
});
