import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";

const event = content => JSON.stringify({ type: "assistant.message", timestamp: "2026-11-03T17:00:00Z", data: { content } }) + "\n";
const longHistory = () => Array.from({ length: 140 }, (_, index) => event(`Earlier ${index} ${"x".repeat(3000)}`)).join("");
async function application(t, log) {
  const root = await mkdtemp(join(tmpdir(), "spool-history-recovery-")), project = join(root, "project");
  let server, browser, release = () => {};
  t.after(async () => { release(); await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "fixture", name: "Fixture", root: project }] }));
  for (const directory of ["agents", "logs", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, directory), { recursive: true });
  await writeFile(join(project, "agents", "engineer.md"), "# Isolated test; never launch a provider.");
  const taskFile = join(project, "queues", "incoming", "one.json");
  await writeFile(taskFile, JSON.stringify({
    id: "one", title: "History recovery", agent: "engineer", prompt: "Original work", status: "incoming",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), turns: 0,
  }));
  const file = join(project, "logs", "one.log");
  await writeFile(file, log);
  server = await startProductionApp(root);
  browser = await chromium.launch();
  const page = await browser.newPage(), origin = server.url;
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  return { page, file, taskFile, url: `${origin}/#/fixture/agents/engineer?task=one`,
    conversation: `${origin}/api/projects/fixture/tasks/one/conversation?events=1`,
    async open(stalled = false) {
      const ready = stalled
        ? page.waitForRequest(request => request.url().includes("/tasks/one/conversation?"))
        : page.waitForResponse(response => response.url().includes("/tasks/one/conversation?") && response.ok());
      await page.goto(`${origin}/#/fixture/agents/engineer?task=one`, { waitUntil: "domcontentloaded" });
      await ready;
    },
    hold() { return new Promise(resolve => { release = resolve; }); }, release() { release(); } };
}
test("message times stay fixed through metadata updates, streaming and reload", { timeout: 90000 }, async t => {
  const originalTime = "2026-11-03T17:00:00Z", streamTime = "2026-11-03T17:01:00Z";
  const line = (type, data, timestamp) => JSON.stringify({ type, data, ...(timestamp ? { timestamp } : {}) }) + "\n";
  const app = await application(t,
    line("assistant.message", { content: "Undated reply" }) +
    line("tool.execution_start", { toolName: "task_complete", toolCallId: "done",
      arguments: { summary: "Undated completion" } }) +
    line("tool.execution_complete", { toolCallId: "done", success: true }) +
    line("assistant.message", { content: "Original timestamped reply" }, originalTime));
  const { page } = app;
  await app.open();
  const reply = text => page.getByRole("article", { name: "engineer message", exact: true }).filter({ hasText: text });
  await expect(reply("Original timestamped reply").locator("time")).toHaveAttribute("datetime", originalTime);
  await expect(reply("Undated reply")).toBeVisible();
  await expect(reply("Undated reply").locator("time")).toHaveCount(0);
  await expect(reply("Undated completion")).toBeVisible();
  await expect(reply("Undated completion").locator("time")).toHaveCount(0);
  const task = JSON.parse(await readFile(app.taskFile, "utf8"));
  await writeFile(app.taskFile, JSON.stringify({ ...task, updated_at: "2026-11-03T18:00:00Z" }));
  await appendFile(app.file, line("assistant.message_delta", { content: "Streaming" }, streamTime));
  await expect(reply("Streaming").locator("time")).toHaveAttribute("datetime", streamTime);
  await expect(reply("Undated reply").locator("time")).toHaveCount(0);
  await expect(reply("Undated completion").locator("time")).toHaveCount(0);
  await expect(reply("Original timestamped reply").locator("time")).toHaveAttribute("datetime", originalTime);
  await appendFile(app.file,
    line("assistant.message_delta", { content: " finished" }, "2026-11-03T17:02:00Z") +
    line("session.turn_end", {}, "2026-11-03T17:03:00Z"));
  await expect(reply("Streaming finished")).toBeVisible();
  await expect(reply("Streaming finished").locator("time")).toHaveAttribute("datetime", streamTime);
  await page.reload();
  await expect(reply("Original timestamped reply").locator("time")).toHaveAttribute("datetime", originalTime);
  await expect(reply("Streaming finished").locator("time")).toHaveAttribute("datetime", streamTime);
  await expect(reply("Undated reply")).toBeVisible();
  await expect(reply("Undated reply").locator("time")).toHaveCount(0);
  await expect(reply("Undated completion")).toBeVisible();
  await expect(reply("Undated completion").locator("time")).toHaveCount(0);
});
test("a complete rewritten history replaces stale replies even when the file grows", { timeout: 90000 }, async t => {
  const app = await application(t, event("Old first reply") + event("Old last reply")), { page } = app;
  await app.open();
  await expect(page.getByRole("article").filter({ hasText: "Old last reply" })).toBeVisible();
  const previous = await page.evaluate(url => fetch(url).then(response => response.json()), app.conversation);
  await writeFile(app.file, JSON.stringify({ type: "ignored", data: { padding: "x".repeat(2000) } }) + "\n" + event("Fresh only reply"));
  await expect(page.getByRole("article").filter({ hasText: "Fresh only reply" })).toBeVisible();
  const fresh = await page.evaluate(url => fetch(url).then(response => response.json()), app.conversation);
  assert.equal(fresh.logId, previous.logId, "Exercise in-place replacement, not simple rotation.");
  assert.ok(fresh.cursor > previous.cursor);
  await expect(page.getByRole("article").filter({ hasText: "Old last reply" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Conversation messages", exact: true })).toHaveAttribute("data-message-count", "2");
});
test("a late older-history response cannot poison a newly rotated conversation", { timeout: 90000 }, async t => {
  const app = await application(t, longHistory());
  const { page } = app, held = app.hold();
  let started = false, released = false, attempts = 0;
  await page.route("**/api/projects/fixture/tasks/one/conversation*", async route => {
    if (!new URL(route.request().url()).searchParams.has("before")) return route.continue();
    if (++attempts === 1) return route.fulfill({ status: 503, json: { error: "Temporary interruption" } });
    const response = await route.fetch();
    started = true; await held;
    try { await route.fulfill({ response }); }
    catch (error) { if (!route.request().failure() && !page.isClosed()) throw error; }
    finally { released = true; }
  });
  await app.open();
  await expect(page.getByRole("article").filter({ hasText: "Earlier 139" })).toBeVisible();
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  await editor.fill("Keep this unsent draft across recovery.");
  await page.getByRole("region", { name: "Task conversation", exact: true }).evaluate(element => { element.scrollTop = 0; });
  await expect.poll(() => started).toBe(true);
  assert.ok(attempts >= 2, "Transient historical reads must retry without operator intervention.");
  await rename(app.file, `${app.file}.previous`);
  await writeFile(app.file, event("Recovered replacement reply"));
  await expect(page.getByRole("article").filter({ hasText: "Recovered replacement reply" })).toBeVisible();
  app.release();
  await expect.poll(() => released).toBe(true);
  await page.waitForTimeout(1200);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(editor).toHaveAttribute("aria-disabled", "false");
  await expect(editor).toHaveText("Keep this unsent draft across recovery.");
});
test("a late older page cannot restore a stale window after a same-file backlog jump", { timeout: 90000 }, async t => {
  const app = await application(t, longHistory()), { page } = app, held = app.hold();
  const task = JSON.parse(await readFile(app.taskFile, "utf8"));
  await writeFile(app.taskFile, JSON.stringify({ ...task, interaction: { messages: [{
    id: "pending-receipt", text: "Keep my queued message", status: "queued", created_at: "2026-11-03T16:59:00Z",
  }] } }));
  let started = false, released = false;
  await page.route("**/api/projects/fixture/tasks/one/conversation*", async route => {
    if (started || !new URL(route.request().url()).searchParams.has("before")) return route.continue();
    const response = await route.fetch();
    started = true; await held;
    try { await route.fulfill({ response }); }
    catch (error) { if (!route.request().failure() && !page.isClosed()) throw error; }
    finally { released = true; }
  });
  await app.open();
  await expect(page.getByRole("article").filter({ hasText: "Earlier 139" })).toBeVisible();
  const previous = await page.evaluate(url => fetch(url).then(response => response.json()), app.conversation);
  const viewport = page.getByRole("region", { name: "Task conversation", exact: true });
  await viewport.evaluate(element => { element.scrollTop = 0; });
  await expect.poll(() => started).toBe(true);
  await appendFile(app.file, JSON.stringify({ type: "ignored", data: { padding: "x".repeat(1_000_000) } }) + "\n" +
    Array.from({ length: 120 }, (_, index) => event(`Newest ${index} ${"y".repeat(3000)}`)).join(""));
  const latest = page.getByRole("article").filter({ hasText: "Newest 119" });
  await expect(latest).toBeVisible();
  const fresh = await page.evaluate(url => fetch(url).then(response => response.json()), app.conversation);
  assert.equal(fresh.logId, previous.logId);
  assert.ok(fresh.nextBefore > previous.cursor);
  app.release();
  await expect.poll(() => released).toBe(true);
  await page.waitForTimeout(1200);
  await expect(latest).toBeVisible();
  await expect(page.getByRole("list", { name: "Conversation messages", exact: true })).toHaveAttribute("data-has-more", "true");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await viewport.evaluate(element => { element.scrollTop = 0; });
  await expect(page.getByText("Keep my queued message", { exact: true })).toBeVisible();
});
test("a stalled history request times out and recovers automatically without a reload", { timeout: 90000 }, async t => {
  const app = await application(t, event("Recovered after a stalled request")), { page } = app, held = app.hold();
  let reads = 0;
  await page.route("**/api/projects/fixture/tasks/one/conversation*", async route => {
    if (++reads !== 1) return route.continue();
    await held;
    try { await route.abort("connectionreset"); }
    catch (error) { if (!route.request().failure() && !page.isClosed()) throw error; }
  });
  await app.open(true);
  await expect.poll(() => reads).toBe(1);
  await expect(page.getByRole("article").filter({ hasText: "Recovered after a stalled request" })).toBeVisible({ timeout: 15000 });
  assert.ok(reads >= 2);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
test("an invalidated historical cursor refreshes the current log instead of asking the user to recover", { timeout: 90000 }, async t => {
  const app = await application(t, longHistory()), { page } = app;
  let invalidated = false;
  await page.route("**/api/projects/fixture/tasks/one/conversation*", async route => {
    if (invalidated || !new URL(route.request().url()).searchParams.has("before")) return route.continue();
    await writeFile(app.file, event("Recovered after truncation"));
    const response = await route.fetch();
    assert.equal(response.status(), 409);
    invalidated = true;
    await route.fulfill({ response });
  });
  await app.open();
  await expect(page.getByRole("article").filter({ hasText: "Earlier 139" })).toBeVisible();
  await page.getByRole("region", { name: "Task conversation", exact: true }).evaluate(element => { element.scrollTop = 0; });
  await expect.poll(() => invalidated).toBe(true);
  await expect(page.getByRole("article").filter({ hasText: "Recovered after truncation" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
