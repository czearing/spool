import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";
import { nativeControls } from "../../../packages/runners/bridge/test/native-controls-fixture.mjs";
import { runMessageControls } from "../src-tauri/resources/runners/bridge/application.mjs";

test("pending sends survive connection loss, newer drafts and reloads in the real app", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-chat-outbox-"));
  const project = { id: "fixture", name: "Fixture", root: join(root, "project") };
  let server, browser, controls, stopNative;
  t.after(async () => {
    try { await controls?.stop(); }
    finally {
      try { stopNative?.(); }
      finally {
        await browser?.close(); await server?.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [project] }));
  for (const folder of ["agents", "logs", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project.root, folder), { recursive: true });
  await writeFile(join(project.root, "agents", "engineer.md"), "# Fixture; never run a model.");
  const task = { id: "one", title: "Disconnected conversation", agent: "engineer", prompt: "Original work",
    workspace: project.root, status: "incoming", turns: 0, cost: {}, comments: [],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const taskFile = join(project.root, "queues", "incoming", "one.json");
  await writeFile(taskFile, JSON.stringify(task));
  await writeFile(join(project.root, "queues", "incoming", "other.json"),
    JSON.stringify({ ...task, id: "other", title: "Another conversation", prompt: "Different work" }));
  server = await startProductionApp(root);
  const origin = server.url;
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  let disconnected = true, historyDisconnected = false, historyFailures = 0, loseAcknowledgement = true;
  const sends = [];
  await page.route("**/api/projects/fixture/tasks/one/conversation*", async route => {
    if (route.request().method() !== "POST") {
      if (historyDisconnected) { historyFailures++; return route.abort("connectionreset"); }
      return route.continue();
    }
    sends.push(route.request().postDataJSON());
    if (disconnected) return route.abort("connectionreset");
    const response = await route.fetch();
    if (loseAcknowledgement) { loseAcknowledgement = false; return route.abort("connectionreset"); }
    return route.fulfill({ response });
  });
  const initialRead = page.waitForResponse(response => response.url().includes("/tasks/one/conversation?") && response.ok());
  await page.goto(`${origin}/#/fixture/agents/engineer?task=one`, { waitUntil: "domcontentloaded" });
  await initialRead;
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  const first = "Deliver my first message even if I leave this conversation.";
  const second = "Another message must queue before the connection recovers.";
  const draft = "A newer draft must remain independent.";
  await expect(editor).toHaveAttribute("aria-disabled", "false");
  await editor.fill(first);
  await page.evaluate(() => {
    window.restoreStorage = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith("spool-outbox:")) throw new Error("Storage is full");
      return window.restoreStorage.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Storage is full" })).toBeVisible();
  await expect(editor).toHaveText(first);
  assert.equal(sends.length, 0, "A failed local write must not send or discard the draft.");
  await page.evaluate(() => { Storage.prototype.setItem = window.restoreStorage; delete window.restoreStorage; });
  const started = Date.now();
  await page.getByRole("button", { name: "Retry sending message", exact: true }).click();
  await expect(editor).toHaveText("", { timeout: 1000 });
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
  const localQueueMs = Date.now() - started;
  await expect.poll(() => sends.length).toBeGreaterThan(0);
  historyDisconnected = true;
  await expect.poll(() => historyFailures).toBeGreaterThan(0);
  await expect(editor).toHaveAttribute("aria-disabled", "false");
  await editor.fill(second);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(editor).toHaveText("", { timeout: 1000 });
  await expect(page.getByRole("article", { name: "You message", exact: true }).filter({ hasText: first })).toHaveCount(1);
  await editor.fill(draft);
  await page.goto(`${origin}/#/fixture/agents/engineer?task=other`);
  await expect(editor).toHaveText("");
  await page.reload();
  await expect(editor).toHaveText("");
  disconnected = false; historyDisconnected = false;
  await expect.poll(async () => {
    try { return (await readdir(join(project.root, "controls", "commands"))).length; }
    catch (error) { if (error.code === "ENOENT") return 0; throw error; }
  }).toBe(2);
  await expect(page.getByRole("article", { name: "You message", exact: true }).filter({ hasText: first })).toHaveCount(0);
  await page.goto(`${origin}/#/fixture/agents/engineer?task=one`);
  await expect(editor).toHaveText(draft);
  const firstIds = new Set(sends.filter(input => input.message === first).map(input => input.id));
  assert.equal(firstIds.size, 1, "Reload recovery must not invent another delivery identity.");
  nativeControls({ after: cleanup => { stopNative = cleanup; } }, project.root);
  controls = runMessageControls(project.root);
  await expect.poll(async () => JSON.parse(await readFile(taskFile, "utf8")).interaction?.messages?.length,
    { timeout: 15000 }).toBe(2);
  assert.deepEqual(JSON.parse(await readFile(taskFile, "utf8")).interaction.messages.map(message => message.text), [first, second]);
  await page.reload();
  await expect(editor).toHaveText(draft);
  await expect(page.getByRole("article", { name: "You message", exact: true }).filter({ hasText: first })).toHaveCount(1);
  await expect(page.getByRole("article", { name: "You message", exact: true }).filter({ hasText: second })).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  console.log(JSON.stringify({ localQueueMs, automaticAttempts: sends.length, nativeMessages: 2 }));
});
