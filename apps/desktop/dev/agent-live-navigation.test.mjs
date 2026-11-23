import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";

test("agent components load independently of metadata and history and survive live refreshes", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-agent-navigation-"));
  const project = { id: "fixture", name: "Fixture", root: join(root, "project") };
  let server, browser, releaseHistory, releaseMetadata, failHistory = false, historyReads = 0, metadataReads = 0;
  const history = new Promise(resolve => { releaseHistory = resolve; });
  const metadata = new Promise(resolve => { releaseMetadata = resolve; });
  t.after(async () => {
    releaseHistory(); releaseMetadata();
    await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true });
  });

  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [project] }));
  for (const folder of ["agents", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project.root, folder), { recursive: true });
  for (const agent of ["engineer", "perf"])
    await writeFile(join(project.root, "agents", `${agent}.md`), "# Fixture; never run a model.");
  await writeFile(join(project.root, "queues", "completed", "one.json"), JSON.stringify({
    id: "one", title: "Perf conversation", agent: "perf", status: "completed", updated_at: "2026-11-03T00:00:00Z",
  }));
  server = await startProductionApp(root);
  const origin = server.url;
  const legacy = await fetch(`${origin}/api/desktop/page?path=${encodeURIComponent("/fixture/agents/perf")}`);
  assert.equal(legacy.status, 200);
  const legacyPage = (await legacy.json()).page;
  assert.equal(legacyPage.kind, "agent");
  assert.equal(legacyPage.agent, "perf");
  assert.deepEqual(legacyPage.jobs.current, []);
  assert.deepEqual(legacyPage.jobs.history.map(job => job.id), ["one"]);
  const compatibility = await fetch(`${origin}/api/desktop/page?deferAgentJobs=1&path=${encodeURIComponent("/fixture/agents/perf")}`);
  assert.deepEqual((await compatibility.json()).page.jobs, legacyPage.jobs);
  const response = await fetch(`${origin}/api/desktop/page?deferAgentJobs=2&path=${encodeURIComponent("/fixture/agents/perf")}`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).page, { kind: "agent", agent: "perf" });
  assert.equal((await fetch(`${origin}/api/projects/fixture/agents/missing/jobs`)).status, 404);
  assert.equal((await fetch(`${origin}/api/projects/missing/agents/perf/jobs`)).status, 404);
  browser = await chromium.launch();
  const page = await browser.newPage();
  const liveRequests = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/live")) liveRequests.push(url);
  });
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/api/desktop/page?*", async route => {
    assert.equal(new URL(route.request().url()).searchParams.get("deferAgentJobs"), "2");
    metadataReads++;
    if (new URL(route.request().url()).searchParams.get("path")?.endsWith("/agents/perf")) await metadata;
    await route.continue();
  });
  await page.route("**/api/projects/fixture/agents/perf/jobs?*", async route => {
    historyReads++;
    await history;
    if (failHistory) await route.fulfill({ status: 503, json: { error: "History temporarily unavailable." } });
    else await route.continue();
  });
  await page.goto(`${origin}/#/fixture/agents/engineer`,
    { waitUntil: "domcontentloaded" });
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  await expect(editor).toBeVisible();
  await page.getByRole("button", { name: /^Agents/ }).click();
  await page.getByRole("link", { name: "perf", exact: true }).click();
  await expect(page.getByRole("heading", { name: "perf", exact: true })).toBeVisible();
  await expect(editor).toBeVisible();
  await expect.poll(() => historyReads).toBe(1);
  await expect(page.getByText("Loading Spool...", { exact: true })).toHaveCount(0);
  await expect(page.getByText("No conversations yet.", { exact: true })).not.toBeVisible();
  await editor.fill("Draft survives delayed metadata and history");
  await editor.evaluate(element => { window.savedComposer = element; });
  failHistory = true;
  releaseHistory(); releaseMetadata();
  await expect(page.getByRole("button", { name: "Retry conversations", exact: true })).toBeVisible();
  assert.equal(await editor.evaluate(element => element === window.savedComposer), true);
  await expect(editor).toHaveText("Draft survives delayed metadata and history");
  failHistory = false;
  await page.getByRole("button", { name: "Retry conversations", exact: true }).click();
  await expect(page.getByRole("link", { name: "Perf conversation", exact: true })).toBeVisible();
  const readsBeforeRefresh = historyReads, pagesBeforeRefresh = metadataReads;
  await writeFile(join(project.root, "queues", "completed", "two.json"), JSON.stringify({
    id: "two", title: "Another perf conversation", agent: "perf", updated_at: "2026-11-03T00:01:00Z",
  }));
  await expect(page.getByRole("link", { name: "Another perf conversation", exact: true })).toBeVisible();
  assert.ok(historyReads > readsBeforeRefresh, "The existing stream must invalidate independent saved-history queries.");
  assert.equal(metadataReads, pagesBeforeRefresh, "Queue changes must only refresh history, not the entire page.");
  assert.equal(await editor.evaluate(element => element === window.savedComposer), true);
  await expect(editor).toHaveText("Draft survives delayed metadata and history");
  await writeFile(join(project.root, "queues", "completed", "two.json"), JSON.stringify({
    id: "two", title: "Updated perf conversation", agent: "perf", updated_at: "2026-11-03T00:01:00Z",
  }));
  await expect(page.getByRole("link", { name: "Updated perf conversation", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "engineer", exact: true }).click();
  await expect(page.getByRole("heading", { name: "engineer", exact: true })).toBeVisible();
  await expect(editor).toHaveText("");
  await expect(page.getByRole("link", { name: "Perf conversation", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "perf", exact: true }).click();
  await expect(editor).toHaveText("Draft survives delayed metadata and history");
  await expect(page.getByRole("link", { name: "Perf conversation", exact: true })).toBeVisible();
  assert.equal(liveRequests.length, 1, "Agent navigation must retain one project activity stream.");
  assert.equal(liveRequests[0].search, "", "Activity must not load a selected agent's indexed history.");
});

