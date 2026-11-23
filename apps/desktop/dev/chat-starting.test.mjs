import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";

test("messages stay visible through new-chat navigation, preparation, startup and accepted-send reloads", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-chat-starting-")), project = join(root, "project");
  let app, browser, releaseHistory, blocked = false, reads = 0, task, taskFile;
  t.after(async () => {
    releaseHistory?.(); await browser?.close(); await app?.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const directory of ["agents", "logs", "controls/ui-submissions", "controls/manual",
    "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, directory), { recursive: true });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "fixture", name: "Fixture", root: project }] }));
  await writeFile(join(project, "agents", "engineer.md"), "# Isolated fixture; never launch a provider.");
  const publish = async (file, value) => { await writeFile(`${file}.next`, JSON.stringify(value)); await rename(`${file}.next`, file); };
  app = await startProductionApp(root);
  browser = await chromium.launch();
  const page = await browser.newPage(), sends = [];
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  const opening = "My opening message must stay visible while the agent starts.";
  let gate = Promise.resolve();
  const blockHistory = () => { blocked = true; gate = new Promise(resolve => { releaseHistory = resolve; }); };
  const unblockHistory = () => { blocked = false; releaseHistory?.(); };
  await page.route("**/api/projects/fixture/tasks", async route => {
    if (route.request().method() !== "POST") return route.continue();
    const input = route.request().postDataJSON(), now = new Date().toISOString();
    task = { id: `manual-${input.requestId}`, agent: input.agent, title: input.title, prompt: input.prompt,
      status: "incoming", created_at: now, updated_at: now, session_id: null, turns: 0 };
    taskFile = join(project, "queues", "in_progress", `${task.id}.json`);
    await publish(join(project, "controls", "ui-submissions", `${input.requestId}.json`),
      { taskId: task.id, phase: "preparing", task });
    await publish(join(project, "controls", "manual", `${input.requestId}.json`),
      { status: "preparing", detail: "Building required packages.",
        request: { kind: "create", taskId: task.id, agent: task.agent, title: task.title } });
    blockHistory();
    await route.fulfill({ status: 201, json: { id: task.id, state: "accepted", notice: "Queued for workspace preparation" } });
  });
  await page.route("**/api/projects/fixture/tasks/*/conversation*", async route => {
    if (route.request().method() === "POST") {
      const input = route.request().postDataJSON(); sends.push(input);
      return route.fulfill({ json: { id: input.id, state: "queued" } });
    }
    reads++;
    if (blocked) await gate;
    const response = await route.fetch(), data = await response.json();
    if (!data.available && !data.entries.length) { delete data.raw; delete data.logId; }
    await route.fulfill({ json: data });
  });
  await page.goto(`${app.url}/#/fixture/agents/engineer`, { waitUntil: "domcontentloaded" });
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  const message = text => page.getByRole("article", { name: "You message", exact: true }).filter({ hasText: text });
  await editor.fill(opening);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => reads).toBeGreaterThan(0);
  await expect(page).toHaveURL(/task=manual-/);
  await expect(message(opening)).toBeVisible();
  await expect(message(opening)).toContainText("Queued");
  unblockHistory();
  await expect(page.getByRole("status").filter({ hasText: "Building required packages." })).toBeVisible();
  await expect(message(opening)).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(message(opening)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  task = { ...task, status: "in_progress", interaction: { phase: "starting" } };
  await publish(taskFile, task);
  await expect(editor).toHaveAttribute("aria-disabled", "false");
  await expect(message(opening)).toHaveCount(1);
  const followup = "My accepted follow-up must survive startup and reload without being resent.";
  await editor.fill(followup);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => sends.length).toBe(1);
  await expect(editor).toHaveText("");
  await expect(message(followup)).toContainText("Queued");
  blockHistory();
  const before = reads;
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(message(followup)).toBeVisible();
  unblockHistory();
  await expect(editor).toHaveAttribute("aria-disabled", "false");
  await expect(message(followup)).toHaveCount(1);
  const sent = sends[0], receipt = { id: sent.id, text: sent.message, status: "queued", created_at: new Date().toISOString() };
  task = { ...task, interaction: { phase: "starting", messages: [receipt] } };
  await publish(taskFile, task);
  await page.reload();
  await expect(message(followup)).toContainText("Queued");
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("spool-outbox:")).length)).toBe(1);
  const event = (type, data) => JSON.stringify({ type, timestamp: new Date().toISOString(), data }) + "\n";
  await appendFile(join(project, "logs", `${task.id}.log`),
    event("user.message", { content: opening }) +
    event("user.message", { messageId: sent.id, content: followup }));
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("spool-outbox:")).length)).toBe(0);
  await expect(message(opening)).toHaveCount(1);
  await expect(message(followup)).toHaveCount(1);
  await page.reload();
  await expect(message(followup)).toHaveCount(1);
  assert.equal(sends.length, 1, "An accepted message must not be sent again after a reload.");
});
