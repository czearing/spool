import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";

test("chat retries replace rejected identities but preserve uncertain sends and drafts across reloads", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-chat-retry-")), previous = { ...process.env };
  const project = { id: "fixture", name: "Fixture", root: join(root, "project") };
  let server, browser;
  t.after(async () => {
    await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  process.env.SPOOL_DATA_DIR = root;
  await writeFile(join(root, "connections.json"), JSON.stringify({ SPOOL_PROJECTS_FILE: join(root, "projects.json") }));
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [project] }));
  for (const folder of ["agents", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project.root, folder), { recursive: true });
  await writeFile(join(project.root, "agents", "engineer.md"), "# Fixture; never run a model.");
  const task = { id: "one", title: "Existing conversation", agent: "engineer", prompt: "Original work",
    status: "completed", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), session_id: "fixture" };
  await writeFile(join(project.root, "queues", "completed", "one.json"), JSON.stringify(task));
  server = await createServer({ root: resolve(import.meta.dirname, ".."), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);
  const sends = [];
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/api/projects/fixture/tasks/one/conversation*", async route => {
    if (route.request().method() !== "POST") return route.fulfill({ json: {
      task: { id: task.id, title: task.title, agent: task.agent, prompt: task.prompt, status: task.status },
      entries: [], available: true, limited: false, nextBefore: null, cursor: 0,
      canSend: true, readOnlyReason: "", activity: "completed", raw: true, logId: "fixture",
    } });
    const input = route.request().postDataJSON(); sends.push(input);
    if (sends.length <= 2) return route.fulfill({ status: 409,
      json: { error: "Session workspace branch changed; continuation refused", rejected: true } });
    if (sends.length === 3) return route.fulfill({ status: 504,
      json: { error: "Waiting for confirmation", rejected: false } });
    await route.fulfill({ json: { id: input.id, state: "accepted" } });
  });
  await page.goto(`${origin}/#/fixture/agents/engineer?task=one`, { waitUntil: "domcontentloaded" });
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  const sendError = page.getByRole("alert").filter({ hasText: "Could not confirm send:" });
  await editor.fill("Keep this exact draft.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(sendError).toContainText("branch changed");
  await expect(editor).toHaveText("Keep this exact draft.");
  await page.getByRole("button", { name: "Retry sending message", exact: true }).click();
  await expect.poll(() => sends.length).toBe(2);
  await expect(sendError).toContainText("branch changed");
  assert.notEqual(sends[1].id, sends[0].id, "An in-place retry must replace a definitively rejected identity.");
  await page.reload();
  await expect(editor).toHaveText("Keep this exact draft.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(sendError).toContainText("Waiting for confirmation");
  assert.notEqual(sends[2].id, sends[1].id, "A definitively rejected command must not survive a reload.");
  await page.reload();
  await expect(editor).toHaveText("Keep this exact draft.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(editor).toHaveText("");
  assert.deepEqual(sends[3], sends[2], "An uncertain send must reuse its exact identity and content.");
  assert.equal(sends[0].message, sends[1].message);
});
