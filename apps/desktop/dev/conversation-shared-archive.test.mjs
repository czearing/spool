import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";

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
