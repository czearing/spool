import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";

test("agent blockers stay neutral across follow-ups while real execution errors remain visible", { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-agent-blocker-")), project = join(root, "project");
  let app, browser, writes = 0;
  t.after(async () => { await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1,
    projects: [{ id: "fixture", name: "Fixture", root: project }] }));
  for (const folder of ["agents", "logs", "controls", ...["incoming", "in_progress", "completed", "failed"].map(queue => join("queues", queue))])
    await mkdir(join(project, folder), { recursive: true });
  await writeFile(join(project, "agents", "engineer.md"), "# Isolated display fixture; never launch a provider.");
  const error = "Local repair verified, but publication is blocked by an unavailable tool.";
  const task = { id: "one", title: "Existing agent conversation", agent: "engineer", prompt: "Original work",
    status: "failed", error, failure_origin: { source: "agent", error },
    session_id: "saved-fixture", updated_at: "2026-11-20T21:47:52Z" };
  const file = join(project, "queues", "failed", "one.json"), log = join(project, "logs", "one.log");
  const original = JSON.stringify(task);
  await writeFile(file, original);
  const event = (type, data) => JSON.stringify({ type, timestamp: task.updated_at, data }) + "\n";
  await writeFile(log, event("tool.execution_start", { toolCallId: "status",
    toolName: "spool-spool_update_task_status", arguments: { status: "failed", error } }) +
    event("tool.execution_complete", { toolCallId: "status", success: true,
      result: { content: "Task status updated to failed" } }) +
    event("assistant.message", { content: "The agent explained its blocker here." }));
  app = await startProductionApp(root);
  browser = await chromium.launch();
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/api/**", async route => {
    if (!["GET", "HEAD"].includes(route.request().method())) writes++;
    if (route.request().url().includes("/conversation")) await writeFile(join(project, "controls", "capabilities.json"),
      JSON.stringify({ version: 1, interactive: true, messageContinuationVersion: 1, updatedAt: new Date().toISOString() }));
    await route.fallback();
  });
  await page.goto(`${app.url}/#/fixture/agents/engineer?task=one`, { waitUntil: "domcontentloaded" });
  const thread = page.getByRole("region", { name: "Task conversation", exact: true });
  const history = page.getByRole("navigation", { name: "Conversations", exact: true });
  await expect(thread).toContainText("The agent explained its blocker here.");
  await expect(thread.getByRole("alert")).toHaveCount(0);
  await expect(history.getByText("Blocked", { exact: true })).toBeVisible();
  await expect(history.getByText("Failed", { exact: true })).toHaveCount(0);
  for (const content of ["First subsequent answer", "Second subsequent answer"]) {
    await writeFile(log, event("assistant.message", { content }), { flag: "a" });
    await expect(thread).toContainText(content);
    await expect(thread.getByRole("alert")).toHaveCount(0);
  }
  await page.reload();
  await expect(thread).toContainText("Second subsequent answer");
  await expect(thread.getByRole("alert")).toHaveCount(0);
  assert.equal(await readFile(file, "utf8"), original);
  await page.goto(`${app.url}/#/fixture/tasks`);
  const lane = page.getByRole("region", { name: "Blocked", exact: true });
  await expect(lane.getByRole("button", { name: "Open conversation: Existing agent conversation" })).toBeVisible();
  await expect(lane).toHaveAttribute("data-tone", "waiting");
  await writeFile(file, JSON.stringify({ ...task, error: "Agent exited with code 7" }));
  await page.goto(`${app.url}/#/fixture/agents/engineer?task=one`);
  await expect(thread.getByRole("alert")).toHaveText("Agent exited with code 7");
  assert.equal(writes, 0, "Display correction must not send messages or alter task outcomes.");
  assert.deepEqual(errors, []);
});