test("one watched snapshot updates both sidebars through pending, starting and running", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-agent-activity-"));
  const project = { id: "fixture", name: "Fixture", root: join(root, "project") };
  let server, browser, provider;
  t.after(async () => {
    await browser?.close(); await server?.close();
    if (provider && provider.exitCode === null) {
      const closed = once(provider, "exit"); provider.kill(); await closed;
    }
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [project] }));
  for (const directory of ["agents", "controls", ...["incoming", "in_progress", "completed", "failed"].map(queue => join("queues", queue))])
    await mkdir(join(project.root, directory), { recursive: true });
  await writeFile(join(project.root, "agents", "engineer.md"), "# Fixture; never run a model.");
  server = await startProductionApp(root);
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  let liveRequests = 0, jobRequests = 0;
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/live")) { liveRequests++; assert.equal(request.headers().accept, "text/event-stream"); }
    if (url.pathname.endsWith("/jobs")) jobRequests++;
  });
  await page.goto(`${server.url}/#/fixture/agents/engineer`,
    { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("textbox", { name: "Message agent", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Agents/ }).click();
  const conversation = page.getByRole("link", { name: "Watched conversation", exact: true });
  const incoming = join(project.root, "queues", "incoming", "work.json");
  const running = join(project.root, "queues", "in_progress", "work.json");
  const task = { id: "work", agent: "engineer", title: "Watched conversation", updated_at: "2026-11-03T00:00:00Z" };
  const publish = async (file, value) => {
    await writeFile(`${file}.tmp`, JSON.stringify(value));
    for (let attempt = 0; ; attempt++) {
      try { await rename(`${file}.tmp`, file); return; }
      catch (error) {
        if (attempt === 9 || !["EPERM", "EBUSY"].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  };
  await publish(incoming, task);
  await expect(conversation.getByText("Pending", { exact: true })).toBeVisible();
  await expect(page.getByLabel("engineer: 1 pending task", { exact: true })).toHaveText("1");
  await expect(page.getByLabel("Agents: 1 pending task", { exact: true })).toHaveText("1");
  await publish(incoming, { ...task, interaction: { phase: "starting" } });
  await rename(incoming, running);
  await expect(conversation.getByText("Starting", { exact: true })).toBeVisible();
  await expect(page.getByLabel("engineer: 1 starting session", { exact: true })).toHaveText("1");
  await expect(page.getByLabel("Agents: 1 starting session", { exact: true })).toHaveText("1");
  const token = "spool-provider-activity-fixture";
  provider = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", token], { stdio: "ignore", windowsHide: true });
  await once(provider, "spawn");
  await publish(running, { ...task, interaction: { phase: "running" }, provider: { pid: provider.pid, token } });
  await expect(conversation.getByText("Running", { exact: true })).toBeVisible();
  await expect(page.getByLabel("engineer: 1 active session", { exact: true })).toHaveText("1");
  await expect(page.getByLabel("Agents: 1 active session", { exact: true })).toHaveText("1");
  await expect(page.getByLabel("engineer: 1 starting session", { exact: true })).toHaveCount(0);
  await rename(running, join(project.root, "queues", "completed", "work.json"));
  await expect(conversation.getByText("Completed", { exact: true })).toBeVisible();
  await expect(page.getByLabel("engineer: 1 active session", { exact: true })).toHaveCount(0);
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.equal(liveRequests, 1, "Activity must stay on one stream instead of polling.");
  assert.ok(jobRequests > 0, "Saved conversations must load independently of the activity stream.");
});
