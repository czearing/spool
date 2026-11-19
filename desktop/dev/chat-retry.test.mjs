import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";

test("chat automatically recovers lost acknowledgements without duplicates or erasing newer drafts", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-chat-retry-"));
  const project = { id: "fixture", name: "Fixture", root: join(root, "project") };
  let server, browser;
  t.after(async () => {
    await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true });
  });

  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [project] }));
  for (const folder of ["agents", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project.root, folder), { recursive: true });
  await writeFile(join(project.root, "agents", "engineer.md"), "# Fixture; never run a model.");
  const task = { id: "one", title: "Existing conversation", agent: "engineer", prompt: "Original work",
    status: "completed", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), session_id: "fixture" };
  await writeFile(join(project.root, "queues", "completed", "one.json"), JSON.stringify(task));
  server = await startProductionApp(root);
  const origin = server.url;
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);
  const sends = [], queued = new Map();
  let release;
  const confirmation = new Promise(resolve => { release = resolve; });
  let reconnecting = false;
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/api/projects/fixture/tasks/one/conversation*", async route => {
    if (route.request().method() !== "POST") return route.fulfill({ json: {
      task: { id: task.id, title: task.title, agent: task.agent, prompt: task.prompt, status: task.status,
        interaction: { messages: [...queued.values()] } },
      entries: [], available: true, limited: false, nextBefore: null, cursor: 0,
      canSend: true, readOnlyReason: "", activity: "completed", raw: true, logId: "fixture",
      ...(reconnecting ? { connection: { message: "Reconnecting to your Codespace. Your messages are saved." },
        task: { ...task, status: "failed", interaction: { messages: [...queued.values()] },
          error: "Copilot ACP startup failed: Codespace preparation is not ready: Copilot ACP closed its output" },
        entries: [{ id: "log:0", offset: 0, kind: "stderr", ts: task.created_at,
          text: "[Copilot ACP setup] Checking assigned Codespace" }],
        activity: "waiting" } : {}),
    } });
    const input = route.request().postDataJSON(); sends.push(input);
    if (sends.length <= 2) return route.fulfill({ status: 409,
      json: { error: "Session workspace branch changed; continuation refused", rejected: true } });
    queued.set(input.id, { id: input.id, text: input.message, status: "queued", created_at: new Date().toISOString() });
    if (sends.length === 3) return route.fulfill({ status: 504,
      json: { error: "Waiting for confirmation", rejected: false } });
    if (sends.length === 4) return route.abort("connectionreset");
    if (sends.length === 5) await confirmation;
    await route.fulfill({ json: { id: input.id, state: "queued" } });
  });
  await page.goto(`${origin}/#/fixture/agents/engineer?task=one`, { waitUntil: "domcontentloaded" });
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  const sendError = page.getByRole("alert").filter({ hasText: "branch changed" });
  const failed = page.getByRole("article", { name: "You message", exact: true }).filter({ hasText: "Keep this exact draft." });
  await editor.fill("Keep this exact draft.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(sendError).toContainText("branch changed");
  await expect(editor).toHaveText("");
  await failed.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => sends.length).toBe(2);
  await expect(sendError).toContainText("branch changed");
  assert.notEqual(sends[1].id, sends[0].id, "An in-place retry must replace a definitively rejected identity.");
  await page.reload();
  await expect(editor).toHaveText("");
  await expect(sendError).toContainText("branch changed");
  await failed.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => sends.length).toBe(5);
  await expect(sendError).toHaveCount(0);
  assert.notEqual(sends[2].id, sends[1].id, "A definitively rejected command must not survive a reload.");
  await editor.fill("A newer message must survive automatic recovery.");
  release();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await expect(editor).toHaveText("A newer message must survive automatic recovery.");
  assert.deepEqual(sends[3], sends[2], "Automatic recovery must reuse the exact identity and content.");
  assert.deepEqual(sends[4], sends[2], "A dropped connection must retry the same message too.");
  assert.equal(queued.size, 1);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(editor).toHaveText("");
  assert.equal(queued.size, 2, "A delayed earlier message must not block a new one.");
  await page.reload();
  await expect(page.getByText("Keep this exact draft.", { exact: true })).toHaveCount(1);
  await expect(page.getByText("A newer message must survive automatic recovery.", { exact: true })).toHaveCount(1);
  assert.equal(sends[0].message, sends[1].message);
  reconnecting = true;
  await page.reload();
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting to your Codespace" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Copilot ACP startup failed", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Checking assigned Codespace", { exact: false })).toHaveCount(0);
  await expect(editor).toBeEnabled();
  await editor.fill("Keep this draft during reconnection.");
  await page.reload();
  await expect(editor).toHaveText("Keep this draft during reconnection.");
  const legacy = { id: crypto.randomUUID(), markdown: "Recover a pending message from the previous version.",
    createdAt: new Date().toISOString() };
  await page.addInitScript(pending => {
    if (sessionStorage.getItem("legacy-draft-installed")) return;
    sessionStorage.setItem("spool-chat:fixture:one", JSON.stringify({ markdown: "Keep this draft during reconnection.", pending }));
    sessionStorage.setItem("legacy-draft-installed", "1");
  }, legacy);
  await page.reload();
  await expect.poll(() => queued.size).toBe(3);
  await expect.poll(() => page.evaluate(id => {
    const key = Object.keys(localStorage).find(key => key.startsWith("spool-outbox:") && JSON.parse(localStorage.getItem(key)).id === id);
    return key && JSON.parse(localStorage.getItem(key)).status;
  }, legacy.id)).toBe("queued");
  await expect(editor).toHaveText("Keep this draft during reconnection.");
  await page.reload();
  await expect(editor).toHaveText("Keep this draft during reconnection.");
  await expect(page.getByText(legacy.markdown, { exact: true })).toHaveCount(1);
  assert.equal(sends.filter(input => input.id === legacy.id).length, 1, "Migrating a pending draft must retain its identity without resubmitting it.");
});
