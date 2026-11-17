import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";

for (const short of [false, true]) test(`reopening a long conversation shows its ${short ? "short" : "long"} latest window without downloading the gap`, { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-conversation-latest-")), project = join(root, "project");
  let app, browser, latest = false, history = false, olderReads = 0, mutations = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(async () => { release(); await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true }); });
  for (const directory of ["agents", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, directory), { recursive: true });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "fixture", name: "Fixture", root: project }] }));
  await writeFile(join(project, "agents", "engineer.md"), "# Isolated test; never launch a provider.");
  for (const id of ["one", "two"]) await writeFile(join(project, "queues", "completed", `${id}.json`), JSON.stringify({
    id, title: `Conversation ${id}`, agent: "engineer", prompt: "", status: "completed",
    created_at: "2026-11-13T00:00:00Z", updated_at: "2026-11-13T00:00:00Z", session_id: `fixture-${id}`,
  }));
  app = await startProductionApp(root);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    if (!["GET", "HEAD"].includes(route.request().method())) mutations++;
    await route.fallback();
  });
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  const entry = (offset, text) => ({ id: `log:${offset}`, offset, kind: "assistant", ts: "2026-11-13T00:00:00Z", text });
  await page.route("**/api/projects/fixture/tasks/*/conversation*", async route => {
    const url = new URL(route.request().url()), id = url.pathname.split("/").at(-2), before = url.searchParams.get("before");
    const isLatest = id === "one" && latest;
    if (before !== null) {
      olderReads++;
      if (!history) await gate;
    }
    const entries = before !== null ? [entry(100, "Earlier unread reply")] : isLatest
      ? short ? [entry(20_020_000, "Newest reply after a long backlog.")] :
        [entry(20_000_000, "First reply in the newest window.\n\n" + "A readable paragraph.\n\n".repeat(180)),
        entry(20_010_000, "Middle reply.\n\n" + "More readable text.\n\n".repeat(180)),
        entry(20_020_000, "Newest reply after a long backlog.")]
      : [entry(0, `Cached ${id} first reply`), entry(20, `Cached ${id} middle reply`), entry(40, `Cached ${id} last reply`)];
    await route.fulfill({ json: {
      task: { id, title: `Conversation ${id}`, agent: "engineer", prompt: "", status: "completed" },
      entries, available: true, limited: isLatest && before === null, nextBefore: isLatest && before === null ? 20_000_000 : null,
      cursor: before !== null ? 20_000_000 : isLatest ? 20_020_100 : 100,
      canSend: true, readOnlyReason: "", activity: "completed", raw: true, logId: id,
    } });
  });
  await page.goto(`${app.url}/#/fixture/agents/engineer?task=one`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Cached one last reply", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Conversation two", exact: true }).click();
  await expect(page.getByText("Cached two last reply", { exact: true })).toBeVisible();
  latest = true;
  const start = Date.now();
  await page.getByRole("link", { name: "Conversation one", exact: true }).click();
  const viewport = page.getByRole("region", { name: "Task conversation", exact: true });
  await expect(page.getByText("Newest reply after a long backlog.", { exact: true })).toBeVisible({ timeout: 3000 });
  console.log(JSON.stringify({ cachedBacklogBytes: 20_000_000, latestVisibleMs: Date.now() - start, automaticHistoryReads: olderReads }));
  assert.equal(olderReads, 0, "Opening must not backfill the unread backlog.");
  await expect(page.getByText("Cached one first reply", { exact: true })).toHaveCount(0);
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  await editor.fill("Keep this draft while reading history.");
  history = true; release();
  if (short) await page.getByRole("button", { name: "Load earlier messages", exact: true }).click();
  else await viewport.evaluate(element => element.scrollTo({ top: 0 }));
  await expect(page.getByText("Earlier unread reply", { exact: true })).toBeAttached();
  await viewport.evaluate(element => element.scrollTo({ top: 0 }));
  await expect(page.getByText("Earlier unread reply", { exact: true })).toBeVisible();
  assert.ok(olderReads > 0, "Scrolling up must still load older messages.");
  await expect(editor).toHaveText("Keep this draft while reading history.");
  assert.equal(mutations, 0);
  assert.deepEqual(errors, []);
});
