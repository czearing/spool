import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";

test("durable sends stay queued past the old timeout and never erase a newer draft", { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-send-response-"));
  const project = { id: "fixture", name: "Fixture", root: join(root, "project") };
  let server, browser, timer, heartbeat = Promise.resolve();
  t.after(async () => {
    clearInterval(timer); await heartbeat; await browser?.close(); await server?.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [project] }));
  for (const folder of ["agents", "logs", "controls/results", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project.root, folder), { recursive: true });
  await writeFile(join(project.root, "agents", "engineer.md"), "# Fixture; never run a model.");
  const task = { id: "one", title: "Conversation", agent: "engineer", prompt: "Original work",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), interaction: { phase: "running" } };
  const taskFile = join(project.root, "queues", "in_progress", "one.json");
  await writeFile(taskFile, JSON.stringify(task));
  const capabilities = async () => {
    const file = join(project.root, "controls", "capabilities.json");
    await writeFile(`${file}.next`, JSON.stringify({ version: 1, interactive: true, taskControl: true, updatedAt: new Date().toISOString() }));
    await rename(`${file}.next`, file);
  };
  await capabilities(); timer = setInterval(() => { heartbeat = heartbeat.then(capabilities); }, 2000);
  server = await createServer({ root: resolve(import.meta.dirname, ".."), spoolDataDirectory: root,
    server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/fixture/agents/engineer?task=one`,
    { waitUntil: "domcontentloaded" });
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  await expect(editor).toHaveAttribute("aria-disabled", "false", { timeout: 20000 });
  await editor.fill("An immediately visible follow-up.");
  await page.evaluate(() => {
    document.addEventListener("submit", () => { window.sendStarted = performance.now(); }, { once: true, capture: true });
    const observer = new MutationObserver(() => {
      if (window.sendVisible !== undefined || ![...document.querySelectorAll("article")].some(article =>
        article.textContent.includes("An immediately visible follow-up."))) return;
      window.sendVisible = performance.now() - window.sendStarted;
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const sent = page.waitForRequest(request => request.method() === "POST" && request.url().includes("/conversation"));
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const input = (await sent).postDataJSON();
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(join(project.root, "controls", "requests", `${input.id}.json`), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }).toMatchObject({ id: input.id, message: input.message });
  const bubble = page.getByRole("article", { name: "You message", exact: true }).filter({ hasText: input.message });
  if (!process.env.SPOOL_SEND_BASELINE) {
    await expect(bubble).toBeVisible({ timeout: 750 });
    await expect(bubble).toContainText("Queued");
  }
  const elapsed = await page.evaluate(() => window.sendVisible);
  await expect(editor).toHaveText("");
  await editor.fill("A newer draft must survive confirmation.");
  await page.waitForTimeout(6500);
  if (!process.env.SPOOL_SEND_BASELINE) await expect(bubble).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(bubble).toHaveCount(1);
  await expect(bubble).toContainText("Queued");
  await expect(editor).toHaveText("A newer draft must survive confirmation.");
  await writeFile(taskFile, JSON.stringify({ ...task, interaction: { phase: "running",
    messages: [{ id: input.id, text: input.message, status: "queued", created_at: new Date().toISOString() }] } }));
  await writeFile(join(project.root, "controls", "results", `${input.id}.json`),
    JSON.stringify({ id: input.id, result: { status: "accepted" } }));
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
  await expect(bubble).toBeVisible();
  await expect(bubble).toContainText("Queued");
  await expect(bubble).toHaveCount(1);
  await expect(editor).toHaveText("A newer draft must survive confirmation.");
  assert.ok(Number.isFinite(elapsed));
  console.log(JSON.stringify({ pressToVisibleMessageMs: Number(elapsed.toFixed(1)), confirmationHeldMs: 6500 }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/fixture/agents/engineer`);
  await expect(page.getByRole("heading", { name: "What would you like to work on?" })).toBeVisible();
  let release;
  const acknowledgment = new Promise(resolve => { release = resolve; });
  let published = false;
  await page.route("**/api/projects/fixture/tasks", async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    published = true;
    await acknowledgment;
    await route.fulfill({ response });
  });
  try {
    await editor.fill("Start a responsive new conversation.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("article", { name: "You message", exact: true })
      .filter({ hasText: "Start a responsive new conversation." })).toContainText("Sending", { timeout: 750 });
    await expect.poll(() => published).toBe(true);
    await expect(editor).toHaveText("Start a responsive new conversation.");
  } finally { release(); }
  await expect(editor).toHaveText("");
  await expect(page.getByRole("article", { name: "You message", exact: true })
    .filter({ hasText: "Start a responsive new conversation." })).toBeVisible();
});
