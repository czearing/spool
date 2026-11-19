import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";

test("conversation drag archives into closed targets and restores without changing threads", { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-conversation-archive-"));
  const project = { id: "fixture", name: "Fixture", root: join(root, "project") };
  let server, browser;
  t.after(async () => { await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [project] }));
  for (const folder of ["agents", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project.root, folder), { recursive: true });
  await writeFile(join(project.root, "agents", "engineer.md"), "# Fixture; never run a model.");
  for (const [id, title] of [["one", "Current conversation"], ["two", "Archived conversation"]])
    await writeFile(join(project.root, "queues", "completed", `${id}.json`), JSON.stringify({
      id, title, agent: "engineer", status: "completed", prompt: "Keep original", session_id: `session-${id}`,
      updated_at: "2026-11-04T00:00:00Z",
    }));
  const original = await readFile(join(project.root, "queues", "completed", "one.json"), "utf8");
  server = await createServer({ root: resolve(import.meta.dirname, ".."), spoolDataDirectory: root,
    server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`, endpoint = `${origin}/api/projects/fixture/tasks`;
  const update = (id, value) => fetch(`${endpoint}/${id}/archive`, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(value) });
  assert.equal((await update("two", { archived: true })).status, 200);
  assert.equal((await update("one", { archived: "yes" })).status, 400);
  assert.equal((await update("missing", { archived: true })).status, 404);
  assert.equal((await fetch(`${endpoint}/one/archive`, { method: "POST",
    headers: { Origin: "https://foreign.invalid", "Content-Type": "application/json" },
    body: '{"archived":true}' })).status, 403);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.goto(`${origin}/#/fixture/agents/engineer`, { waitUntil: "domcontentloaded" });
  const history = () => page.getByRole("navigation", { name: "Conversations", exact: true });
  const archive = () => history().getByRole("button", { name: "Archive", exact: true });
  const conversations = () => history().getByRole("region", { name: "Conversations", exact: true });
  const archiveTarget = () => history().locator("section").filter({ has: page.getByRole("button", { name: "Archive", exact: true }) });
  const source = title => history().getByRole("link", { name: title, exact: true });
  const pickUp = async title => {
    await expect(source(title)).toHaveAttribute("aria-disabled", "false");
    await source(title).hover();
    const box = await source(title).boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2, { steps: 2 });
    await expect(source(title)).toHaveAttribute("data-dragging", "true");
  };
  const dropOn = async target => {
    const box = await target.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 14), { steps: 12 });
    await expect(target).toHaveAttribute("data-over", "true");
    const saved = page.waitForResponse(response => response.url().endsWith("/archive") && response.request().method() === "POST");
    await page.mouse.up();
    await saved;
  };
  await expect(source("Current conversation")).toBeVisible({ timeout: 30000 });
  await expect(archive()).toHaveAttribute("aria-expanded", "false");
  await pickUp("Current conversation");
  await dropOn(archiveTarget());
  await expect(source("Current conversation")).toHaveCount(0);
  await expect(archive()).toHaveAttribute("aria-expanded", "false");
  assert.equal(page.url(), `${origin}/#/fixture/agents/engineer`);
  await archive().click();
  await expect(source("Current conversation")).toBeVisible();
  await pickUp("Archived conversation");
  await dropOn(conversations());
  await expect(conversations().getByRole("link", { name: "Archived conversation", exact: true })).toBeVisible();
  await page.reload();
  await expect(conversations().getByRole("link", { name: "Archived conversation", exact: true })).toBeVisible();
  await expect(archive()).toHaveAttribute("aria-expanded", "false");
  await pickUp("Archived conversation");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(conversations().getByRole("link", { name: "Archived conversation", exact: true })).toBeVisible();
  assert.equal(page.url(), `${origin}/#/fixture/agents/engineer`);
  await expect(source("Archived conversation")).toHaveAttribute("aria-disabled", "false");
  await source("Archived conversation").focus();
  await page.keyboard.press("Space");
  await expect(source("Archived conversation")).toHaveAttribute("data-dragging", "true");
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.keyboard.press("ArrowDown");
  await expect(archiveTarget()).toHaveAttribute("data-over", "true");
  await page.keyboard.press("Space");
  await expect(source("Archived conversation")).toHaveCount(0);
  await expect(archive()).toBeFocused();
  await archive().click();
  await expect(source("Archived conversation")).toHaveAttribute("aria-disabled", "false");
  await source("Archived conversation").focus();
  await page.keyboard.press("Space");
  await expect(source("Archived conversation")).toHaveAttribute("data-dragging", "true");
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.keyboard.press("ArrowUp");
  await expect(conversations()).toHaveAttribute("data-over", "true");
  await page.keyboard.press("Space");
  await expect(conversations().getByRole("link", { name: "Archived conversation", exact: true })).toBeVisible();
  await expect(source("Archived conversation")).toBeFocused();
  await page.setViewportSize({ width: 800, height: 900 });
  await page.getByRole("button", { name: "Open conversations", exact: true }).click();
  await expect(source("Archived conversation")).toBeVisible();
  await pickUp("Archived conversation");
  await dropOn(archiveTarget());
  await expect(source("Archived conversation")).toHaveCount(0);
  await archive().click();
  await expect(source("Archived conversation")).toBeVisible();
  await pickUp("Archived conversation");
  await dropOn(conversations());
  await expect(conversations().getByRole("link", { name: "Archived conversation", exact: true })).toBeVisible();
  await page.route("**/tasks/two/archive", route => route.fulfill({ status: 500, json: { error: "Move failed." } }));
  await pickUp("Archived conversation");
  await dropOn(archiveTarget());
  await expect(history().getByRole("alert")).toHaveText("Move failed.");
  await expect(conversations().getByRole("link", { name: "Archived conversation", exact: true })).toBeVisible();
  await page.unroute("**/tasks/two/archive");
  assert.equal((await update("one", { archived: false })).status, 200);
  await expect(archive()).toHaveCount(0);
  await pickUp("Current conversation");
  await expect(archive()).toHaveAttribute("aria-expanded", "false");
  await dropOn(archiveTarget());
  await expect(source("Current conversation")).toHaveCount(0);
  await expect(archive()).toHaveAttribute("aria-expanded", "false");
  assert.equal((await update("one", { archived: false })).status, 200);
  await expect(archive()).toHaveCount(0);
  await expect(source("Current conversation")).toHaveAttribute("aria-disabled", "false");
  const touch = await page.context().newCDPSession(page);
  const box = await source("Current conversation").boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] });
  await page.waitForTimeout(220);
  await expect(source("Current conversation")).toHaveAttribute("data-dragging", "true");
  const target = await archiveTarget().boundingBox();
  await touch.send("Input.dispatchTouchEvent", { type: "touchMove",
    touchPoints: [{ x: target.x + target.width / 2, y: target.y + target.height / 2, id: 1 }] });
  await expect(archiveTarget()).toHaveAttribute("data-over", "true");
  const saved = page.waitForResponse(response => response.url().endsWith("/one/archive") && response.request().method() === "POST");
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  assert.equal((await saved).status(), 200);
  await expect(source("Current conversation")).toHaveCount(0);
  await page.route("**/tasks/two/conversation", route => route.fulfill({ status: 404, json: { error: "Fixture conversation." } }));
  await source("Archived conversation").click();
  await expect(page).toHaveURL(`${origin}/#/fixture/agents/engineer?task=two`);
  assert.equal(await readFile(join(project.root, "queues", "completed", "one.json"), "utf8"), original);
  assert.deepEqual(errors, []);
});

