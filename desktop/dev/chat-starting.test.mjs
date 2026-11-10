import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";

test("new and accepted messages remain visible throughout startup and history gaps", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-chat-starting-")), project = join(root, "project");
  let server, browser, releaseHistory, blocked = false, reads = 0, task, sent, requests = 0;
  t.after(async () => {
    releaseHistory?.(); await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true });
  });
  for (const directory of ["agents", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, directory), { recursive: true });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "fixture", name: "Fixture", root: project }] }));
  await writeFile(join(project, "agents", "engineer.md"), "# Isolated fixture; never launch a provider.");
  server = await createServer({ root: resolve(import.meta.dirname, ".."), spoolDataDirectory: root,
    server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage(), origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  page.setDefaultNavigationTimeout(60000);
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  let gate = Promise.resolve(), entries = [], receipts = [];
  const blockHistory = () => { blocked = true; gate = new Promise(resolve => { releaseHistory = resolve; }); };
  const unblockHistory = () => { blocked = false; releaseHistory?.(); };
  await page.route("**/api/projects/fixture/tasks", async route => {
    if (route.request().method() !== "POST") return route.continue();
    const input = route.request().postDataJSON(), now = new Date().toISOString();
    task = { id: `manual-${input.requestId}`, title: input.title, agent: input.agent, prompt: input.prompt,
      status: "incoming", created_at: now, updated_at: now };
    await writeFile(join(project, "queues", "incoming", `${task.id}.json`), JSON.stringify(task));
    blockHistory();
    await route.fulfill({ status: 201, json: { id: task.id, state: "accepted", notice: "Preparing workspace." } });
  });
  await page.route("**/api/projects/fixture/tasks/*/conversation*", async route => {
    if (route.request().method() === "POST") {
      sent = route.request().postDataJSON(); requests++;
      return route.fulfill({ json: { id: sent.id, state: "accepted" } });
    }
    reads++;
    if (blocked) await gate;
    await route.fulfill({ json: { task: { ...task, createdAt: task.created_at, interaction: { messages: receipts } },
      entries, available: entries.length > 0, raw: entries.length > 0, logId: entries.length ? "log" : null,
      cursor: entries.length, nextBefore: null, limited: false, canSend: true, readOnlyReason: "", activity: "starting" } });
  });
  await page.goto(`${origin}/#/fixture/agents/engineer`, { waitUntil: "domcontentloaded" });
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  const message = text => page.getByRole("article", { name: "You message", exact: true }).filter({ hasText: text });
  const opening = "Keep my opening message visible while the agent starts.";
  await editor.fill(opening);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => reads).toBeGreaterThan(0);
  await expect(page).toHaveURL(/task=manual-/);
  await expect(message(opening)).toBeVisible();
  await expect(message(opening)).toContainText("Queued");
  unblockHistory();
  await expect(editor).toHaveAttribute("aria-disabled", "false");
  await page.reload();
  await expect(message(opening)).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  const followup = "Keep my accepted follow-up visible before it reaches the transcript.";
  await editor.fill(followup);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(editor).toHaveText("");
  await expect(message(followup)).toContainText("Queued");
  blockHistory();
  const before = reads;
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(message(followup)).toBeVisible();
  unblockHistory();
  receipts = [{ id: sent.id, text: followup, status: "delivered", created_at: new Date().toISOString() }];
  await page.reload();
  await expect(message(followup)).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("spool-pending:")).length)).toBe(1);
  entries = [{ id: "log:0", offset: 0, kind: "user", ts: new Date().toISOString(), text: followup, messageId: sent.id }];
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("spool-pending:")).length)).toBe(0);
  await expect(message(followup)).toHaveCount(1);
  await expect(message(opening)).toHaveCount(1);
  await page.reload();
  await expect(message(followup)).toHaveCount(1);
  assert.equal(requests, 1, "Reloading an accepted message must never send it a second time.");
});
