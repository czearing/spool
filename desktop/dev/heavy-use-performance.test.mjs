import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";

test("live updates, history search and board interactions do not rerender unchanged task rows", { timeout: 180000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-heavy-use-")), project = join(root, "project"), count = 400;
  let app, browser, sends = 0;
  t.after(async () => { await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "fixture", name: "Fixture", root: project }] }));
  for (const directory of ["agents", "logs", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, directory), { recursive: true });
  for (const agent of ["engineer", "other"])
    await writeFile(join(project, "agents", `${agent}.md`), "# Isolated test; never launch a provider.");
  const tasks = Array.from({ length: count }, (_, index) => ({
    id: `task-${String(index).padStart(4, "0")}`, title: `Conversation ${String(index).padStart(4, "0")}`,
    agent: "engineer", prompt: `Original work ${index}`, status: "completed", session_id: `fixture-${index}`,
    created_at: new Date(Date.UTC(2026, 10, 4, 0, index)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 10, 4, 0, index)).toISOString(), turns: 0,
  }));
  const save = task => writeFile(join(project, "queues", "completed", `${task.id}.json`), JSON.stringify(task));
  for (let start = 0; start < tasks.length; start += 32) await Promise.all(tasks.slice(start, start + 32).map(save));
  const instrumentation = {
    name: "heavy-use-render-counters", enforce: "pre",
    transform(code, id) {
      code = code.replaceAll("\r\n", "\n");
      let needle, measurement;
      if (id.replaceAll("\\", "/").endsWith("/src/components/ui/sidebar.tsx")) {
        needle = "...props }: ItemProps) {";
        measurement = 'if (props["data-work-item-id"]) globalThis.__heavyUse?.history.push(props["data-work-item-id"]);';
      } else if (id.replaceAll("\\", "/").endsWith("/src/components/board-view.tsx")) {
        needle = "  const content = <>";
        measurement = "globalThis.__heavyUse && globalThis.__heavyUse.board++;";
      } else if (id.replaceAll("\\", "/").endsWith("/src/lib/agent-conversations.ts")) {
        needle = "export function agentConversations(jobs: AgentJobs): AgentJob[] {";
        measurement = "globalThis.__heavyUse && globalThis.__heavyUse.sorts++;";
      } else if (id.replaceAll("\\", "/").endsWith("/src/components/project-live-provider.tsx")) {
        needle = "const snapshot = parseLive(JSON.parse(event.data));";
        measurement = "if (globalThis.__heavyUse) globalThis.__heavyUse.successful = snapshot.successful;";
      } else return;
      assert.ok(code.includes(needle), `Instrumentation no longer matches ${id}`);
      const replacement = needle.endsWith("{") || needle.endsWith(";")
        ? `${needle}\n${measurement}` : `${measurement}\n${needle}`;
      return { code: code.replace(needle, replacement), map: null };
    },
  };
  app = await startProductionApp(root, [instrumentation]);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1680, height: 1100 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    globalThis.__heavyUse = { history: [], board: 0, sorts: 0, paints: [], longTasks: [], successful: -1 };
    new PerformanceObserver(list => globalThis.__heavyUse.longTasks.push(...list.getEntries().map(entry => entry.duration)))
      .observe({ type: "longtask", buffered: true });
    document.addEventListener("input", () => {
      const start = performance.now();
      requestAnimationFrame(() => globalThis.__heavyUse.paints.push(performance.now() - start));
    }, true);
  });
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/api/projects/fixture/tasks/*/conversation*", async route => {
    if (route.request().method() === "POST") sends++;
    await route.continue();
  });
  await page.goto(`${app.url}/#/fixture/agents/engineer?task=task-0000`, { waitUntil: "domcontentloaded" });
  const history = page.getByRole("navigation", { name: "Conversations", exact: true });
  await expect(history.getByRole("link")).toHaveCount(count, { timeout: 20000 });
  await expect(page.getByRole("region", { name: "Task conversation" })).toContainText("Original work 0");
  await page.waitForFunction(count => globalThis.__heavyUse.successful === count, count);
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const reset = () => page.evaluate(() => {
    Object.assign(globalThis.__heavyUse, { history: [], board: 0, sorts: 0, paints: [], longTasks: [] });
  });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const sample = () => page.evaluate(() => {
    const data = globalThis.__heavyUse, paints = [...data.paints].sort((a, b) => a - b);
    return { historyRenders: data.history.length, unchangedHistoryRenders: data.history.filter(id => id !== "task-0001").length,
      boardRenders: data.board, sorts: data.sorts, typingP95: paints[Math.ceil(paints.length * .95) - 1] ?? 0,
      longTasks: data.longTasks.length, maxLongTask: Math.max(0, ...data.longTasks) };
  });
  await settle();
  await reset();
  await save({ ...tasks[0], id: "unrelated", agent: "other", title: "Other agent completed work" });
  await page.waitForFunction(count => globalThis.__heavyUse.successful === count + 1, count);
  await settle();
  const unrelated = await sample();
  await reset();
  tasks[1] = { ...tasks[1], title: "Updated conversation 0001" };
  await save(tasks[1]);
  await expect(history.getByRole("link", { name: "Updated conversation 0001", exact: true })).toBeVisible();
  await settle();
  const changed = await sample();
  const historySearch = page.getByRole("searchbox", { name: "Search conversations", exact: true });
  await reset();
  await historySearch.fill("Con");
  await historySearch.pressSequentially("versation", { delay: 40 });
  await settle();
  await expect(history.getByRole("link")).toHaveCount(count);
  const historyTyping = await sample();
  await historySearch.fill("0399");
  await expect(history.getByRole("link")).toHaveCount(1);
  const navigationStart = Date.now();
  await history.getByRole("link", { name: "Conversation 0399", exact: true }).click();
  await expect(page.getByRole("region", { name: "Task conversation" })).toContainText("Original work 399");
  const navigationMs = Date.now() - navigationStart;
  await historySearch.fill("0000");
  const original = history.getByRole("link", { name: "Conversation 0000", exact: true });
  const modifiedPrevented = await original.evaluate(link => {
    let intercepted;
    window.addEventListener("click", event => { intercepted = event.defaultPrevented; event.preventDefault(); }, { once: true });
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    return intercepted;
  });
  assert.equal(modifiedPrevented, false, "Modified clicks must retain their normal link behavior.");
  await original.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Task conversation" })).toContainText("Original work 0");
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  const cards = page.getByRole("button", { name: /^Open conversation:/ });
  await expect(cards).toHaveCount(count + 1, { timeout: 20000 });
  await page.getByRole("button", { name: "Search board", exact: true }).click();
  const boardSearch = page.getByRole("searchbox", { name: "Search work items", exact: true });
  await boardSearch.fill("Con");
  await expect(cards).toHaveCount(count);
  await settle();
  await reset();
  await boardSearch.pressSequentially("versation", { delay: 40 });
  await settle();
  const boardTyping = await sample();
  await boardSearch.fill("0399");
  await expect(cards).toHaveCount(1);
  await reset();
  await cards.click();
  const dialog = page.getByRole("dialog", { name: "Conversation 0399", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Original work 399");
  await settle();
  const openDialog = await sample();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(cards).toBeFocused();
  const metrics = { count, cpuThrottle: 4, unrelated, changed, historyTyping, boardTyping, openDialog, navigationMs };
  console.log(JSON.stringify(metrics));
  if (process.env.SPOOL_PERF_REPORT) await writeFile(process.env.SPOOL_PERF_REPORT, JSON.stringify(metrics, null, 2));
  assert.equal(unrelated.historyRenders, 0, "Other agents' live updates must not rerender unchanged conversation rows.");
  assert.equal(unrelated.sorts, 0, "Unchanged agent jobs must not be sorted again on unrelated live updates.");
  assert.equal(changed.unchangedHistoryRenders, 0, "A changed task must not rerender every unchanged conversation.");
  assert.equal(historyTyping.historyRenders, 0, "Searches retaining the same entries must not rebuild their rows.");
  assert.equal(boardTyping.boardRenders, 0, "Unchanged matching task cards must not rerender on each search character.");
  assert.equal(openDialog.boardRenders, 0, "Opening a conversation must not rerender the board underneath it.");
  await boardSearch.fill("");
  await expect(cards).toHaveCount(count + 1);
  await page.route("**/api/projects/fixture/tasks/archive", route =>
    route.fulfill({ status: 503, json: { error: "Temporary archive failure" } }), { times: 1 });
  await page.getByRole("button", { name: "Completed actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move all to archive", exact: true }).click();
  const archiveDialog = page.getByRole("dialog", { name: "Archive all completed tasks?", exact: true });
  await archiveDialog.getByRole("button", { name: "Move all to archive", exact: true }).click();
  await expect(archiveDialog.getByRole("alert")).toHaveText("Temporary archive failure");
  await expect(page.getByRole("button", { name: /^Open conversation:/, includeHidden: true })).toHaveCount(count + 1);
  const archived = page.waitForResponse(response => response.url().endsWith("/tasks/archive") && response.status() === 200);
  await archiveDialog.getByRole("button", { name: "Move all to archive", exact: true }).click();
  assert.equal((await (await archived).json()).archived, count + 1);
  await expect(archiveDialog).toHaveCount(0);
  await expect(cards).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Archive", exact: true }))
    .toContainText(`(${count + 1})`);
  assert.equal(sends, 0, "Profiling navigation and search must never send a message or launch a provider.");
});
