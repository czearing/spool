import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";
import { nativeControls } from "../../packages/runners/bridge/test/native-controls-fixture.mjs";
import { runMessageControls } from "../src-tauri/resources/runners/bridge/application.mjs";

async function application(t) {
  const root = await mkdtemp(join(tmpdir(), "spool-reconciliation-")), project = join(root, "project");
  let server, browser, controls, stopNative;
  t.after(async () => {
    try { await controls?.stop(); }
    finally {
      try { stopNative?.(); }
      finally { await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); }
    }
  });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "fixture", name: "Fixture", root: project }] }));
  for (const folder of ["agents", "logs", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, folder), { recursive: true });
  await writeFile(join(project, "agents", "engineer.md"), "# Isolated test; never launch a provider.");
  const taskFile = join(project, "queues", "incoming", "one.json");
  await writeFile(taskFile, JSON.stringify({ id: "one", title: "Repeated input", agent: "engineer", prompt: "Original work",
    workspace: project, status: "incoming", turns: 0, cost: {}, comments: [],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() }));
  server = await startProductionApp(root);
  browser = await chromium.launch();
  const page = await browser.newPage(), origin = server.url;
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  return { page, origin, project, taskFile, commands: async () => {
    try { return await readdir(join(project, "controls", "commands")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  },
    async acceptMessages() {
      nativeControls({ after: cleanup => { stopNative = cleanup; } }, project);
      controls = runMessageControls(project);
      await expect.poll(async () => JSON.parse(await readFile(taskFile, "utf8")).interaction?.messages?.length,
        { timeout: 15000 }).toBe(2);
      await controls.stop(); controls = undefined; stopNative(); stopNative = undefined;
      return JSON.parse(await readFile(taskFile, "utf8"));
    } };
}
test("repeated input stays distinct when only the first message has reached the provider log", { timeout: 120000 }, async t => {
  const app = await application(t), { page } = app;
  await page.goto(`${app.origin}/#/fixture/agents/engineer?task=one`, { waitUntil: "domcontentloaded" });
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true }), text = "Please keep going.";
  await expect(editor).toHaveAttribute("aria-disabled", "false");
  for (let index = 0; index < 2; index++) {
    await editor.fill(text);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(editor).toHaveText("");
  }
  await expect.poll(async () => (await app.commands()).length).toBe(2);
  const task = await app.acceptMessages(), [first, second] = task.interaction.messages;
  assert.notEqual(first.id, second.id);
  first.status = "delivered";
  await writeFile(app.taskFile, JSON.stringify(task));
  const log = { type: "user.message", data: { content: text, messageId: first.id }, timestamp: new Date().toISOString() };
  await writeFile(join(app.project, "logs", "one.log"), JSON.stringify(log) + "\n");
  const bubbles = page.getByRole("article", { name: "You message", exact: true }).filter({ hasText: text });
  await expect(bubbles).toHaveCount(2);
  await expect(page.locator(`[data-message-id="${second.id}"]`)).toContainText("Queued");
  second.status = "delivery_uncertain";
  await writeFile(app.taskFile, JSON.stringify(task));
  await expect(page.locator(`[data-message-id="${second.id}"]`)).toContainText("Delivery could not be confirmed.");
  await expect(page.locator(`[data-message-id="${first.id}"]`).getByRole("alert")).toHaveCount(0);
  await expect(page.locator(`[data-message-id="${second.id}"]`).getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  second.status = "delivering";
  await writeFile(app.taskFile, JSON.stringify(task));
  const secondLog = { ...log, data: { content: text, messageId: second.id }, timestamp: "2000-01-01T00:00:00.000Z" };
  await writeFile(join(app.project, "logs", "one.log"), JSON.stringify(log) + "\n" + JSON.stringify(secondLog) + "\n");
  await expect(bubbles).toHaveCount(2);
  await expect(bubbles.filter({ hasText: "Delivering" })).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(bubbles).toHaveCount(2);
  assert.equal((await app.commands()).length, 2, "Reconciliation must never replay uncertain input.");
});
test("a corrupt saved record cannot block other saved messages or new sends", { timeout: 120000 }, async t => {
  const app = await application(t), { page } = app;
  const broken = `spool-outbox:fixture:one:${randomUUID()}`, id = randomUUID();
  await page.addInitScript(({ broken, id }) => {
    if (localStorage.getItem("reconciliation-fixture")) return;
    localStorage.setItem("reconciliation-fixture", "ready");
    localStorage.setItem(broken, "{");
    localStorage.setItem(`spool-outbox:fixture:one:${id}`, JSON.stringify({
      id, text: "Recover this valid saved message.", status: "sending", created_at: new Date().toISOString(),
    }));
  }, { broken, id });
  await page.goto(`${app.origin}/#/fixture/agents/engineer?task=one`, { waitUntil: "domcontentloaded" });
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  await expect(editor).toHaveAttribute("aria-disabled", "false", { timeout: 20000 });
  await expect.poll(async () => (await app.commands()).length).toBe(1);
  await editor.fill("New work must still be sendable.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(editor).toHaveText("");
  await expect.poll(async () => (await app.commands()).length).toBe(2);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), broken), "{", "Do not destroy unrecoverable input.");
  await page.reload();
  await expect(editor).toHaveAttribute("aria-disabled", "false");
  assert.equal((await app.commands()).length, 2);
});
