import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";

test("reopening long and short latest windows does not backfill unread history", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-conversation-latest-")), project = join(root, "project");
  let server, browser, latest = false, history = false, olderReads = 0, mutations = 0, release;
  t.after(async () => { release(); await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); });
  for (const directory of ["agents", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, directory), { recursive: true });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "fixture", name: "Fixture", root: project }] }));
  await writeFile(join(project, "agents", "engineer.md"), "# Isolated test; never launch a provider.");
  for (const id of ["one", "two"]) await writeFile(join(project, "queues", "completed", `${id}.json`), JSON.stringify({
    id, title: `Conversation ${id}`, agent: "engineer", prompt: "", status: "completed",
    created_at: "2026-11-13T00:00:00Z", updated_at: "2026-11-13T00:00:00Z", session_id: `fixture-${id}`,
  }));
  server = await createServer({ root: resolve(import.meta.dirname, ".."), spoolDataDirectory: root,
    server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  browser = await chromium.launch();
  for (const short of [false, true]) {
  latest = false; history = false; olderReads = 0; mutations = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } }), errors = [];
  page.setDefaultNavigationTimeout(60000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    if (!["GET", "HEAD"].includes(route.request().method())) mutations++;
    await route.fallback();
  });
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  const entry = (offset, text) => ({ id: `log:${offset}`, offset, kind: "assistant", ts: "2026-11-13T00:00:00Z", text });
  let latestReads = 0;
  await page.route("**/api/projects/fixture/tasks/*/conversation*", async route => {
    const url = new URL(route.request().url()), id = url.pathname.split("/").at(-2), before = url.searchParams.get("before");
    const isLatest = id === "one" && latest;
    if (isLatest && before === null) latestReads++;
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
      task: { id, title: `Conversation ${id}`, agent: "engineer", prompt: "", status: "completed",
        interaction: { messages: id === "one" ? [{ id: "pending", text: "Queued follow-up stays visible.",
          status: "queued", created_at: "2026-11-13T00:01:00Z" }] : [] } },
      entries, available: true, limited: isLatest && before === null, nextBefore: isLatest && before === null ? 20_000_000 : null,
      cursor: before !== null ? 20_000_000 : isLatest ? 20_020_100 : 100,
      canSend: true, readOnlyReason: "", activity: "completed", raw: true, logId: id,
    } });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/fixture/agents/engineer?task=one`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Cached one last reply", { exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByRole("link", { name: "Conversation two", exact: true }).click();
  await expect(page.getByText("Cached two last reply", { exact: true })).toBeVisible();
  latest = true;
  const start = Date.now();
  await page.getByRole("link", { name: "Conversation one", exact: true }).click();
  const viewport = page.getByRole("region", { name: "Task conversation", exact: true });
  await expect(page.getByText("Newest reply after a long backlog.", { exact: true })).toBeVisible({ timeout: 10000 });
  console.log(JSON.stringify({ cachedBacklogBytes: 20_000_000, latestVisibleMs: Date.now() - start, automaticHistoryReads: olderReads }));
  await expect(page.getByText("Queued follow-up stays visible.", { exact: true })).toBeVisible();
  await expect.poll(() => latestReads).toBeGreaterThanOrEqual(2);
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
  await expect(editor).toHaveText("Keep this draft while reading history.");
  assert.ok(olderReads > 0);
  assert.equal(mutations, 0);
  assert.deepEqual(errors, []);
  await page.close();
  }
});
