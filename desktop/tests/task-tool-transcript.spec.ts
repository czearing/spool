import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./project-fixture";

test("opens all recorded calls quickly, expands results, and preserves live tool identity on desktop and mobile", async ({ page, projectServer: server }) => {
  const timestamp = new Date().toISOString(), file = join(server.bohemia, "logs", "tools.log");
  const event = (type: string, data: object) => JSON.stringify({ type, timestamp, data }) + "\n";
  await mkdir(join(server.bohemia, "logs"));
  await mkdir(join(server.bohemia, "controls"));
  await writeFile(join(server.bohemia, "controls", "capabilities.json"), JSON.stringify({
    version: 1, interactive: true, updatedAt: timestamp,
  }));
  await writeFile(join(server.bohemia, "queues", "in_progress", "tools.json"), JSON.stringify({
    id: "tools", title: "Page Header Flaky fixture", agent: "engineer", prompt: "Investigate Page Header.",
    created_at: timestamp, updated_at: timestamp, interaction: { phase: "running" }, provider: { token: "PRIVATE_LEASE" },
  }));
  let body = event("assistant.message", { content: "I will investigate the Page Header failure." });
  for (let index = 0; index < 13; index++) {
    body += event("tool.execution_start", { toolCallId: `call-${index}`,
      toolName: index === 12 ? "Prepare repository" : `Read source ${index}`,
      arguments: { path: `src\\file-${index}.tsx`, token: "PRIVATE_TOKEN" } });
    if (index < 12) body += event("tool.execution_complete", { toolCallId: `call-${index}`, success: index !== 11,
      result: { content: `Output ${index}: ${"Readable source text. ".repeat(100)} PRIVATE_LEASE` } });
  }
  await writeFile(file, body);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${server.url}/bohemia/tasks`);
  const start = Date.now();
  await page.getByRole("button", { name: "Open conversation: Page Header Flaky fixture" }).click();
  const dialog = page.getByRole("dialog", { name: "Page Header Flaky fixture" });
  const tools = dialog.getByRole("article", { name: /^Tool:/ });
  const viewport = dialog.getByRole("region", { name: "Task conversation" });
  const list = dialog.getByRole("list", { name: "Conversation messages" });
  await expect(list).toHaveAttribute("data-message-count", "15", { timeout: 1500 });
  const openMs = Date.now() - start;
  expect(openMs).toBeLessThan(1500);
  await test.info().attach("conversation-open-time", { body: JSON.stringify({ openMs, calls: 13 }), contentType: "application/json" });
  await expect(dialog.locator("pre")).toHaveCount(0);
  const pending = dialog.getByRole("article", { name: "Tool: Prepare repository", exact: true });
  await expect(pending).toContainText("Pending");
  await expect(tools.filter({ hasText: "Failed" })).toHaveCount(1);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await viewport.evaluate(element => element.scrollTo({ top: 0 }));
    await expect(dialog.getByRole("article", { name: "engineer message" })).toContainText("I will investigate");
    const first = dialog.getByRole("article", { name: "Tool: Read source 0", exact: true });
    await first.getByRole("button").click();
    await expect(first.locator("pre").last()).toContainText("Output 0");
    expect(await first.textContent()).not.toContain("PRIVATE");
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    await first.getByRole("button").click();
  }
  await dialog.getByRole("button", { name: "Latest messages", exact: true }).click();
  const original = await pending.elementHandle();
  await pending.getByRole("button").click();
  await expect(pending).toContainText("No completion recorded.");
  await appendFile(file, event("tool.execution_complete", { toolCallId: "call-12", success: true,
    result: { content: "Preparation complete." } }) + event("assistant.message_delta", { content: "The checkout is ready." }));
  await expect(pending).toContainText("Completed");
  await expect(pending).toContainText("Preparation complete.");
  expect(await original!.evaluate(element => element.isConnected)).toBe(true);
  await expect(list).toHaveAttribute("data-message-count", "16");
  await expect(dialog.getByText("The checkout is ready.", { exact: true })).toBeAttached();
  expect(errors).toEqual([]);
});
