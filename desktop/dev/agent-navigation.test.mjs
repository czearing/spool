import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";

for (const navigateWhileDeleting of [false, true])
test(navigateWhileDeleting ? "agent deletion respects navigation while the request is pending" :
  "busy agents delete immediately from the UI without changing queued, active or historical jobs", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-busy-agent-delete-"));
  const project = { id: "fixture", name: "Fixture", root: join(root, "project") };
  let server, browser, releaseDelete = () => {};
  t.after(async () => { releaseDelete(); await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [project] }));
  for (const directory of ["agents", "controls", ...["incoming", "in_progress", "completed", "failed"].map(queue => join("queues", queue))])
    await mkdir(join(project.root, directory), { recursive: true });
  for (const agent of ["engineer", "reviewer"])
    await writeFile(join(project.root, "agents", `${agent}.md`), "# Fixture; never run a model.");
  const jobs = ["incoming", "in_progress", "completed", "failed"].map(queue => ({
    file: join(project.root, "queues", queue, `${queue}.json`),
    content: JSON.stringify({ id: queue, title: `${queue} work`, agent: "engineer", prompt: "Fixture",
      status: queue, updated_at: "2026-11-04T00:00:00Z" }),
  }));
  for (const job of jobs) await writeFile(job.file, job.content);
  server = await startProductionApp(root);
  const origin = server.url;
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.goto(`${origin}/#/fixture/agents/${navigateWhileDeleting ? "reviewer" : "engineer"}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /^Agents/ }).click();
  const agentLink = page.locator('a[href="#/fixture/agents/engineer"]');
  await expect(agentLink).toBeVisible();
  if (navigateWhileDeleting) {
    await agentLink.click();
    await expect(page.getByRole("heading", { name: "engineer", exact: true })).toBeVisible();
  }
  const endpoint = `${origin}/api/projects/fixture/agents/engineer`;
  assert.equal((await page.request.delete(endpoint, { headers: { Origin: "https://foreign.invalid" } })).status(), 403);
  await page.getByRole("button", { name: "Agent actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete agent", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete agent?", exact: true });
  await expect(dialog).toContainText("immediately removes");
  await expect(dialog).not.toContainText("cannot be deleted");
  const deleted = page.waitForResponse(response => response.url() === endpoint && response.request().method() === "DELETE");
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const pending = new Promise(resolve => { releaseDelete = resolve; });
  if (navigateWhileDeleting) await page.route(endpoint, async route => {
    if (route.request().method() === "DELETE") { requestStarted(); await pending; }
    await route.continue();
  });
  await dialog.getByRole("button", { name: "Delete agent", exact: true }).click();
  if (navigateWhileDeleting) {
    await started;
    await page.goBack();
    await expect(page).toHaveURL(`${origin}/#/fixture/agents/reviewer`);
    releaseDelete();
  }
  assert.equal((await deleted).status(), 204);
  await expect(page).toHaveURL(`${origin}/#/fixture${navigateWhileDeleting ? "/agents/reviewer" : ""}`);
  await expect(agentLink).toHaveCount(0);
  assert.deepEqual(await readdir(join(project.root, "agents")), ["reviewer.md"]);
  for (const job of jobs) assert.equal(await readFile(job.file, "utf8"), job.content);
  await page.reload();
  assert.equal((await page.request.get(endpoint)).status(), 404);
  await expect(agentLink).toHaveCount(0);
});

test("navigation preserves unsaved prompts and flushes saved edits before leaving", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-navigation-guard-")), project = join(root, "project");
  let app, browser;
  t.after(async () => { await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "fixture", name: "Fixture", root: project }] }));
  for (const directory of ["agents", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, directory), { recursive: true });
  for (const agent of ["engineer", "reviewer"])
    await writeFile(join(project, "agents", `${agent}.md`), "Original fixture instructions.");
  app = await startProductionApp(root);
  browser = await chromium.launch();
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/api/projects/fixture/agents/engineer", async route => {
    if (route.request().method() === "PUT") await route.fulfill({ status: 503, json: { error: "Fixture save unavailable." } });
    else await route.continue();
  });
  await page.goto(`${app.url}/#/fixture/agents/engineer/prompt`, { waitUntil: "domcontentloaded" });
  const prompt = page.getByRole("textbox", { name: "engineer prompt", exact: true });
  await expect(prompt).toBeVisible();
  await prompt.fill("Preserve my unsaved instructions.");
  await expect(page.getByLabel("Prompt save status", { exact: true })).toContainText("Not saved");
  const nav = page.getByRole("navigation", { name: "Project navigation", exact: true });
  await nav.getByRole("button", { name: "Agents", exact: true }).click();
  const reviewer = nav.getByRole("link", { name: "reviewer", exact: true });
  await reviewer.click();
  const warning = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
  await expect(warning).toBeVisible();
  await warning.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(prompt).toHaveText("Preserve my unsaved instructions.");
  await expect(page).toHaveURL(`${app.url}/#/fixture/agents/engineer/prompt`);
  await reviewer.click();
  await warning.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL(`${app.url}/#/fixture/agents/reviewer`);
  assert.equal(await readFile(join(project, "agents", "engineer.md"), "utf8"), "Original fixture instructions.");
  await page.getByRole("button", { name: "Agent actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit prompt", exact: true }).click();
  const saved = page.getByRole("textbox", { name: "reviewer prompt", exact: true });
  await expect(saved).toBeVisible();
  await saved.fill("Saved before leaving.");
  await nav.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page).toHaveURL(`${app.url}/#/fixture`);
  await expect(warning).toHaveCount(0);
  assert.equal(await readFile(join(project, "agents", "reviewer.md"), "utf8"), "Saved before leaving.");
  assert.deepEqual(errors, []);
});

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
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/api/desktop/page?*", async route => {
    assert.equal(new URL(route.request().url()).searchParams.get("deferAgentJobs"), "2");
    metadataReads++;
    if (new URL(route.request().url()).searchParams.get("path")?.endsWith("/agents/perf")) await metadata;
    await route.continue();
  });
  await page.route("**/api/projects/fixture/live?agent=perf", async route => {
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
  await expect(page.getByText("No conversations yet.", { exact: true })).toHaveCount(0);
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
  assert.equal(historyReads, readsBeforeRefresh, "Queue changes must arrive on the existing stream.");
  assert.equal(metadataReads, pagesBeforeRefresh, "Queue changes must only refresh history, not the entire page.");
  assert.equal(await editor.evaluate(element => element === window.savedComposer), true);
  await expect(editor).toHaveText("Draft survives delayed metadata and history");
  await page.getByRole("link", { name: "engineer", exact: true }).click();
  await expect(page.getByRole("heading", { name: "engineer", exact: true })).toBeVisible();
  await expect(editor).toHaveText("");
  await expect(page.getByRole("link", { name: "Perf conversation", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "perf", exact: true }).click();
  await expect(editor).toHaveText("Draft survives delayed metadata and history");
  await expect(page.getByRole("link", { name: "Perf conversation", exact: true })).toBeVisible();
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
  assert.equal(jobRequests, 0, "Both sidebars must use the same snapshot, not refetch conversation status.");
});
