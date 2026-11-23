import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./spool-task-fixture";

test.use({ interactive: true });
const taskPath = (root: string, id: string, status = "incoming") => join(root, "queues", status, `${id}.json`);
const log = (text: string, type = "assistant.message") => JSON.stringify({ type, timestamp: new Date().toISOString(), data: { content: text } }) + "\n";
async function seed(root: string, status = "incoming") {
  const now = new Date().toISOString();
  await writeFile(taskPath(root, "chat-task", status), JSON.stringify({ id: "chat-task", title: "A task conversation", agent: "engineer",
    prompt: "Original chat instructions.", status, created_at: now, updated_at: now }));
  await mkdir(join(root, "logs"), { recursive: true });
  await writeFile(join(root, "logs", "chat-task.log"), log("Original chat instructions.", "user.message") + log("A real saved **agent reply**."));
}
test("cards open real conversation with keyboard, accessible mobile geometry and focus return", async ({ page, projectServer: server }) => {
  await seed(server.bohemia, "completed");
  await page.goto(`${server.url}/bohemia/tasks`);
  const card = page.getByRole("button", { name: "Open conversation: A task conversation" });
  await card.focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "A task conversation" });
  await expect(dialog.getByText("agent reply", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Message agent" })).toHaveAttribute("aria-placeholder", "Spool is offline.");
  await expect(dialog.getByRole("textbox", { name: "Message agent" })).toHaveAttribute("aria-disabled", "true");
  await expect(dialog.getByRole("article", { name: "You message" })).toContainText("Original chat instructions.");
  await expect(dialog.getByRole("button", { name: /Task instructions|Task log/ })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 720 });
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(720);
  await page.keyboard.press("Escape"); await expect(card).toBeFocused();
  await page.keyboard.press("Space"); await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click(); await expect(card).toBeFocused();
});
test("live replies preserve an unsent draft, survive closing and reload, and do not pull readers down", async ({ page, projectServer: server, scheduler }) => {
  void scheduler; await seed(server.bohemia);
  await writeFile(join(server.bohemia, "logs", "chat-task.log"), Array.from({ length: 45 }, (_, index) => log(`Saved reply ${index}. ${"Paragraph text. ".repeat(25)}`)).join(""));
  await page.goto(`${server.url}/bohemia/tasks`);
  const card = page.getByRole("button", { name: "Open conversation: A task conversation" }); await card.click();
  const dialog = page.getByRole("dialog"), editor = dialog.getByRole("textbox", { name: "Message agent" });
  await expect(editor).toHaveAttribute("aria-disabled", "false"); await editor.fill("Keep this unsent draft.");
  const viewport = dialog.getByRole("region", { name: "Task conversation" });
  await viewport.evaluate((element) => { element.scrollTop = 0; });
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
  await appendFile(join(server.bohemia, "logs", "chat-task.log"), log("Fresh live reply."));
  await expect.poll(async () => Number(await dialog.getByRole("list").getAttribute("data-message-count"))).toBe(47);
  expect(await viewport.evaluate((element) => element.scrollTop)).toBeLessThan(30);
  await expect(editor).toHaveText("Keep this unsent draft.");
  await dialog.getByRole("button", { name: "Latest messages", exact: true }).click();
  await expect(dialog.getByText("Fresh live reply.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click(); await card.click();
  await expect(editor).toHaveText("Keep this unsent draft.");
  await page.reload(); await card.click(); await expect(editor).toHaveText("Keep this unsent draft.");
});
test("lost send responses retry the same native message after reopening without losing the draft", async ({ page, projectServer: server, scheduler }) => {
  void scheduler; await seed(server.bohemia); const ids: string[] = [];
  await page.route("**/tasks/chat-task/conversation*", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    ids.push(route.request().postDataJSON().id);
    if (ids.length === 1) { const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort(); }
    else await route.continue();
  });
  await page.goto(`${server.url}/bohemia/tasks`);
  const card = page.getByRole("button", { name: "Open conversation: A task conversation" }); await card.click();
  const dialog = page.getByRole("dialog"), editor = dialog.getByRole("textbox", { name: "Message agent" });
  await expect(editor).toHaveAttribute("aria-disabled", "false"); await editor.fill("Only send this once.");
  await dialog.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Your draft is still here.");
  await dialog.getByRole("button", { name: "Close dialog" }).click(); await card.click();
  await expect(editor).toHaveText("Only send this once.");
  await dialog.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(editor).toBeEmpty(); expect(ids).toHaveLength(2); expect(ids[1]).toBe(ids[0]);
  const task = JSON.parse(await readFile(taskPath(server.bohemia, "chat-task"), "utf8"));
  expect(task.interaction.messages).toMatchObject([{ id: ids[0], text: "Only send this once.", status: "queued" }]);
  expect(task.interaction.messages).toHaveLength(1);
});
test("native ACP receives the follow-up and its real streamed reply appears in the dialog", async ({ page, request, projectServer: server, scheduler }) => {
  void scheduler; await seed(server.bohemia);
  await page.goto(`${server.url}/bohemia/tasks`);
  await page.getByRole("button", { name: "Open conversation: A task conversation" }).click();
  const dialog = page.getByRole("dialog"), editor = dialog.getByRole("textbox", { name: "Message agent" });
  await expect(editor).toHaveAttribute("aria-disabled", "false"); await editor.fill("Exact native follow-up!");
  await dialog.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(editor).toBeEmpty();
  await expect(dialog.getByRole("status").filter({ hasText: "Message queued for the agent." })).toBeVisible();
  await rm(join(server.bohemia, "controls", "paused", "engineer"));
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(join(server.root, "agent-call.json"), "utf8")); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
  }, { timeout: 15000 }).toMatchObject({ prompts: expect.arrayContaining(["Exact native follow-up!"]), cwd: await realpath(server.bohemia) });
  await expect(dialog.getByText("Fixture received: Exact native follow-up!", { exact: true })).toBeVisible({ timeout: 10000 });
  const response = await request.get(`${server.url}/api/projects/bohemia/tasks/chat-task/conversation`);
  const conversation = await response.json(); expect(conversation.entries.some((entry: { text: string }) => entry.text === "Fixture received: Exact native follow-up!")).toBe(true);
  await expect(editor).toHaveAttribute("aria-disabled", "false");
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("button", { name: "Open conversation: A task conversation" })).toBeFocused();
});
test("conversation API rejects cross-origin writes and invalid inputs while reading historical tasks", async ({ request, projectServer: server }) => {
  await seed(server.bohemia, "completed");
  const url = `${server.url}/api/projects/bohemia/tasks/chat-task/conversation`, headers = { Origin: server.url };
  const data = { id: randomUUID(), message: "A follow-up" };
  expect((await request.get(url)).status()).toBe(200);
  expect((await request.post(url, { data })).status()).toBe(403);
  expect((await request.post(url, { data, headers: { Origin: "http://foreign.example" } })).status()).toBe(403);
  expect((await request.post(url, { data, headers })).status()).toBe(409);
  expect((await request.post(url, { data: { ...data, message: "" }, headers })).status()).toBe(400);
  expect((await request.get(`${url}?before=-1`)).status()).toBe(400);
  expect((await request.get(url.replace("/chat-task/", "/missing/"))).status()).toBe(404);
});
test("bounded history loads automatically without page swapping and recovers from an unavailable live read", async ({ page, projectServer: server, scheduler }) => {
  void scheduler; await seed(server.bohemia);
  await writeFile(join(server.bohemia, "logs", "chat-task.log"), Array.from({ length: 180 }, (_, index) => log(`History ${index}: ${"x".repeat(3000)}`)).join(""));
  await page.goto(`${server.url}/bohemia/tasks`); await page.getByRole("button", { name: "Open conversation: A task conversation" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/^History 179:/)).toBeAttached();
  const viewport = dialog.getByRole("region", { name: "Task conversation" }), list = dialog.getByRole("list");
  const count = Number(await list.getAttribute("data-message-count"));
  await viewport.evaluate(element => element.scrollTo({ top: 0 }));
  await expect.poll(async () => Number(await list.getAttribute("data-message-count"))).toBeGreaterThan(count);
  await expect(dialog.getByRole("button", { name: /Earlier messages|Back to latest/ })).toHaveCount(0);
  await expect(dialog.getByText(/^History 179:/)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Latest messages", exact: true }).click();
  await expect(dialog.getByText(/^History 179:/)).toBeAttached();
  await page.route("**/tasks/chat-task/conversation*", (route) => route.fulfill({ status: 503, json: { error: "Conversation disconnected." } }));
  await expect(dialog.getByRole("alert")).toHaveText("Conversation disconnected.");
  await page.unroute("**/tasks/chat-task/conversation*");
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});
test("Storybook uses the same dialog and shared composer without a live backend", async ({ page }) => {
  await page.goto("http://127.0.0.1:6006/iframe.html?id=tasks-conversation--active&viewMode=story");
  await page.getByRole("button", { name: "Open task" }).click();
  const dialog = page.getByRole("dialog"), editor = dialog.getByRole("textbox", { name: "Message agent" });
  await expect(dialog.getByText(/The cards now open/)).toBeVisible();
  await editor.fill("Storybook-only follow-up."); await editor.press("Enter");
  await expect(editor).toBeEmpty(); await expect(dialog.getByText("Storybook-only follow-up.", { exact: true })).toBeVisible();
});
test("finishing a streamed reply retains its message element without status panels or raw logs", async ({ page, projectServer: server }) => {
  await seed(server.bohemia, "in_progress");
  const file = taskPath(server.bohemia, "chat-task", "in_progress");
  const task = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...task, interaction: { phase: "running" } }));
  await mkdir(join(server.bohemia, "controls"), { recursive: true });
  await writeFile(join(server.bohemia, "controls", "capabilities.json"),
    JSON.stringify({ version: 1, interactive: true, updatedAt: new Date().toISOString() }));
  const path = join(server.bohemia, "logs", "chat-task.log");
  await writeFile(path, log("A partial reply", "assistant.message_delta"));
  await page.goto(`${server.url}/bohemia/tasks`);
  await page.getByRole("button", { name: "Open conversation: A task conversation" }).click();
  const dialog = page.getByRole("dialog"), message = dialog.getByRole("article", { name: "engineer message" });
  await expect(message).toContainText("A partial reply");
  const element = await message.elementHandle(); expect(element).not.toBeNull();
  await appendFile(path, log("A completed reply") + "Imported task metadata\n");
  await expect(message).toContainText("A completed reply");
  await expect(dialog.getByText(/Writing a reply|Agent working/)).toHaveCount(0);
  expect(await element!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(dialog.getByRole("article", { name: "Spool message" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Task log", exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Imported task metadata", { exact: true })).toHaveCount(0);
});
