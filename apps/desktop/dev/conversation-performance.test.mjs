import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";

test("polling and streaming do not rebuild unchanged historical tools while typing", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-conversation-performance-")), project = join(root, "project");
  let server, browser;
  t.after(async () => { await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "fixture", name: "Fixture", root: project }] }));
  for (const directory of ["agents", "logs", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, directory), { recursive: true });
  await writeFile(join(project, "agents", "engineer.md"), "# Isolated test; never launch a provider.");
  const taskFile = join(project, "queues", "incoming", "one.json"), log = join(project, "logs", "one.log");
  const task = { id: "one", title: "Conversation performance", agent: "engineer", prompt: "Original work", status: "incoming",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), turns: 0 };
  await writeFile(taskFile, JSON.stringify(task));
  const event = (type, data) => JSON.stringify({ type, timestamp: "2026-11-03T20:00:00Z", data }) + "\n";
  await writeFile(log, Array.from({ length: 400 }, (_, index) =>
    event("tool.execution_start", { toolCallId: `call-${index}`, toolName: `Read ${index}`, arguments: { path: `file-${index}.ts` } }) +
    event("tool.execution_complete", { toolCallId: `call-${index}`, success: true, result: `Read ${index}: ${"x".repeat(800)}` })).join(""));
  server = await startProductionApp(root, [{
    name: "conversation-performance-counters", enforce: "pre",
    transform(code, id) {
      code = code.replaceAll("\r\n", "\n");
      let needle, measurement;
      if (id.replaceAll("\\", "/").endsWith("/src/lib/conversation-tools.ts")) {
        needle = "export function conversationItems(data: TaskConversation): ConversationItem[] {";
        measurement = "globalThis.__spoolProfile && globalThis.__spoolProfile.builds++;";
      } else if (id.replaceAll("\\", "/").endsWith("/src/components/task-tool-call.tsx")) {
        needle = "}) {\n  return <article";
        measurement = "globalThis.__spoolProfile?.toolRenders.push(tool.id);";
      } else return;
      assert.ok(code.includes(needle), `Instrumentation no longer matches ${id}`);
      const instrumented = needle.includes("return <article")
        ? needle.replace("return <article", `${measurement}\n  return <article`) : `${needle}\n${measurement}`;
      return { code: code.replace(needle, instrumented), map: null };
    },
  }]);
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => { globalThis.__spoolProfile = { builds: 0, toolRenders: [], paints: [], longTasks: [] }; });
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.goto(`${server.url}/#/fixture/agents/engineer?task=one`,
    { waitUntil: "domcontentloaded" });
  const tool = page.getByRole("article", { name: "Tool: Read 399", exact: true });
  await expect(tool).toBeVisible();
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  await expect(editor).toHaveAttribute("aria-disabled", "false");
  await tool.getByRole("button").click();
  await expect(tool.getByText("file-399.ts", { exact: false })).toBeVisible();
  await editor.fill("Unsent draft: ");
  await page.waitForTimeout(500);
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.evaluate(() => { globalThis.__spoolProfile.builds = 0; globalThis.__spoolProfile.toolRenders = []; });
  for (let index = 0; index < 3; index++) {
    task.title = `Metadata pulse ${index}`;
    await writeFile(taskFile, JSON.stringify(task));
    await page.waitForTimeout(1200);
  }
  await expect(page.getByText("Metadata pulse 2", { exact: true }).first()).toBeVisible();
  const metadata = await page.evaluate(() => ({
    builds: globalThis.__spoolProfile.builds,
    stableToolRenders: globalThis.__spoolProfile.toolRenders.filter(id => id === "call-399").length,
  }));
  await page.evaluate(() => {
    const metrics = globalThis.__spoolProfile;
    metrics.builds = 0; metrics.toolRenders = [];
    document.querySelector('[role="textbox"]').addEventListener("keydown", () => {
      const start = performance.now();
      requestAnimationFrame(() => setTimeout(() => metrics.paints.push(performance.now() - start), 0));
    });
    new PerformanceObserver(list => { metrics.longTasks.push(...list.getEntries().map(entry => entry.duration)); })
      .observe({ type: "longtask" });
  });
  await editor.focus(); await page.keyboard.press("Control+End");
  await Promise.all([
    (async () => {
      for (let index = 0; index < 6; index++) {
        await appendFile(log, event("assistant.message_delta", { deltaContent: `Streaming update ${index}. ` }));
        await page.waitForTimeout(1100);
      }
    })(),
    page.keyboard.type("Typing should remain responsive as the agent sends updates. ".repeat(3), { delay: 30 }),
  ]);
  await expect(page.getByRole("article").filter({ hasText: "Streaming update 5." })).toBeVisible();
  await expect(editor).toContainText("Typing should remain responsive");
  await expect(tool.getByText("file-399.ts", { exact: false })).toBeVisible();
  const streaming = await page.evaluate(() => {
    const metrics = globalThis.__spoolProfile, sorted = metrics.paints.toSorted((a, b) => a - b);
    return { builds: metrics.builds, stableToolRenders: metrics.toolRenders.filter(id => id === "call-399").length,
      typingP95Ms: sorted[Math.floor(sorted.length * .95)], longTasks: metrics.longTasks };
  });
  console.log(JSON.stringify({ cpuThrottle: 4, metadata, streaming }));
  assert.equal(metadata.builds, 0, "Display-irrelevant polling metadata must not rebuild the timeline.");
  assert.equal(metadata.stableToolRenders, 0, "Unchanged historical tools must not rerender on metadata changes.");
  assert.equal(streaming.stableToolRenders, 0, "Streaming must preserve historical tool rows and handlers.");
  assert.ok(streaming.builds > 0, "Verify that streaming really updated the timeline.");
  await tool.getByRole("button").click();
  await expect(tool.getByText("file-399.ts", { exact: false })).not.toBeVisible();
  await tool.getByRole("button").click();
  await expect(tool.getByText("file-399.ts", { exact: false })).toBeVisible();
  await appendFile(log, event("tool.execution_progress", { toolCallId: "call-399", title: "Rechecked 399" }));
  const updated = page.getByRole("article", { name: "Tool: Rechecked 399", exact: true });
  await expect(updated).toBeVisible();
  await expect(updated.getByText("file-399.ts", { exact: false })).toBeVisible();
});
