import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";

test("cached projects and conversations switch without waiting for metadata or history", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-project-switching-"));
  const projects = ["alpha", "beta"].map(id => ({ id, name: id, root: join(root, id) }));
  let app, browser, mutations = 0, holdPages = false, releasePages;
  const held = new Promise(resolve => { releasePages = resolve; }), reads = [];
  t.after(async () => {
    releasePages();
    await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects }));
  const save = async (project, id, title) => {
    const file = join(project.root, "queues", "completed", `${id}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify({
      id, title, prompt: `${project.id} original work`, agent: "engineer", status: "completed",
      session_id: `fixture-${id}`, created_at: "2026-11-04T10:00:00Z", updated_at: "2026-11-04T10:00:00Z", turns: 0,
    }));
    await rename(`${file}.tmp`, file);
  };
  for (const project of projects) {
    for (const child of ["agents", "logs", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
      await mkdir(join(project.root, child), { recursive: true });
    await writeFile(join(project.root, "agents", "engineer.md"), "# Isolated fixture; never launch a provider.");
    await Promise.all(Array.from({ length: 60 }, (_, index) => save(project, `${project.id}-${index}`, `${project.id} task ${index}`)));
  }
  app = await startProductionApp(root);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  // Keep the query cache fresh without faking performance.now or animation frames.
  await page.addInitScript(() => { const now = Date.now(); Date.now = () => now; });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (!["GET", "HEAD"].includes(request.method())) mutations++;
    if (url.pathname === "/api/desktop/page") {
      reads.push(url.searchParams.get("path"));
      if (holdPages) await held;
    }
    await route.fallback();
  });
  const nav = page.getByRole("navigation", { name: "Project navigation", exact: true });
  const switchProject = async id => {
    await page.getByRole("button", { name: /^Switch project,/ }).click();
    return page.getByRole("menuitemradio", { name: id, exact: true }).click();
  };
  const expandAgents = async () => {
    const agents = nav.getByRole("button", { name: /^Agents/ });
    if (await agents.getAttribute("aria-expanded") !== "true") await agents.click();
  };
  const task = id => page.locator(`li[data-work-item-id="${id}-0"]`);
  await page.goto(`${app.url}/#/alpha/tasks`, { waitUntil: "domcontentloaded" });
  await expect(task("alpha")).toBeVisible();
  await switchProject("beta");
  await expect(task("beta")).toBeVisible();
  await task("alpha").evaluate(node => { window.savedAlphaRow = node; });
  const initialReads = reads.length;
  const session = await page.context().newCDPSession(page);
  const measurements = [];
  for (const rate of [1, 4]) {
    await session.send("Emulation.setCPUThrottlingRate", { rate });
    const timings = [];
    for (const id of ["alpha", "beta", "alpha", "beta"]) {
      await page.getByRole("button", { name: /^Switch project,/ }).click();
      timings.push(await page.evaluate(id => new Promise((resolve, reject) => {
        const option = [...document.querySelectorAll('[role="menuitemradio"]')].find(node => node.textContent === id && node.checkVisibility());
        const start = performance.now();
        let clickMs;
        const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("Cached project did not paint.")); }, 2000);
        const observer = new MutationObserver(() => {
          if (![...document.querySelectorAll(`button[aria-label="Switch project, ${id}"]`)].some(node => node.checkVisibility()) ||
            !document.querySelector(`li[data-work-item-id="${id}-0"]`)?.checkVisibility()) return;
          observer.disconnect(); clearTimeout(timeout);
          const visibleMs = performance.now() - start;
          requestAnimationFrame(() => resolve({ clickMs, visibleMs, paintMs: performance.now() - start }));
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        option.click();
        clickMs = performance.now() - start;
      }), id));
      await expect(task(id)).toBeVisible();
      await expect(task(id === "alpha" ? "beta" : "alpha")).toBeHidden();
      if (id === "alpha") assert.equal(await task("alpha").evaluate(node => node === window.savedAlphaRow), true,
        "Returning to a project must reuse its existing task DOM.");
    }
    measurements.push({ cpuThrottle: rate, samples: timings });
  }
  const extraWarmPageRequests = reads.length - initialReads;
  assert.equal(extraWarmPageRequests, 0, "Warm project switches must not refetch page metadata.");
  console.log(JSON.stringify({ cachedProjectPaint: measurements, extraWarmPageRequests }));
  for (const { cpuThrottle, samples } of measurements) assert.ok(Math.max(...samples.map(sample => sample.paintMs)) < 100 * cpuThrottle,
    `Cached project paint must stay within the 100ms response budget at ${cpuThrottle}x CPU throttling.`);
  holdPages = true;
  await switchProject("alpha");
  await expect(task("alpha")).toBeVisible();
  await expandAgents();
  holdPages = false;
  await nav.getByRole("link", { name: "engineer", exact: true }).click();
  await page.getByRole("navigation", { name: "Conversations", exact: true })
    .getByRole("link", { name: "alpha task 0", exact: true }).click();
  const conversation = page.getByRole("region", { name: "Task conversation" });
  await expect(conversation).toContainText("alpha original work");
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  await editor.fill("Keep this unsent alpha draft.");
  await conversation.evaluate(node => { window.savedConversation = node; });
  await switchProject("beta");
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await page.goBack();
  await expect(conversation).toContainText("alpha original work");
  assert.equal(await conversation.evaluate(node => node === window.savedConversation), true,
    "Browser back must reveal the same conversation DOM and selection.");
  await expect(editor).toHaveText("Keep this unsent alpha draft.");
  await nav.getByRole("link", { name: "Tasks", exact: true }).click();
  await switchProject("beta");
  await expect(task("beta")).toBeVisible();
  holdPages = true;
  await page.route("**/api/projects/alpha/tasks/alpha-0/conversation*", async route => {
    await held; await route.continue();
  });
  await switchProject("alpha");
  await expect(task("alpha")).toBeVisible();
  await expandAgents();
  await nav.getByRole("link", { name: "engineer", exact: true }).click();
  await page.getByRole("navigation", { name: "Conversations", exact: true })
    .getByRole("link", { name: "alpha task 0", exact: true }).click();
  await expect(conversation).toContainText("alpha original work");
  await expect(editor).toHaveText("Keep this unsent alpha draft.");
  await expect(page.getByText("Loading Spool...", { exact: true })).toHaveCount(0);
  releasePages(); holdPages = false;
  await nav.getByRole("link", { name: "Tasks", exact: true }).click();
  await switchProject("beta");
  await expect(task("beta")).toBeVisible();
  await save(projects[0], "fresh", "Fresh task while alpha was inactive");
  await switchProject("alpha");
  await expect(page.getByRole("button", { name: "Open conversation: Fresh task while alpha was inactive", exact: true })).toBeVisible();
  const betaReads = reads.filter(path => path === "/beta/tasks").length;
  await page.goBack();
  await expect(task("beta")).toBeVisible();
  assert.equal(reads.filter(path => path === "/beta/tasks").length, betaReads,
    "An alpha queue update must not invalidate beta's cached page.");
  await page.goForward();
  await expect(task("alpha")).toBeVisible();
  assert.equal(mutations, 0, "Switching projects must not send messages or launch agents.");
  assert.deepEqual(errors, []);
});
