import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";
import { instrumentation, observeChatPerformance, chatMeasurements, measureChatScroll, assertChatMetrics, assertRowsDoNotOverlap } from "./chat-performance-measurements.mjs";

test("idle polling leaves chat untouched while streaming, history and drafts remain live", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-chat-performance-")), project = join(root, "project");
  let app, browser, heartbeat, heartbeatError, polls = 0, sends = 0;
  const transfers = [], pendingTransfers = [];
  let heartbeatWork = Promise.resolve();
  t.after(async () => {
    clearInterval(heartbeat);
    await heartbeatWork;
    await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true });
  });
  for (const directory of ["agents", "logs", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, directory), { recursive: true });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "fixture", name: "Fixture", root: project }] }));
  await writeFile(join(project, "agents", "engineer.md"), "# Isolated test; never launch a provider.");
  const taskFile = join(project, "queues", "in_progress", "one.json");
  const task = { id: "one", title: "Active chat performance", agent: "engineer", prompt: "Original work", status: "in_progress",
    session_id: "fixture", created_at: "2026-11-04T10:00:00Z", updated_at: "2026-11-04T10:01:00Z",
    interaction: { phase: "running" }, turns: 0 };
  await writeFile(taskFile, JSON.stringify(task));
  await writeFile(join(project, "queues", "completed", "two.json"),
    JSON.stringify({ ...task, id: "two", title: "Second chat", status: "completed", prompt: "Other work" }));
  const refresh = async () => {
    const file = join(project, "controls", "capabilities.json");
    await writeFile(`${file}.tmp`, JSON.stringify({
      version: 1, interactive: true, messageContinuationVersion: 1, updatedAt: new Date().toISOString(),
    }));
    await rename(`${file}.tmp`, file);
  };
  await refresh();
  heartbeat = setInterval(() => {
    heartbeatWork = heartbeatWork.then(refresh).catch(error => { heartbeatError = error; });
  }, 2000);
  const event = (type, content, timestamp = "2026-11-04T10:01:00Z") =>
    JSON.stringify({ type, timestamp, data: { content } }) + "\n";
  const log = join(project, "logs", "one.log");
  await writeFile(log, Array.from({ length: 500 }, (_, index) =>
    event("assistant.message", `History ${index}: **Verified changes** preserve the conversation.\n\n- First result\n- Second result\n\n\`const result = ${index};\``)).join("") +
    event("assistant.message", "Invalid timestamp example", "invalid") +
    event("assistant.message_delta", "Live reply"));
  app = await startProductionApp(root, [instrumentation]);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", error => console.error(error));
  await observeChatPerformance(page);
  page.on("response", response => {
    if (response.url().includes("/tasks/one/conversation?") && (response.ok() || response.status() === 304)) {
      polls++;
      pendingTransfers.push((async () => {
        transfers.push({ status: response.status(), bytes: response.status() === 304 ? 0 : (await response.body()).length });
      })());
    }
    if (response.status() >= 400) console.error("API response:", response.status(), response.url());
  });
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/api/projects/fixture/tasks/*/conversation*", async route => {
    if (route.request().method() === "POST") sends++;
    await route.continue();
  });
  await page.goto(`${app.url}/#/fixture/agents/engineer?task=one`, { waitUntil: "domcontentloaded" });
  const chat = page.getByRole("region", { name: "Task conversation", exact: true });
  const live = chat.getByRole("article").filter({ hasText: "Live reply" });
  await expect(live).toHaveAttribute("data-status", "generating", { timeout: 20000 });
  await expect(chat.getByText("Invalid timestamp example", { exact: true })).toBeVisible();
  await expect(chat.getByRole("article").filter({ hasText: "Invalid timestamp example" }).locator("time")).toHaveCount(0);
  const expectedTime = await page.evaluate(() => {
    const date = new Date("2026-11-04T10:01:00Z");
    return { title: date.toLocaleString(), label: date.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }) };
  });
  await expect(live.locator("time")).toHaveAttribute("title", expectedTime.title);
  await expect(live.locator("time")).toHaveText(expectedTime.label);
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const { reset, sample } = chatMeasurements(page);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => globalThis.__chatPerf.scrolling === false);
  await settle();
  await Promise.all(pendingTransfers);
  transfers.length = 0;
  await reset();
  const start = polls;
  for (let index = 0; index < 2; index++)
    await page.waitForResponse(response => response.url().includes("/tasks/one/conversation?") &&
      (response.ok() || response.status() === 304), { timeout: 10000 });
  await settle();
  await Promise.all(pendingTransfers);
  const idle = { ...await sample(), polls: polls - start, responseBodyBytes: transfers.reduce((sum, item) => sum + item.bytes, 0),
    notModified: transfers.filter(item => item.status === 304).length };
  await reset();
  let reply = "Live reply";
  for (let index = 0; index < 6; index++) {
    const chunk = ` chunk-${index}`;
    reply += chunk;
    await appendFile(log, event("assistant.message_delta", chunk));
    await expect(live).toContainText(reply);
  }
  await settle();
  const streaming = await sample();
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  await editor.fill("Keep my draft");
  await reset();
  await editor.pressSequentially(" while updates arrive", { delay: 30 });
  reply += " final chunk";
  await appendFile(log, event("assistant.message_delta", " final chunk"));
  await expect(live).toContainText("final chunk");
  await expect(editor).toContainText("Keep my draft while updates arrive");
  await expect(editor).toBeFocused();
  await settle();
  const typing = await sample();
  const time = live.locator("time");
  await expect(time).toHaveAttribute("title", expectedTime.title);
  const scrolling = await measureChatScroll({ chat, session, settle, reset, sample });
  const anchor = await chat.evaluate(element => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll("[data-message-id]")]
      .find(row => row.getBoundingClientRect().top >= top);
    return { id: row.dataset.messageId, top: row.getBoundingClientRect().top };
  });
  const previousView = await page.evaluate(() => globalThis.__chatPerf.view);
  reply += " while reading";
  await appendFile(log, event("assistant.message_delta", " while reading"));
  await page.waitForFunction(previous => globalThis.__chatPerf.view > previous, previousView);
  await settle();
  const retained = await chat.locator(`[data-message-id="${anchor.id}"]`).boundingBox();
  assert.ok(retained && Math.abs(retained.y - anchor.top) < 2, "Live replies must not move the history being read.");
  await expect(page.getByRole("button", { name: "Latest messages", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Latest messages", exact: true }).click();
  await expect(live).toBeVisible();
  await expect(editor).toContainText("Keep my draft while updates arrive");
  await appendFile(log, event("assistant.message", reply) + event("session.idle", ""));
  await expect(live).toHaveAttribute("data-status", "complete");
  const rowsDoNotOverlap = () => assertRowsDoNotOverlap(chat, settle);
  await rowsDoNotOverlap();
  const longReply = `A long answer to read.\n\n${"This paragraph keeps the answer taller than the viewport.\n\n".repeat(80)}`;
  await appendFile(log, event("assistant.message", longReply));
  const large = chat.getByRole("article").filter({ hasText: "A long answer to read." });
  await expect(large).toBeVisible();
  const atBottom = () => chat.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
  await expect.poll(atBottom).toBeLessThan(2);
  const range = () => chat.locator("[data-message-id]").evaluateAll(rows => rows.map(row => row.dataset.messageId));
  const previousRange = await range();
  await chat.evaluate(element => { element.scrollTop -= 120; });
  await expect(page.getByRole("button", { name: "Latest messages", exact: true })).toBeVisible();
  assert.deepEqual(await range(), previousRange, "Exercise scrolling within one tall row without changing the virtual range.");
  await page.getByRole("button", { name: "Latest messages", exact: true }).click();
  await expect.poll(atBottom).toBeLessThan(2);
  await appendFile(log, [
    { type: "tool.execution_start", data: { toolCallId: "geometry", toolName: "Check geometry", arguments: { path: "fixture.ts" } } },
    { type: "tool.execution_complete", data: { toolCallId: "geometry", success: true, result: "Verified output\n".repeat(30) } },
  ].map(entry => JSON.stringify({ timestamp: "2026-11-04T10:02:00Z", ...entry }) + "\n").join(""));
  const tool = chat.getByRole("article", { name: "Tool: Check geometry", exact: true });
  await expect(tool).toBeVisible();
  await tool.getByRole("button").click();
  await expect(tool.getByText("Verified output", { exact: false })).toBeVisible();
  await expect.poll(atBottom).toBeLessThan(2);
  await rowsDoNotOverlap();
  await tool.getByRole("button").click();
  await expect(tool.getByText("Verified output", { exact: false })).not.toBeVisible();
  await expect.poll(atBottom).toBeLessThan(2);
  clearInterval(heartbeat); await heartbeatWork;
  await writeFile(join(project, "controls", "capabilities.json"), JSON.stringify({
    version: 1, interactive: false, messageContinuationVersion: 1, updatedAt: new Date().toISOString(),
  }));
  await expect(editor).toHaveAttribute("aria-disabled", "true");
  await expect(editor).toHaveText("Keep my draft while updates arrive");
  await refresh();
  await expect(editor).toHaveAttribute("aria-disabled", "false");
  heartbeat = setInterval(() => {
    heartbeatWork = heartbeatWork.then(refresh).catch(error => { heartbeatError = error; });
  }, 2000);
  const history = page.getByRole("navigation", { name: "Conversations", exact: true });
  await history.getByRole("link", { name: "Second chat", exact: true }).click();
  await expect(chat).toContainText("Other work");
  await expect(editor).toHaveText("");
  await history.getByRole("link", { name: "Active chat performance", exact: true }).click();
  await expect(chat).toContainText("while reading");
  await expect(editor).toHaveText("Keep my draft while updates arrive");
  const metrics = { count: 500, cpuThrottle: 4, idle, streaming, typing, scrolling };
  console.log(JSON.stringify(metrics));
  if (process.env.SPOOL_CHAT_PERF_REPORT) await writeFile(process.env.SPOOL_CHAT_PERF_REPORT, JSON.stringify(metrics, null, 2));
  assertChatMetrics(metrics, heartbeatError, sends);
});
