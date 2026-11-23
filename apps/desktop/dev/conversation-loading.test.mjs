import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";

test("conversations warm on intent and retain cached content and drafts during background refresh", { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-conversation-loading-"));
  const project = { id: "fixture", name: "Fixture", root: join(root, "project") };
  const other = { id: "other", name: "Other fixture", root: join(root, "other") };
  let releaseRefresh, releasePage, holdRefresh = false, holdPage = false, refreshed = false, failRefresh = false;
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
  const pageGate = new Promise(resolve => { releasePage = resolve; });
  let server, browser;
  t.after(async () => {
    releaseRefresh(); releasePage();
    await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [project, other] }));
  for (const item of [project, other])
    for (const folder of ["agents", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
      await mkdir(join(item.root, folder), { recursive: true });
  await writeFile(join(project.root, "agents", "engineer.md"), "# Fixture; never run a model.");
  await writeFile(join(project.root, "agents", "reviewer.md"), "# Fixture; never run a model.");
  await writeFile(join(other.root, "agents", "other-agent.md"), "# Fixture; never run a model.");
  for (const id of ["one", "two"]) await writeFile(join(project.root, "queues", "completed", `${id}.json`), JSON.stringify({
    id, title: `Conversation ${id}`, agent: "engineer", prompt: `Original ${id}`,
    status: "completed", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), session_id: `fixture-${id}`,
  }));
  server = await startProductionApp(root, [{
    name: "hold-chat-renderer", enforce: "pre",
    transform(code, id) {
      if (id.replaceAll("\\", "/").endsWith("/src/components/task-chat-view.tsx"))
        return { code: `await new Promise(resolve => { globalThis.__releaseChatRenderer = resolve; });\n${code}`, map: null };
      if (id.replaceAll("\\", "/").endsWith("/src/desktop/app.tsx")) {
        const needle = "return <QueryClientProvider";
        assert.ok(code.includes(needle));
        return { code: code.replace(needle, `globalThis.__queryClient = client;\n${needle}`), map: null };
      }
      if (id.replaceAll("\\", "/").endsWith("/src/components/project-live-provider.tsx")) {
        const needle = "const snapshot = parseLive(JSON.parse(event.data));";
        assert.ok(code.includes(needle));
        return { code: code.replace(needle, `${needle}\nif (globalThis.__holdJobIndex) delete snapshot.jobs;`), map: null };
      }
    },
  }]);
  browser = await chromium.launch();
  const page = await browser.newPage();
  const reads = [], held = [], errors = [];
  let mutations = 0, heldPages = 0;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    if (!["GET", "HEAD"].includes(route.request().method())) mutations++;
    await route.fallback();
  });
  await page.route("**/api/desktop/page?*", async route => {
    if (holdPage && new URL(route.request().url()).searchParams.get("path") === "/fixture/agents/engineer") {
      heldPages++; await pageGate;
    }
    await route.fallback();
  });
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/api/projects/fixture/tasks/*/conversation*", async route => {
    assert.equal(route.request().method(), "GET", "Opening a conversation must not submit work.");
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    reads.push(id);
    if (holdRefresh) { held.push(id); await refreshGate; }
    if (failRefresh) return route.fulfill({ status: 503, json: { error: "Fixture history offline" } });
    await route.fulfill({ json: {
      task: { id, title: `Conversation ${id}`, agent: "engineer", prompt: `Original ${id}`, status: "completed" },
      entries: [{ kind: "assistant", ts: "2026-10-30T00:00:00Z", id: "log:0", offset: 0,
        text: `Reply ${id}${refreshed ? " refreshed" : ""}` }],
      available: true, limited: false, nextBefore: null, cursor: 1,
      canSend: true, readOnlyReason: "", activity: "completed", raw: true, logId: `fixture-${id}`,
    } });
  });
  await page.goto(`${server.url}/#/fixture/agents/engineer?task=one`,
    { waitUntil: "commit" });
  await page.waitForFunction(() => typeof globalThis.__releaseChatRenderer === "function");
  await expect.poll(() => reads.includes("one")).toBe(true);
  await expect(page.getByRole("status", { name: "Conversation pending", exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/Loading (Spool|conversations?|history)\.\.\./);
  assert.equal(await page.getByRole("textbox", { name: "Message agent", exact: true }).count(), 0);
  await page.evaluate(() => globalThis.__releaseChatRenderer());
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  await expect(page.getByRole("article").filter({ hasText: "Reply one" })).toBeVisible();
  await editor.fill("Draft for one");
  await page.getByRole("link", { name: "Conversation two", exact: true }).hover();
  await page.waitForFunction(() => !!globalThis.__queryClient.getQueryData(["task-conversation", "fixture", "two"]));
  assert.equal(reads.filter(id => id === "two").length, 1, "Intent must warm the same cache used by the conversation.");
  await expect(page).toHaveURL(/task=one$/);
  await expect(page.getByRole("article").filter({ hasText: "Reply two" })).toHaveCount(0);
  holdRefresh = true;
  await page.getByRole("link", { name: "Conversation two", exact: true }).click();
  await expect(page.getByRole("article").filter({ hasText: "Reply two" })).toBeVisible();
  await expect(editor).toHaveText("");
  await expect(page.getByRole("article").filter({ hasText: "Reply one" })).toHaveCount(0);
  await expect.poll(() => held.includes("two")).toBe(true);
  await expect(page.getByRole("article").filter({ hasText: "Reply two" })).toBeVisible();
  await page.getByRole("link", { name: "Conversation one", exact: true }).click();
  await expect(page.getByRole("article").filter({ hasText: "Reply one" })).toBeVisible();
  await expect(editor).toHaveText("Draft for one");
  await expect.poll(() => held.includes("one")).toBe(true);
  await expect(page.locator("body")).not.toContainText(/Loading (Spool|conversations?|history)\.\.\./);
  refreshed = true; holdRefresh = false; releaseRefresh();
  await expect(page.getByRole("article").filter({ hasText: "Reply one refreshed" })).toBeVisible();
  await expect(editor).toHaveText("Draft for one");
  failRefresh = true;
  const offline = page.getByRole("alert").filter({ hasText: "Fixture history offline" });
  await expect(offline).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("article").filter({ hasText: "Reply one refreshed" })).toBeVisible();
  await expect(editor).toHaveText("Draft for one");
  failRefresh = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(offline).toHaveCount(0);

  await page.getByRole("button", { name: "Switch project, Fixture", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Other fixture", exact: true }).click();
  await expect(page.getByRole("button", { name: "Switch project, Other fixture", exact: true })).toBeVisible();
  holdPage = true;
  await page.evaluate(() => {
    globalThis.__queryClient.removeQueries({ queryKey: ["desktop-page", "fixture", "/fixture/agents/engineer"], exact: true });
    globalThis.__queryClient.removeQueries({ queryKey: ["agent-jobs", "fixture", "engineer"], exact: true });
    globalThis.__holdJobIndex = true;
    window.location.hash = "/fixture/agents/engineer?task=one";
  });
  await expect.poll(() => heldPages).toBe(1);
  await expect(page.getByRole("button", { name: "Switch project, Fixture", exact: true })).toBeVisible();
  await expect(page.getByRole("article").filter({ hasText: "Reply one refreshed" })).toBeVisible();
  await expect(editor).toHaveText("Draft for one");
  assert.equal(await page.evaluate(() => globalThis.__queryClient.getQueryData(["agent-jobs", "fixture", "engineer"])), undefined,
    "A verified cached conversation must not wait for the live jobs index.");
  holdPage = false; releasePage();
  await page.waitForFunction(() => !!globalThis.__queryClient.getQueryData(["desktop-page", "fixture", "/fixture/agents/engineer"]));
  await page.evaluate(() => { window.location.hash = "/fixture/agents/reviewer?task=one"; });
  await expect(page.getByRole("heading", { name: "reviewer", exact: true })).toBeVisible();
  await expect(page.getByRole("article").filter({ hasText: "Reply one" })).toHaveCount(0);
  await expect(editor).toHaveCount(0);
  await page.evaluate(() => { globalThis.__holdJobIndex = false; });
  server.disconnect();
  await expect(page.getByRole("alert").filter({ hasText: "This conversation is not available for this agent." })).toBeVisible({ timeout: 10000 });
  assert.equal(mutations, 0, "Prefetch and cached navigation must never submit messages or start agents.");
  assert.deepEqual(errors, []);
});