test("Tasks and agent history share archive state, including failures without queue records", { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-shared-archive-"));
  const project = { id: "fixture", name: "Fixture", root: join(root, "project") };
  let server, browser;
  t.after(async () => { await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [project] }));
  for (const folder of ["agents", "controls/manual-history", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project.root, folder), { recursive: true });
  await writeFile(join(project.root, "agents", "engineer.md"), "# Fixture; never run a model.");
  for (const [id, status, title] of [["one", "completed", "Shared conversation"], ["two", "failed", "Failed conversation"]])
    await writeFile(join(project.root, "queues", status, `${id}.json`), JSON.stringify({
      id, title, agent: "engineer", status, updated_at: "2026-11-04T00:00:00Z",
    }));
  const failedPreparation = join(project.root, "controls", "manual-history", "recovery.json");
  await writeFile(failedPreparation, JSON.stringify({ status: "failed", detail: "spawn gh ENOENT",
    request: { kind: "create", taskId: "recovery", title: "Library performance recovery", agent: "engineer" } }));
  const original = await readFile(failedPreparation, "utf8");
  server = await createServer({ root: resolve(import.meta.dirname, ".."), spoolDataDirectory: root,
    server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/tasks/*/conversation*", route => route.fulfill({ status: 404, json: { error: "Fixture conversation." } }));
  await page.goto(`${origin}/#/fixture/tasks`, { waitUntil: "domcontentloaded" });
  const board = () => page.getByRole("region", { name: "Work items", exact: true });
  await expect(board().locator("[data-work-item-id]")).toHaveCount(3, { timeout: 30000 });
  const navigate = path => page.evaluate(path => { window.location.hash = path; }, path);
  const conversations = () => page.getByRole("navigation", { name: "Conversations", exact: true })
    .getByRole("region", { name: "Conversations", exact: true });
  const move = async (title, archive) => {
    const source = page.getByRole("navigation", { name: "Conversations", exact: true })
      .getByRole("link", { name: title, exact: true });
    await expect(source).toHaveAttribute("aria-disabled", "false");
    await source.focus();
    await page.keyboard.press("Space");
    await expect(source).toHaveAttribute("data-dragging", "true");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.keyboard.press(archive ? "ArrowDown" : "ArrowUp");
    await expect(page.getByRole("navigation", { name: "Conversations", exact: true })
      .locator(`[data-archive="${archive}"]`)).toHaveAttribute("data-over", "true");
    const saved = page.waitForResponse(response => response.url().endsWith("/archive") && response.request().method() === "POST");
    await page.keyboard.press("Space");
    assert.equal((await saved).status(), 200);
  };
  await navigate("/fixture/agents/engineer");
  await expect(conversations().getByRole("link", { name: "Library performance recovery", exact: true })).toBeVisible();
  await move("Shared conversation", true);
  await expect(conversations().getByRole("link", { name: "Shared conversation", exact: true })).toHaveCount(0);
  await navigate("/fixture/tasks");
  await expect(board().locator("[data-work-item-id]")).toHaveCount(2);
  await expect(board().locator('[data-work-item-id="one"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Failed actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move all to archive", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Archive all failed tasks?", exact: true });
  await expect(dialog).toContainText("Move all 2 tasks");
  await dialog.getByRole("button", { name: "Move all to archive", exact: true }).click();
  await expect(board().locator("[data-work-item-id]")).toHaveCount(0);
  await page.reload();
  await expect(board().locator("[data-work-item-id]")).toHaveCount(0);
  await navigate("/fixture/agents/engineer");
  await expect(conversations().getByRole("link")).toHaveCount(0);
  await page.getByRole("navigation", { name: "Conversations", exact: true }).getByRole("button", { name: "Archive", exact: true }).click();
  await move("Library performance recovery", false);
  await expect(conversations().getByRole("link", { name: "Library performance recovery", exact: true })).toBeVisible();
  await move("Library performance recovery", true);
  await expect(conversations().getByRole("link", { name: "Library performance recovery", exact: true })).toHaveCount(0);
  await navigate("/fixture/tasks");
  await expect(board().locator("[data-work-item-id]")).toHaveCount(0);
  assert.equal(await readFile(failedPreparation, "utf8"), original);
  assert.deepEqual(errors, []);
});
