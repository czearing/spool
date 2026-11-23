import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";

test("large conversation histories open without redundant layout wrappers", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-history-open-")), project = join(root, "project"), count = 1000;
  let app, browser, mutations = 0;
  t.after(async () => { await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true }); });
  for (const directory of ["agents", "logs", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, directory), { recursive: true });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "fixture", name: "Fixture", root: project }] }));
  await writeFile(join(project, "agents", "engineer.md"), "# Isolated test; never launch a provider.");
  for (let start = 0; start < count; start += 32) await Promise.all(Array.from({ length: Math.min(32, count - start) }, (_, offset) => {
    const index = start + offset, id = `task-${index}`;
    return writeFile(join(project, "queues", "completed", `${id}.json`), JSON.stringify({
      id, title: `Conversation ${index}`, agent: "engineer", status: "completed", prompt: `Original work ${index}`,
      session_id: `fixture-${index}`, created_at: new Date(Date.UTC(2026, 10, 4, 0, index)).toISOString(),
      updated_at: new Date(Date.UTC(2026, 10, 4, 0, index)).toISOString(), turns: 0,
    }));
  }));
  const instrumentation = {
    name: "history-open-counters", enforce: "pre",
    async transform(code, id) {
      id = id.replaceAll("\\", "/");
      if (id.endsWith("/src/components/ui/sidebar.tsx") && process.env.SPOOL_HISTORY_ITEM_SOURCE) {
        const start = code.indexOf("export function SidebarItem("), end = code.indexOf("export function SidebarAction(", start);
        assert.ok(start >= 0 && end > start);
        return { code: code.slice(0, start) + await readFile(process.env.SPOOL_HISTORY_ITEM_SOURCE, "utf8") + "\n" + code.slice(end), map: null };
      }
      if (!id.endsWith("/src/components/ui/stack.tsx")) return;
      const needle = '  const Component = asChild ? Slot.Root : "div";';
      assert.ok(code.includes(needle), "Stack instrumentation must match the production component.");
      return { code: code.replace(needle, `  if (globalThis.__historyOpen) globalThis.__historyOpen.stacks++;\n${needle}`), map: null };
    },
  };
  app = await startProductionApp(root, [instrumentation]);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { globalThis.__historyOpen = { stacks: 0 }; });
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/api/**", async route => {
    if (!["GET", "HEAD"].includes(route.request().method())) mutations++;
    await route.fallback();
  });
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await session.send("Performance.enable");
  if (process.env.SPOOL_HISTORY_CPU_PROFILE) {
    await session.send("Profiler.enable"); await session.send("Profiler.start");
  }
  const start = Date.now();
  await page.goto(`${app.url}/#/fixture/agents/engineer?task=task-999`, { waitUntil: "domcontentloaded" });
  const history = page.locator('nav[aria-label="Conversations"]');
  // Retry diagnostics walk the whole accessibility tree and distort cold-open timings.
  await page.waitForFunction(count => document.querySelectorAll('nav[aria-label="Conversations"] a[data-work-item-id]').length === count &&
    document.querySelector('[aria-label="Task conversation"]')?.textContent.includes("Original work 999"), 60, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const readyMs = Date.now() - start;
  const metrics = Object.fromEntries((await session.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
  const stacks = await page.evaluate(() => globalThis.__historyOpen.stacks);
  if (process.env.SPOOL_HISTORY_CPU_PROFILE) {
    const { profile } = await session.send("Profiler.stop");
    await writeFile(process.env.SPOOL_HISTORY_CPU_PROFILE, JSON.stringify(profile));
  }
  const report = { count, cpuThrottle: 4, readyMs, stacks, taskMs: metrics.TaskDuration * 1000,
    scriptMs: metrics.ScriptDuration * 1000, layoutMs: metrics.LayoutDuration * 1000, styleMs: metrics.RecalcStyleDuration * 1000 };
  console.log(JSON.stringify(report));
  if (process.env.SPOOL_HISTORY_PERF_REPORT) await writeFile(process.env.SPOOL_HISTORY_PERF_REPORT, JSON.stringify(report, null, 2));
  const first = history.locator('a[data-work-item-id="task-999"]');
  const layout = await first.evaluate(link => {
    const row = getComputedStyle(link.parentElement), item = getComputedStyle(link);
    return { row: [row.display, row.flexDirection, row.alignItems, row.columnGap],
      item: [item.display, item.flexDirection, item.alignItems, item.justifyContent, item.columnGap],
      width: link.getBoundingClientRect().width, parentWidth: link.parentElement.getBoundingClientRect().width };
  });
  assert.deepEqual(layout.row, ["flex", "row", "center", "0px"]);
  assert.deepEqual(layout.item, ["flex", "row", "center", "start", "8px"]);
  assert.ok(Math.abs(layout.width - layout.parentWidth) < 1, "Conversation links must still fill their rows.");
  await expect(first).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Load older conversations", exact: true }).click();
  await expect(history.locator("a[data-work-item-id]")).toHaveCount(120);
  await history.getByRole("link", { name: "Conversation 900", exact: true }).click();
  await expect(page.getByRole("region", { name: "Task conversation" })).toContainText("Original work 900");
  await expect(history.locator("a[data-work-item-id]")).toHaveCount(120);
  await writeFile(join(project, "queues", "completed", "task-999.json"), JSON.stringify({
    id: "task-999", title: "Conversation 999 refreshed", agent: "engineer", status: "completed", prompt: "Original work 999",
    session_id: "fixture-999", updated_at: new Date(Date.UTC(2026, 10, 4, 0, 999)).toISOString(),
  }));
  await expect(history.getByRole("link", { name: "Conversation 999 refreshed", exact: true })).toBeVisible();
  await expect(history.locator("a[data-work-item-id]")).toHaveCount(120);
  const search = page.getByRole("searchbox", { name: "Search conversations", exact: true });
  await search.fill("Conversation 123");
  await expect(history.locator("a[data-work-item-id]")).toHaveCount(1);
  const match = history.getByRole("link", { name: "Conversation 123", exact: true });
  await match.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Task conversation" })).toContainText("Original work 123");
  await expect(match).toHaveAttribute("aria-current", "page");
  await search.fill("");
  await expect(history.locator("a[data-work-item-id]")).toHaveCount(61);
  await expect(history.locator('a[data-work-item-id="task-123"]')).toHaveAttribute("aria-current", "page");
  assert.equal(mutations, 0, "Opening and searching history must never submit work or launch a provider.");
  assert.deepEqual(errors, []);
  assert.ok(stacks < count * 3, "Mounting history must not create two redundant layout wrappers for every link.");
});
