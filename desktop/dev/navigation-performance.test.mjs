import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";

test("live activity updates only changed agent navigation, preserving images, menus and project selection", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-navigation-performance-")), project = join(root, "project"), count = 80;
  const other = join(root, "other");
  let app, browser, mutations = 0;
  t.after(async () => { await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true }); });
  for (const directory of [project, other])
    for (const child of ["agents", "logs", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
      await mkdir(join(directory, child), { recursive: true });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [
    { id: "fixture", name: "Fixture", root: project }, { id: "other", name: "Other fixture", root: other },
  ] }));
  const agentId = index => `agent-${String(index).padStart(3, "0")}`;
  const saveAgent = async (id, image) => {
    const file = join(project, "agents", `${id}.md`);
    await writeFile(`${file}.tmp`, image ? `---\nimage: ${JSON.stringify(image)}\n---\n# Isolated test; never launch a provider.` :
      "# Isolated test; never launch a provider.");
    await rename(`${file}.tmp`, file);
  };
  await Promise.all(Array.from({ length: count }, (_, index) => saveAgent(agentId(index))));
  await writeFile(join(other, "agents", "other-agent.md"), "# Isolated test; never launch a provider.");
  const task = { id: "selected", title: "Selected conversation", agent: agentId(count - 1), status: "completed",
    prompt: "Original work", session_id: "fixture", created_at: "2026-11-04T10:00:00Z", updated_at: "2026-11-04T10:00:00Z", turns: 0 };
  await writeFile(join(project, "queues", "completed", "selected.json"), JSON.stringify(task));
  await writeFile(join(project, "queues", "completed", "second.json"),
    JSON.stringify({ ...task, id: "second", title: "Another conversation", prompt: "Other original work" }));
  const instrumentation = {
    name: "navigation-performance-counters", enforce: "pre",
    transform(code, id) {
      id = id.replaceAll("\\", "/");
      let needle, measurement;
      if (id.endsWith("/src/components/ui/sidebar.tsx")) {
        needle = "...props }: ItemProps) {";
        measurement = 'if (props.href?.startsWith("/fixture/agents/") && !props["data-work-item-id"]) globalThis.__navigationPerf?.rows.push(props.href);';
      } else if (id.endsWith("/src/components/agent-actions.tsx")) {
        needle = "  const mutation ="; measurement = "if (compact) globalThis.__navigationPerf?.actions.push(agent);";
      } else if (id.endsWith("/src/components/ui/avatar.tsx")) {
        needle = "  return ("; measurement = 'if (name.endsWith(" image")) globalThis.__navigationPerf?.avatars.push(name);';
      } else if (id.endsWith("/src/components/project-switcher.tsx")) {
        needle = "  const [creating,"; measurement = "if (globalThis.__navigationPerf) globalThis.__navigationPerf.switchers++;";
      } else if (id.endsWith("/src/components/navigation-link.tsx")) {
        needle = "  const { navigate }"; measurement = "if (globalThis.__navigationPerf) globalThis.__navigationPerf.links++;";
      } else if (id.endsWith("/src/desktop/app.tsx")) {
        needle = "  useEffect(resumeConversationOutboxes"; measurement = "if (globalThis.__navigationPerf) globalThis.__navigationPerf.pages++;";
      } else if (id.endsWith("/src/components/project-live-provider.tsx")) {
        needle = "const snapshot = parseLive(JSON.parse(event.data));";
        measurement = "if (globalThis.__navigationPerf) globalThis.__navigationPerf.successful = snapshot.successful;";
      } else return;
      assert.ok(code.includes(needle), `Instrumentation no longer matches ${id}`);
      return { code: code.replace(needle, needle.endsWith(";") || needle.endsWith("{") ? `${needle}\n${measurement}` : `${measurement}\n${needle}`), map: null };
    },
  };
  app = await startProductionApp(root, [instrumentation]);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    globalThis.__navigationPerf = { rows: [], actions: [], avatars: [], switchers: 0, links: 0, pages: 0, successful: -1, longTasks: [] };
    new PerformanceObserver(list => globalThis.__navigationPerf.longTasks.push(...list.getEntries().map(entry => entry.duration)))
      .observe({ type: "longtask", buffered: true });
  });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/api/**", async route => {
    if (!["GET", "HEAD"].includes(route.request().method())) mutations++;
    await route.fallback();
  });
  await page.goto(`${app.url}/#/fixture/agents/${agentId(count - 1)}?task=selected`, { waitUntil: "domcontentloaded" });
  const nav = page.getByRole("navigation", { name: "Project navigation", exact: true });
  await expect(page.getByRole("region", { name: "Task conversation" })).toContainText("Original work", { timeout: 20000 });
  await nav.getByRole("button", { name: "Agents", exact: true }).click();
  const links = nav.locator('a[href^="#/fixture/agents/"]');
  await expect(links).toHaveCount(count);
  const actions = nav.getByRole("button", { name: `${agentId(10)} actions`, exact: true });
  await expect(actions).toBeVisible();
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const reset = () => page.evaluate(() => Object.assign(globalThis.__navigationPerf, {
    rows: [], actions: [], avatars: [], switchers: 0, links: 0, pages: 0, longTasks: [],
  }));
  const sample = () => page.evaluate(() => {
    const data = globalThis.__navigationPerf;
    return { rows: data.rows.length, unchangedRows: data.rows.filter(href => !href.endsWith("/agent-000")).length,
      actions: data.actions.length, avatars: data.avatars.length, switchers: data.switchers,
      links: data.links, pages: data.pages,
      longTasks: data.longTasks.length, maxLongTask: Math.max(0, ...data.longTasks) };
  });
  await settle();
  const history = page.getByRole("navigation", { name: "Conversations", exact: true });
  await reset();
  await history.getByRole("link", { name: "Another conversation", exact: true }).click();
  await expect(page.getByRole("region", { name: "Task conversation" })).toContainText("Other original work");
  await settle();
  const conversationChanged = await sample();
  await page.goBack();
  await expect(page.getByRole("region", { name: "Task conversation" })).toContainText("Original work");
  await page.goForward();
  await expect(page.getByRole("region", { name: "Task conversation" })).toContainText("Other original work");
  await history.getByRole("link", { name: "Selected conversation", exact: true }).click();
  await expect(page.getByRole("region", { name: "Task conversation" })).toContainText("Original work");
  await settle();
  await reset();
  await writeFile(join(project, "queues", "completed", "unrelated.json"), JSON.stringify({ ...task, id: "unrelated", agent: agentId(0) }));
  await page.waitForFunction(() => globalThis.__navigationPerf.successful === 3);
  await settle();
  const unrelated = await sample();
  const notification = page.getByRole("button", { name: "Dismiss notification", exact: true });
  await notification.click();
  await expect(notification).toHaveCount(0);
  await actions.focus();
  await page.keyboard.press("Enter");
  const edit = page.getByRole("menuitem", { name: "Edit prompt", exact: true });
  await expect(edit).toBeVisible();
  await edit.focus();
  await reset();
  await writeFile(join(project, "queues", "incoming", "pending.json"),
    JSON.stringify({ ...task, id: "pending", agent: agentId(0), status: "incoming" }));
  await expect(page.getByLabel(`${agentId(0)}: 1 pending task`, { exact: true })).toHaveCount(1);
  await settle();
  const changed = await sample();
  await expect(edit).toBeVisible();
  await expect(edit).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(actions).toBeFocused();
  const first = nav.locator(`a[href="#/fixture/agents/${agentId(0)}"]`);
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d"); context.fillStyle = "red"; context.fillRect(0, 0, 1, 1);
    return canvas.toDataURL("image/png");
  });
  await reset();
  await saveAgent(agentId(0), image);
  await expect(first.locator("img")).toBeVisible();
  await settle();
  const imageAdded = await sample();
  const originalImage = await first.locator("img").getAttribute("src");
  await reset();
  await saveAgent(agentId(0));
  await expect(first.locator("img")).toHaveCount(0);
  await settle();
  const imageRemoved = await sample();
  assert.ok(originalImage.includes(`/agents/${agentId(0)}/image?v=`), "Images must retain versioned, project-scoped URLs.");
  await saveAgent("new-agent");
  await expect(links).toHaveCount(count + 1);
  await rm(join(project, "agents", "new-agent.md"));
  await expect(links).toHaveCount(count);
  app.disconnect();
  await expect(nav.getByRole("alert")).toHaveText("Live activity unavailable");
  await expect(nav.getByLabel(`${agentId(0)}: 1 pending task`, { exact: true })).toHaveCount(0);
  await expect(nav.getByRole("alert")).toHaveCount(0, { timeout: 10000 });
  await expect(nav.getByLabel(`${agentId(0)}: 1 pending task`, { exact: true })).toBeVisible();
  const next = nav.getByRole("link", { name: agentId(1), exact: true });
  await reset();
  await next.focus();
  await page.keyboard.press("Enter");
  await expect(next).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: agentId(count - 1), exact: true })).not.toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("textbox", { name: "Message agent", exact: true })).toBeVisible();
  await settle();
  const agentChanged = await sample();
  const metrics = { count, cpuThrottle: 4, conversationChanged, agentChanged, unrelated, changed, imageAdded, imageRemoved };
  console.log(JSON.stringify(metrics));
  if (process.env.SPOOL_NAV_PERF_REPORT) await writeFile(process.env.SPOOL_NAV_PERF_REPORT, JSON.stringify(metrics, null, 2));
  await page.setViewportSize({ width: 600, height: 900 });
  await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  await expect(nav).toBeVisible();
  await nav.getByRole("button", { name: /^Agents/ }).click();
  await nav.getByRole("link", { name: agentId(2), exact: true }).click();
  await expect(nav).not.toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Switch project, Fixture", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Other fixture", exact: true }).click();
  await expect(page.getByRole("button", { name: "Switch project, Other fixture", exact: true })).toBeVisible();
  await nav.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(nav.getByRole("link", { name: "other-agent", exact: true })).toBeVisible();
  await expect(links).toHaveCount(0);
  const addAgent = nav.getByRole("button", { name: "Add agent", exact: true });
  await addAgent.click();
  const create = page.getByRole("dialog", { name: "Add agent", exact: true });
  await expect(create).toBeVisible();
  await create.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(create).toHaveCount(0);
  await expect(addAgent).toBeFocused();
  assert.equal(unrelated.rows, 0, "Unchanged agent navigation must not rerender on unrelated task completion.");
  assert.equal(unrelated.actions, 0, "Unchanged agent actions must not rerender on task updates.");
  assert.equal(unrelated.avatars, 0, "Unchanged agent images must not rerender on task updates.");
  assert.equal(unrelated.switchers, 0, "Live agent activity must not rerender the project switcher.");
  assert.equal(changed.unchangedRows, 0, "One changed activity badge must not rebuild every agent link.");
  assert.equal(changed.rows, 1, "The changed activity badge must still update its agent link.");
  assert.equal(imageAdded.unchangedRows, 0, "One image change must not rebuild unrelated agent links.");
  assert.equal(imageRemoved.unchangedRows, 0, "Removing an image must leave unrelated navigation untouched.");
  assert.equal(conversationChanged.pages, 0, "Selecting a conversation must not rerender the desktop page.");
  assert.equal(conversationChanged.actions, 0, "Selecting a conversation must not rerender unrelated agent actions.");
  assert.equal(conversationChanged.links, 0, "Selecting a conversation must not rerender project navigation links.");
  assert.ok(agentChanged.actions <= 2, "Switching agents must not rerender actions for every agent.");
  assert.equal(mutations, 0, "Navigation must not submit messages, delete agents or launch providers.");
  assert.deepEqual(errors, []);
});
