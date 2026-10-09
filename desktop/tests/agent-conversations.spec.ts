import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./spool-task-fixture";

test.use({ interactive: true });
test.setTimeout(60000);
test("first message creates a native task, displays replies full-page and resumes the same conversation", async ({ page, projectServer: server, scheduler }) => {
  void scheduler;
  await rm(join(server.bohemia, "controls", "paused", "engineer"));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const base = `${server.url}/bohemia/agents/engineer`;
  await page.goto(base);
  const editor = page.getByRole("textbox", { name: "Message agent" });
  await editor.fill("Help me outline a book chapter.");
  const response = page.waitForResponse(response => response.url().endsWith("/api/projects/bohemia/tasks") && response.request().method() === "POST");
  const started = performance.now();
  await editor.press("Enter");
  const created = await response;
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  await expect(page).toHaveURL(`${base}?task=${id}`, { timeout: 2500 });
  expect(performance.now() - started).toBeLessThan(2500);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Task conversation" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Conversations", exact: true }).getByRole("link", {
    name: "Help me outline a book chapter.", exact: true,
  })).toHaveAttribute("aria-current", "page");
  const completed = join(server.bohemia, "queues", "completed", `${id}.json`);
  const readCompleted = async () => {
    try { return JSON.parse(await readFile(completed, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  await expect.poll(async () => (await readCompleted())?.session_id, { timeout: 15000 }).toBe("isolated-acp-session");
  const original = await readCompleted();
  expect(original).toMatchObject({ workspace: null, agent: "engineer", prompt: "Help me outline a book chapter.",
    title: "Help me outline a book chapter." });
  await expect(page.getByRole("article", { name: "engineer message" }).filter({ hasText: "Fixture received:" })).toBeVisible();
  await editor.fill("Make the ending hopeful.");
  await editor.press("Enter");
  await expect(editor).toBeEmpty();
  await expect.poll(async () => (await readCompleted())?.interaction.messages.at(-1)?.status, { timeout: 15000 }).toBe("delivered");
  const resumed = await readCompleted();
  expect(resumed.session_id).toBe(original.session_id);
  expect(resumed.session_config).toEqual(original.session_config);
  expect(resumed.interaction.messages.at(-1).text).toBe("Make the ending hopeful.");
  expect(await readdir(join(server.bohemia, "controls", "ui-submissions"))).toHaveLength(1);
  await expect(page.getByRole("region", { name: "Task conversation" })).toContainText("Make the ending hopeful.");
  await editor.fill("Unsent follow-up");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page).toHaveURL(base);
  await expect(editor).toBeEmpty();
  await editor.fill("A separate new draft");
  await page.goBack();
  await expect(page).toHaveURL(`${base}?task=${id}`);
  await expect(editor).toHaveText("Unsent follow-up");
  await page.reload();
  await expect(editor).toHaveText("Unsent follow-up");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(editor).toHaveText("A separate new draft");
  expect(errors).toEqual([]);
});

test("lost first-message acknowledgment retains the draft and retries exactly one task even after reload", async ({ page, projectServer: server, scheduler }) => {
  void scheduler;
  let first = true;
  await page.route("**/api/projects/bohemia/tasks", async route => {
    if (first) { first = false; expect((await route.fetch()).status()).toBe(201); await route.abort(); } else await route.continue();
  });
  await page.goto(`${server.url}/bohemia/agents/engineer`);
  const editor = page.getByRole("textbox", { name: "Message agent" });
  await editor.fill("Only create this conversation once.");
  await editor.press("Enter");
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  await expect(editor).toHaveText("Only create this conversation once.");
  expect(await readdir(join(server.bohemia, "queues", "incoming"))).toHaveLength(1);
  await page.reload();
  await expect(editor).toHaveText("Only create this conversation once.");
  await editor.press("Enter");
  await expect(page).toHaveURL(/\?task=manual-/);
  expect(await readdir(join(server.bohemia, "queues", "incoming"))).toHaveLength(1);
  expect(await readdir(join(server.bohemia, "controls", "ui-submissions"))).toHaveLength(1);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(editor).toBeEmpty();
});

test("agent drafts stay separate and another agent's task cannot be opened through the selected URL", async ({ page, projectServer: server }) => {
  const editor = page.getByRole("textbox", { name: "Message agent" });
  await page.goto(`${server.url}/bohemia/agents/engineer`);
  await editor.fill("Engineering draft");
  await page.goto(`${server.url}/bohemia/agents/reviewer`);
  await expect(editor).toBeEmpty();
  await editor.fill("Review draft");
  await page.goto(`${server.url}/bohemia/agents/engineer`);
  await expect(editor).toHaveText("Engineering draft");
  await writeFile(join(server.bohemia, "queues", "completed", "private.json"), JSON.stringify({
    id: "private", title: "Reviewer-only work", agent: "reviewer", prompt: "Do not fetch this conversation.", status: "completed",
  }));
  const requests: string[] = [];
  page.on("request", request => { if (request.url().includes("/tasks/private/conversation")) requests.push(request.url()); });
  await page.goto(`${server.url}/bohemia/agents/engineer?task=private`);
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("This conversation is not available for this agent.");
  expect(requests).toEqual([]);
  await page.getByRole("main").getByRole("button", { name: "New chat", exact: true }).last().click();
  await expect(editor).toHaveText("Engineering draft");
  await editor.press("Enter");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Spool is offline");
  await expect(editor).toHaveText("Engineering draft");
  expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
});
