import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";

test("failed sends stay at their original time and use accessible semantic danger styling", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-failed-message-order-")), project = join(root, "project");
  let server, browser, sends = 0;
  t.after(async () => { await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "fixture", name: "Fixture", root: project }] }));
  for (const directory of ["agents", "logs", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, directory), { recursive: true });
  await writeFile(join(project, "agents", "engineer.md"), "# Isolated test; never launch a provider.");
  const text = "Why did we choose that instead of caching? How did caching go?";
  const error = "Original conversation ownership changed while its message waited";
  const failed = (id, time) => ({ id, text, status: "failed", created_at: `2026-11-03T15:${time}:00Z`, error });
  const task = { id: "one", title: "Failed-message chronology", agent: "engineer", prompt: "Original work", status: "completed",
    created_at: "2026-11-03T15:20:00Z", updated_at: "2026-11-03T15:35:00Z", turns: 0,
    interaction: { messages: [failed("later", "29"), failed("first", "25"), failed("second", "25")] } };
  const taskFile = join(project, "queues", "completed", "one.json");
  await writeFile(taskFile, JSON.stringify(task));
  const event = (type, time, data) => JSON.stringify({ type, timestamp: `2026-11-03T15:${time}:00Z`, data }) + "\n";
  await writeFile(join(project, "logs", "one.log"),
    event("assistant.message", "24", { content: "Before the failed messages." }) +
    event("tool.execution_start", "26", { toolCallId: "read", toolName: "Read cache", arguments: { path: "cache.ts" } }) +
    event("tool.execution_complete", "27", { toolCallId: "read", success: true, result: "Read complete." }) +
    event("assistant.message", "30", { content: "After all failed messages." }));
  server = await createServer({ root: resolve(import.meta.dirname, ".."), spoolDataDirectory: root,
    server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 2400 } });
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/api/projects/fixture/tasks/one/conversation*", async route => {
    if (route.request().method() === "POST") sends++;
    await route.continue();
  });
  const initial = await page.request.get(`http://127.0.0.1:${server.httpServer.address().port}/api/projects/fixture/tasks/one/conversation?events=1`);
  assert.ok(initial.ok(), await initial.text());
  assert.equal((await initial.json()).task.interaction.messages.length, 3);
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/fixture/agents/engineer?task=one`,
    { waitUntil: "domcontentloaded" });
  const failedMessages = page.getByRole("article", { name: "You message", exact: true }).filter({ hasText: text });
  await expect(failedMessages).toHaveCount(3, { timeout: 20000 });
  const orderedText = await page.getByRole("list", { name: "Conversation messages", exact: true }).getByRole("listitem").allTextContents();
  const before = orderedText.findIndex(value => value.includes("Before the failed messages."));
  const read = orderedText.findIndex(value => value.includes("Read cache"));
  const after = orderedText.findIndex(value => value.includes("After all failed messages."));
  const failedIndexes = orderedText.map((value, index) => value.includes(error) ? index : -1).filter(index => index >= 0);
  assert.ok(before < failedIndexes[0] && failedIndexes[1] < read && read < failedIndexes[2] && failedIndexes[2] < after,
    "The 15:25 failures belong before the 15:26 tool; the 15:29 failure belongs before the 15:30 reply.");
  assert.deepEqual(await page.locator('[data-message-id="first"], [data-message-id="second"], [data-message-id="later"]')
    .evaluateAll(rows => rows.map(row => row.dataset.messageId)), ["first", "second", "later"]);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const bubble of await failedMessages.all()) {
      await expect(bubble).toHaveAttribute("data-status", "failed");
      const status = bubble.getByText("Failed", { exact: true });
      await expect(status.locator('svg[aria-hidden="true"]')).toBeVisible();
      const colors = await bubble.evaluate(article => {
        const probe = document.createElement("span");
        probe.style.color = "var(--color-danger-text)";
        probe.style.backgroundColor = "var(--color-danger-surface)";
        document.body.append(probe);
        const expected = getComputedStyle(probe), body = getComputedStyle(article.children[1]);
        const label = Array.from(article.querySelectorAll("span")).find(element => element.textContent === "Failed");
        const error = article.querySelector('[role="alert"]');
        const canvas = document.createElement("span"); canvas.style.backgroundColor = "var(--color-canvas)";
        document.body.append(canvas);
        const color = value => {
          const element = document.createElement("canvas"), context = element.getContext("2d");
          context.fillStyle = value; context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
        };
        const result = { label: getComputedStyle(label).color, error: getComputedStyle(error).color,
          expected: expected.color, surface: body.backgroundColor, expectedSurface: expected.backgroundColor,
          foreground: color(expected.color), background: color(getComputedStyle(canvas).backgroundColor),
          bodyForeground: color(body.color), bodyBackground: color(body.backgroundColor) };
        probe.remove(); canvas.remove(); return result;
      });
      assert.equal(colors.label, colors.expected);
      assert.equal(colors.error, colors.expected);
      assert.equal(colors.surface, colors.expectedSurface);
      const luminance = channels => channels.map(channel => {
        const value = channel / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
      }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      for (const [foreground, background] of [[colors.foreground, colors.background], [colors.bodyForeground, colors.bodyBackground]]) {
        const levels = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
        assert.ok((levels[0] + .05) / (levels[1] + .05) >= 4.5, `${theme} message and failure text must meet normal-text contrast.`);
      }
    }
  }
  await page.emulateMedia({ forcedColors: "active" });
  await expect(failedMessages.first().getByText("Failed", { exact: true })).toBeVisible();
  await expect(failedMessages.first().getByRole("alert")).toBeVisible();
  await page.emulateMedia({ forcedColors: "none" });
  await page.reload();
  await expect(failedMessages).toHaveCount(3);
  assert.equal(sends, 0, "Restyling and positioning failures must not replay rejected messages.");
  assert.deepEqual(JSON.parse(await readFile(taskFile, "utf8")).interaction.messages, task.interaction.messages);
  task.interaction.messages[1] = { ...task.interaction.messages[1], status: "queued", error: undefined };
  await writeFile(taskFile, JSON.stringify(task));
  const recovered = page.locator('[data-message-id="first"]').getByRole("article");
  await expect(recovered).toHaveAttribute("data-status", "accepted");
  await expect(recovered.getByText("Queued", { exact: true })).toBeVisible();
  await expect(recovered.getByRole("alert")).toHaveCount(0);
  assert.deepEqual(await page.locator('[data-message-id="first"], [data-message-id="second"], [data-message-id="later"]')
    .evaluateAll(rows => rows.map(row => row.dataset.messageId)), ["first", "second", "later"]);
  const restored = await recovered.evaluate(article => {
    const probe = document.createElement("span"); probe.style.backgroundColor = "var(--color-surface-subtle)";
    document.body.append(probe);
    const result = getComputedStyle(article.children[1]).backgroundColor === getComputedStyle(probe).backgroundColor;
    probe.remove(); return result;
  });
  assert.ok(restored, "A recovered message must lose the failed-send styling without moving in the timeline.");
  assert.equal(sends, 0);
});
