import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startProductionApp } from "./production-app.mjs";

test("agent navigation immediately restores each selected conversation without waiting for the network", { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-agent-chat-restore-"));
  let app, browser, blocked = false, release = () => {}, writes = 0;
  t.after(async () => { release(); await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true }); });
  const projects = ["fixture", "other"].map(id => ({ id, name: id, root: join(root, id) }));
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects }));
  for (const project of projects) {
    for (const folder of ["agents", "logs", "controls", ...["incoming", "in_progress", "completed", "failed"].map(queue => join("queues", queue))])
      await mkdir(join(project.root, folder), { recursive: true });
    for (const agent of ["engineer", "reviewer"]) {
      await writeFile(join(project.root, "agents", `${agent}.md`), "# Isolated navigation fixture; do not launch a provider.");
      for (const suffix of ["one", "two"]) {
        const id = `${agent}-${suffix}`, at = "2026-11-19T20:00:00Z";
        await writeFile(join(project.root, "queues", "completed", `${id}.json`), JSON.stringify({
          id, agent, title: id, status: "completed", prompt: `Original ${id}`, session_id: "saved-fixture",
          created_at: at, updated_at: at,
        }));
        await writeFile(join(project.root, "logs", `${id}.log`), JSON.stringify({
          type: "assistant.message", timestamp: at, data: { content: `${project.id}_${id}_REPLY` },
        }) + "\n");
      }
    }
  }
  app = await startProductionApp(root);
  browser = await chromium.launch();
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/models", route => route.fulfill({ json: [] }));
  const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/api/**", async route => {
    if (!["GET", "HEAD"].includes(route.request().method())) writes++;
    if (blocked) await gate;
    await route.fallback();
  });
  await page.goto(`${app.url}/#/fixture/agents/engineer?task=engineer-one`, { waitUntil: "domcontentloaded" });
  const transcript = page.getByRole("region", { name: "Task conversation", exact: true });
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  const nav = page.getByRole("navigation", { name: "Project navigation", exact: true });
  const chats = page.getByRole("navigation", { name: "Conversations", exact: true });
  await expect(transcript).toContainText("fixture_engineer-one_REPLY");
  await editor.click();
  await editor.pressSequentially("Typing into the existing agent conversation.");
  await expect(editor).toHaveText("Typing into the existing agent conversation.");
  await nav.getByRole("button", { name: /^Agents/ }).click();
  await chats.getByRole("link", { name: "engineer-two", exact: true }).click();
  await expect(transcript).toContainText("fixture_engineer-two_REPLY");
  await transcript.evaluate(element => { window.savedAgentTranscripts = new Map([["engineer", element]]); });
  await nav.getByRole("link", { name: "reviewer", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What would you like to work on?", exact: true })).toBeVisible();
  await chats.getByRole("link", { name: "reviewer-two", exact: true }).click();
  await expect(transcript).toContainText("fixture_reviewer-two_REPLY");
  await transcript.evaluate(element => { window.savedAgentTranscripts.set("reviewer", element); });
  blocked = true;
  const samples = [];
  for (let iteration = 0; iteration < 3; iteration++) {
    for (const agent of ["engineer", "reviewer"]) {
      const sample = await nav.getByRole("link", { name: agent, exact: true }).evaluate(async (link, agent) => {
        const started = performance.now(), empty = "What would you like to work on?";
        let flashed = false;
        const observer = new MutationObserver(() => {
          flashed ||= [...document.querySelectorAll("h2")].some(heading => heading.checkVisibility() && heading.textContent === empty);
        });
        observer.observe(document.body, { subtree: true, childList: true, attributes: true });
        link.click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        observer.disconnect();
        const transcript = [...document.querySelectorAll('section[aria-label="Task conversation"]')]
          .find(element => element.checkVisibility());
        return { elapsed: performance.now() - started, flashed, hash: location.hash,
          text: transcript?.textContent ?? "", retained: transcript === window.savedAgentTranscripts.get(agent), agent };
      }, agent);
      assert.equal(sample.hash, `#/fixture/agents/${agent}?task=${agent}-two`);
      assert.ok(sample.text.includes(`fixture_${agent}-two_REPLY`), "Cached transcript must render within two frames while all API requests are blocked.");
      assert.equal(sample.flashed, false, "Restoration must not flash the new-conversation screen.");
      assert.equal(sample.retained, true, "Returning to an agent must reuse the already-rendered conversation.");
      samples.push(sample.elapsed);
      await editor.click();
      await editor.pressSequentially("Draft");
      await expect(editor).toHaveText("Draft");
      await editor.press("ControlOrMeta+A");
      await editor.press("Backspace");
      await expect(editor).toHaveText("");
    }
  }
  await nav.getByRole("link", { name: "reviewer", exact: true }).click();
  await expect(page).toHaveURL(`${app.url}/#/fixture/agents/reviewer?task=reviewer-two`);
  release(); blocked = false;
  await nav.getByRole("link", { name: "engineer", exact: true }).click();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What would you like to work on?", exact: true })).toBeVisible();
  await editor.click();
  await editor.pressSequentially("Keep this unsent new-chat draft");
  await nav.getByRole("link", { name: "reviewer", exact: true }).click();
  await expect(transcript).toContainText("fixture_reviewer-two_REPLY");
  await nav.getByRole("link", { name: "engineer", exact: true }).click();
  await expect(editor).toHaveText("Keep this unsent new-chat draft");
  await expect(transcript).toHaveCount(0);
  await page.goBack();
  await expect(transcript).toContainText("fixture_reviewer-two_REPLY");
  await page.goForward();
  await expect(editor).toHaveText("Keep this unsent new-chat draft");
  await editor.click();
  await editor.press("Control+End");
  await editor.pressSequentially(" Still editable.");
  await expect(editor).toHaveText("Keep this unsent new-chat draft Still editable.");
  await chats.getByRole("link", { name: "engineer-one", exact: true }).click();
  await expect(transcript).toContainText("fixture_engineer-one_REPLY");
  await expect(editor).toHaveText("Typing into the existing agent conversation.");
  await page.evaluate(() => { location.hash = "#/other/agents/engineer"; });
  await expect(page.getByRole("button", { name: "Switch project, other", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What would you like to work on?", exact: true })).toBeVisible();
  await chats.getByRole("link", { name: "engineer-two", exact: true }).click();
  await expect(transcript).toContainText("other_engineer-two_REPLY");
  await page.evaluate(() => { location.hash = "#/fixture"; });
  await expect(page.getByRole("button", { name: "Switch project, fixture", exact: true })).toBeVisible();
  await nav.getByRole("link", { name: "engineer", exact: true }).click();
  await expect(transcript).toContainText("fixture_engineer-one_REPLY");
  await expect(editor).toHaveText("Typing into the existing agent conversation.");
  await editor.click();
  await editor.press("Control+End");
  await editor.pressSequentially(" After switching projects.");
  await expect(editor).toHaveText("Typing into the existing agent conversation. After switching projects.");
  await page.evaluate(() => { location.hash = "#/other"; });
  await expect(page.getByRole("button", { name: "Switch project, other", exact: true })).toBeVisible();
  await nav.getByRole("button", { name: /^Agents/ }).click();
  await nav.getByRole("link", { name: "engineer", exact: true }).click();
  await expect(transcript).toContainText("other_engineer-two_REPLY");
  assert.equal(writes, 0, "Restoring chats must not submit messages or launch agents.");
  assert.deepEqual(errors, []);
  console.log(`Cached restoration: ${samples.map(value => `${Math.round(value)}ms`).join(", ")}`);
});
