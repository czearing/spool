import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";
import { nativeControls } from "../../../packages/runners/bridge/test/native-controls-fixture.mjs";
import { runMessageControls } from "../src-tauri/resources/runners/bridge/application.mjs";

test("one timestamped message stays mounted from sending through native delivery and transcript arrival", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-chat-delivery-")), project = join(root, "project");
  let app, browser, controls, stopNative, release, stale = false, stalePolls = 0, missingTimes = true;
  const confirmation = new Promise(resolve => { release = resolve; });
  t.after(async () => {
    release();
    try { await controls?.stop(); }
    finally {
      stopNative?.();
      await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true });
    }
  });
  for (const folder of ["agents", "logs", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, folder), { recursive: true });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "fixture", name: "Fixture", root: project }] }));
  await writeFile(join(project, "agents", "engineer.md"), "# Isolated fixture; never launch a provider.");
  const file = join(project, "queues", "incoming", "one.json");
  await writeFile(file, JSON.stringify({ id: "one", title: "Stable delivery", agent: "engineer", prompt: "Original work",
    workspace: project, status: "incoming", turns: 0, cost: {}, comments: [],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() }));
  app = await startProductionApp(root);
  browser = await chromium.launch();
  const page = await browser.newPage(), requests = [], errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/api/projects/fixture/tasks/one/conversation*", async route => {
    const response = await route.fetch();
    if (route.request().method() === "POST") {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) await confirmation;
      return route.fulfill({ response });
    }
    const data = await response.json();
    if (stale) { data.task.interaction.messages = []; stalePolls++; }
    else if (missingTimes) for (const message of data.task.interaction.messages) delete message.created_at;
    await route.fulfill({ json: data });
  });
  await page.goto(`${app.url}/#/fixture/agents/engineer?task=one`, { waitUntil: "domcontentloaded" });
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  await expect(editor).toHaveAttribute("aria-disabled", "false");
  const firstText = "Keep this message continuously visible.", secondText = "Queue this while confirmation is delayed.";
  await editor.fill(firstText);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(editor).toHaveText("", { timeout: 1000 });
  await expect.poll(() => requests.length).toBe(1);
  const id = requests[0].id, row = page.locator(`[data-message-id="${id}"]`);
  await expect(row.locator("time")).toHaveCount(1);
  await page.evaluate(id => {
    const row = document.querySelector(`[data-message-id="${id}"]`), article = row.querySelector("article"), time = row.querySelector("time");
    const watch = window.deliveryWatch = { row, article, time, stamp: time.dateTime, removed: 0 };
    watch.observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.removedNodes)
        if (node === row || node.contains(row) || node === article || node.contains(article)) watch.removed++;
    });
    watch.observer.observe(document.querySelector('[aria-label="Task conversation"]'), { subtree: true, childList: true });
  }, id);
  const unchanged = async () => assert.deepEqual(await page.evaluate(id => {
    const watch = window.deliveryWatch, row = document.querySelector(`[data-message-id="${id}"]`);
    return { row: row === watch.row, article: row?.querySelector("article") === watch.article,
      time: row?.querySelector("time") === watch.time, stamp: row?.querySelector("time")?.dateTime === watch.stamp,
      connected: watch.article.isConnected, removed: watch.removed };
  }, id), { row: true, article: true, time: true, stamp: true, connected: true, removed: 0 });
  await expect(row).toContainText("Queued");
  await unchanged();
  await editor.fill(secondText);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(editor).toHaveText("", { timeout: 1000 });
  await expect(page.getByRole("article", { name: "You message", exact: true }).filter({ hasText: secondText })).toHaveCount(1);
  await unchanged();
  release();
  await expect.poll(async () => (await readdir(join(project, "controls", "commands"))).length).toBe(2);
  nativeControls({ after: cleanup => { stopNative = cleanup; } }, project);
  controls = runMessageControls(project);
  await expect.poll(async () => JSON.parse(await readFile(file, "utf8")).interaction?.messages?.length,
    { timeout: 15000 }).toBe(2);
  await controls.stop(); controls = undefined; stopNative(); stopNative = undefined;
  const task = JSON.parse(await readFile(file, "utf8")), message = task.interaction.messages.find(message => message.id === id);
  const save = async () => { await writeFile(`${file}.tmp`, JSON.stringify(task)); await rename(`${file}.tmp`, file); };
  assert.equal(task.id, "one");
  assert.equal(task.interaction.messages.filter(message => message.id === id).length, 1);
  message.status = "delivering";
  await save();
  await expect(row).toContainText("Delivering");
  await unchanged();
  message.status = "delivered";
  await save();
  await expect(row.locator("article")).toHaveAttribute("data-status", "complete");
  await unchanged();
  stale = true;
  await expect.poll(() => stalePolls).toBeGreaterThan(0);
  await unchanged();
  stale = false;
  await appendFile(join(project, "logs", "one.log"), JSON.stringify({
    type: "user.message", data: { messageId: id, content: firstText }, timestamp: "2000-01-01T00:00:00Z",
  }) + "\n");
  await expect.poll(async () => {
    const response = await page.request.get(`${app.url}/api/projects/fixture/tasks/one/conversation?events=1`);
    return (await response.json()).entries.length;
  }).toBe(1);
  await page.waitForResponse(response => response.url().includes("/tasks/one/conversation?") && response.ok());
  await unchanged();
  await expect(page.getByRole("article", { name: "You message", exact: true }).filter({ hasText: firstText })).toHaveCount(1);
  await page.evaluate(() => window.deliveryWatch.observer.disconnect());
  missingTimes = false;
  await page.reload();
  await expect(row).toContainText(firstText);
  await expect(row.locator("time")).toHaveCount(1);
  assert.equal((await readdir(join(project, "controls", "commands"))).length, 2);
  assert.equal(requests.length, 2);
  assert.deepEqual(errors, []);
});
