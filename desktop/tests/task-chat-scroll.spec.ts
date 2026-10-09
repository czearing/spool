import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./project-fixture";

test("one virtualized thread prepends history without moving the reader and keeps the composer live", async ({ page, projectServer: server }) => {
  test.setTimeout(90000);
  const root = server.bohemia, stamp = new Date().toISOString(), file = join(root, "logs", "scroll.log");
  const event = (type: string, data: object) => JSON.stringify({ type, timestamp: stamp, data }) + "\n";
  await mkdir(join(root, "logs")); await mkdir(join(root, "controls"));
  await writeFile(join(root, "controls", "capabilities.json"), JSON.stringify({ version: 1, interactive: true, updatedAt: stamp }));
  await writeFile(join(root, "queues", "in_progress", "scroll.json"), JSON.stringify({
    id: "scroll", title: "Continuous history", agent: "engineer", prompt: "Read the whole conversation.",
    created_at: stamp, updated_at: stamp, interaction: { phase: "running" },
  }));
  await writeFile(file, Array.from({ length: 180 }, (_, index) =>
    event("assistant.message", { content: `Message ${index}` }) +
    event("tool.execution_start", { toolCallId: `tool-${index}`, toolName: `Inspect ${index}`, arguments: { path: `file-${index}` } }) +
    event("tool.execution_complete", { toolCallId: `tool-${index}`, success: true, result: { content: "Source text. ".repeat(300) } })).join(""));
  await page.route("**/conversation?events=1&before=*", async route => {
    await new Promise(resolve => setTimeout(resolve, 250)); await route.continue();
  });
  await page.goto(`${server.url}/bohemia/tasks`);
  await page.getByRole("button", { name: "Open conversation: Continuous history" }).click();
  const dialog = page.getByRole("dialog"), viewport = dialog.getByRole("region", { name: "Task conversation" });
  const list = dialog.getByRole("list", { name: "Conversation messages" }), rows = list.getByRole("listitem");
  await expect(dialog.getByText("Message 179", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Earlier messages|Back to latest/ })).toHaveCount(0);
  expect(await rows.count()).toBeLessThan(35);
  const editor = dialog.getByRole("textbox", { name: "Message agent" });
  await editor.fill("Keep my draft.");
  const count = Number(await list.getAttribute("data-message-count"));
  await viewport.evaluate(element => element.scrollTo({ top: 180 }));
  await expect(dialog.getByRole("status").filter({ hasText: "Loading history" })).toBeVisible();
  const anchor = await viewport.evaluate(element => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find(node => node.getBoundingClientRect().top >= top && node.getBoundingClientRect().top < top + 150)!;
    return { id: row.dataset.messageId!, y: row.getBoundingClientRect().top - top };
  });
  await expect.poll(async () => Number(await list.getAttribute("data-message-count"))).toBeGreaterThan(count);
  const anchored = viewport.locator(`[data-message-id="${anchor.id}"]`);
  await expect.poll(async () => {
    const box = await anchored.boundingBox(), bounds = await viewport.boundingBox();
    return Math.abs(box!.y - bounds!.y - anchor.y);
  }).toBeLessThan(3);
  await expect(editor).toHaveText("Keep my draft.");
  const afterPrepend = Number(await list.getAttribute("data-message-count"));
  await appendFile(file, event("assistant.message", { content: "New live reply while reading history." }));
  await expect.poll(async () => Number(await list.getAttribute("data-message-count"))).toBeGreaterThan(afterPrepend);
  await expect.poll(async () => {
    const box = await anchored.boundingBox(), bounds = await viewport.boundingBox();
    return Math.abs(box!.y - bounds!.y - anchor.y);
  }).toBeLessThan(3);
  for (let attempt = 0; attempt < 12 && await list.getAttribute("data-has-more") === "true"; attempt++) {
    await viewport.evaluate(element => element.scrollTo({ top: 0 }));
    await expect(dialog.getByRole("status").filter({ hasText: "Loading history" })).toBeHidden({ timeout: 5000 });
    await page.waitForTimeout(350);
  }
  await expect(list).toHaveAttribute("data-has-more", "false");
  await viewport.evaluate(element => element.scrollTo({ top: 0 }));
  await expect(dialog.getByText("Message 0", { exact: true })).toBeVisible();
  await expect(list).toHaveAttribute("data-message-count", "362");
  expect(await rows.count()).toBeLessThan(35);
  await dialog.getByRole("button", { name: "Latest messages", exact: true }).click();
  await expect(dialog.getByText("New live reply while reading history.", { exact: true })).toBeVisible();
  const tool = dialog.getByRole("article", { name: "Tool: Inspect 179", exact: true });
  await tool.getByRole("button").click();
  await expect(tool.getByText("Output", { exact: true })).toBeVisible();
  await viewport.evaluate(element => element.scrollTo({ top: 0 }));
  await expect(tool).toHaveCount(0);
  await dialog.getByRole("button", { name: "Latest messages", exact: true }).click();
  await expect(tool.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  await expect(editor).toHaveText("Keep my draft.");
  const taskFile = join(root, "queues", "in_progress", "scroll.json");
  await writeFile(taskFile, JSON.stringify({ ...JSON.parse(await readFile(taskFile, "utf8")), error: "Native failure metadata." }));
  await expect(viewport.getByRole("alert")).toHaveText("Native failure metadata.");
  await viewport.evaluate(element => element.scrollTo({ top: 0 }));
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});
