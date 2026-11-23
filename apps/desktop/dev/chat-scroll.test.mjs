import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";

test("reading position wins over streaming, new replies and history measurements until returning to latest", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-chat-scroll-")), project = join(root, "project");
  let app, browser, revision = 0, mutations = 0, historyReads = 0;
  t.after(async () => { await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true }); });
  for (const directory of ["agents", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, directory), { recursive: true });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "fixture", name: "Fixture", root: project }] }));
  await writeFile(join(project, "agents", "engineer.md"), "# Isolated test; never launch a provider.");
  await writeFile(join(project, "queues", "completed", "one.json"), JSON.stringify({
    id: "one", title: "Scroll regression", agent: "engineer", prompt: "", status: "completed",
    created_at: "2026-11-19T00:00:00Z", updated_at: "2026-11-19T00:00:00Z", session_id: "fixture",
  }));
  const entry = (offset, text) => ({ id: `log:${offset}`, offset, kind: "assistant", ts: "2026-11-19T00:00:00Z", text });
  const entries = Array.from({ length: 80 }, (_, index) =>
    entry(100_000 + index * 1000, `Reply ${index}.\n\n${"A paragraph with readable history.\n\n".repeat(index % 5 === 0 ? 20 : 2)}`));
  entries.push(entry(200_000, `Streaming reply.\n\n${"The current reply grows while earlier messages remain readable.\n\n".repeat(25)}`));
  const older = Array.from({ length: 30 }, (_, index) =>
    entry(index * 1000, `Earlier reply ${index}.\n\n${"Earlier history has variable heights.\n\n".repeat(index % 3 === 0 ? 15 : 2)}`));
  app = await startProductionApp(root);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    if (!["GET", "HEAD"].includes(route.request().method())) mutations++;
    await route.fallback();
  });
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/api/projects/fixture/tasks/one/conversation*", async route => {
    const history = new URL(route.request().url()).searchParams.has("before");
    if (history) historyReads++;
    await route.fulfill({ json: {
      task: { id: "one", title: "Scroll regression", agent: "engineer", prompt: "", status: "completed" },
      entries: history ? older : entries, available: true, limited: !history,
      nextBefore: history ? null : 100_000, cursor: history ? 100_000 : 1_000_000 + revision * 1000,
      canSend: true, readOnlyReason: "", activity: "completed", raw: true, logId: "fixture",
    } });
  });
  await page.goto(`${app.url}/#/fixture/agents/engineer?task=one`, { waitUntil: "domcontentloaded" });
  const chat = page.getByRole("region", { name: "Task conversation", exact: true });
  const latest = page.getByRole("button", { name: "Latest messages", exact: true });
  const distance = () => chat.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
  const settle = () => chat.evaluate(element => new Promise(resolve => {
    let previous = element.scrollTop, stable = 0;
    const frame = () => {
      stable = element.scrollTop === previous ? stable + 1 : 0;
      previous = element.scrollTop;
      if (stable >= 3) resolve(); else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
  await expect(chat.getByText("Streaming reply.", { exact: true })).toBeAttached();
  await expect.poll(distance).toBeLessThan(2);
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  await editor.fill("Keep this unsent draft.");

  const grow = async () => {
    revision++;
    const marker = `Stream update ${revision}.`;
    entries.at(-1).text += `\n\n${marker}\n\n${"Another streamed paragraph.\n\n".repeat(3)}`;
    await expect(chat.getByText(marker, { exact: true })).toBeAttached();
    await settle();
  };
  for (const delta of [4, 40]) {
    await chat.hover();
    await page.mouse.wheel(0, -delta);
    await expect.poll(distance).toBeGreaterThan(delta / 2);
    await settle();
    const before = await chat.evaluate(element => element.scrollTop);
    await grow();
    assert.ok(Math.abs(await chat.evaluate(element => element.scrollTop) - before) < 2,
      `A ${delta}px upward wheel gesture must disengage following; streaming must not pull the reader back down.`);
    await expect(latest).toBeVisible();
    await latest.click();
    await expect.poll(distance).toBeLessThan(2);
    await grow();
    await expect.poll(distance).toBeLessThan(2);
  }

  await chat.focus();
  await page.keyboard.press("ArrowUp");
  await expect(latest).toBeVisible();
  await settle();
  const keyboardTop = await chat.evaluate(element => element.scrollTop);
  await grow();
  assert.ok(Math.abs(await chat.evaluate(element => element.scrollTop) - keyboardTop) < 2,
    "Keyboard history navigation must also disengage following.");

  await chat.evaluate(element => { element.scrollTop -= 800; });
  await settle();
  const anchor = async () => chat.evaluate(element => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll("[data-message-id]")].find(row => {
      const bounds = row.getBoundingClientRect();
      return bounds.bottom > top && bounds.top < top + element.clientHeight;
    });
    if (!row) throw new Error("No visible anchor row");
    return { id: row.dataset.messageId, top: row.getBoundingClientRect().top };
  });
  const position = await anchor();
  revision++;
  entries.push(entry(201_000, "A new reply must not steal the reading position."));
  await expect(chat.getByRole("list", { name: "Conversation messages", exact: true }))
    .toHaveAttribute("data-message-count", String(entries.length));
  await settle();
  await expect(chat.locator(`[data-message-id="${position.id}"]`)).toHaveCount(1);
  assert.ok(Math.abs((await chat.locator(`[data-message-id="${position.id}"]`).boundingBox()).y - position.top) < 2);

  const viewportTop = (await chat.boundingBox()).y;
  await page.getByRole("button", { name: "Load earlier messages", exact: true }).click();
  await expect.poll(() => historyReads).toBe(1);
  await expect(page.getByRole("button", { name: "Load earlier messages", exact: true })).toHaveCount(0);
  await settle();
  const afterHistory = await chat.locator(`[data-message-id="${position.id}"]`).boundingBox();
  assert.ok(Math.abs((afterHistory.y - (await chat.boundingBox()).y) - (position.top - viewportTop)) < 2,
    "Prepending must preserve the visible message anchor within the conversation viewport.");
  await latest.click();
  await expect(chat.getByText("A new reply must not steal the reading position.", { exact: true })).toBeVisible();
  await expect.poll(distance).toBeLessThan(2);
  await chat.evaluate(element => { element.scrollTop -= 40; });
  await expect(latest).toBeVisible();
  await chat.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(distance).toBeLessThan(2);
  await grow();
  await expect.poll(distance).toBeLessThan(2);
  await expect(editor).toHaveText("Keep this unsent draft.");
  assert.equal(mutations, 0, "Reading and returning to latest must never submit work.");
  assert.deepEqual(errors, []);
});
