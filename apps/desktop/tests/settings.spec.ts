import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./spool-task-fixture";

test("sidebar settings persist themes locally and models in Spool, synchronize tabs and work on mobile", async ({ page, context, browser, projectServer: server, scheduler }) => {
  void scheduler;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${server.url}/bohemia`);
  const trigger = page.getByRole("button", { name: "Settings", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const appearance = dialog.getByRole("combobox", { name: "Appearance", exact: true });
  await appearance.click(); await page.getByRole("option", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(dialog).toHaveCSS("color-scheme", "dark");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  await dialog.getByRole("combobox", { name: "Default agent model", exact: true }).click();
  await page.getByRole("option", { name: "GPT-5.4 mini", exact: true }).click();
  await dialog.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await trigger.click();
  await expect(dialog.getByRole("combobox", { name: "Default agent model", exact: true })).toContainText("GPT-5.4 mini");
  expect(JSON.parse(await readFile(join(server.bohemia, "spool.json"), "utf8")).defaultModel).toBe("gpt-5.4-mini");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("spool:settings")!))).toEqual({ version: 1, theme: "dark" });
  const fresh = await browser.newContext(), freshPage = await fresh.newPage();
  try {
    await freshPage.goto(`${server.url}/bohemia`);
    await freshPage.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(freshPage.getByRole("combobox", { name: "Default agent model", exact: true })).toContainText("GPT-5.4 mini");
  } finally { await fresh.close(); }
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  const other = await context.newPage();
  await other.goto(`${server.url}/bohemia`);
  await other.getByRole("button", { name: "Settings", exact: true }).click();
  await other.getByRole("combobox", { name: "Appearance", exact: true }).click();
  await other.getByRole("option", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await other.close();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  await trigger.click(); await appearance.click();
  await page.getByRole("option", { name: "System", exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
  await expect(page.locator("html")).toHaveCSS("background-color", "rgb(10, 10, 10)");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape"); await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});

test("invalid or unavailable local storage is visible, recoverable and never reported saved", async ({ page, projectServer: server }) => {
  await page.addInitScript(() => localStorage.setItem("spool:settings", '{"version":1,"theme":"bad"}'));
  await page.goto(`${server.url}/bohemia`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog.getByRole("alert")).toContainText("could not be read");
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("Blocked storage"); }; });
  await dialog.getByRole("combobox", { name: "Appearance", exact: true }).click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("could not be saved");
  await expect(dialog).toBeVisible();
});

for (const interactive of [false, true]) test.describe(interactive ? "ACP model" : "One-shot model", () => {
  test.use({ interactive });
  test("native project inheritance and per-agent overrides apply to UI and runner tasks", async ({ page, projectServer: server, scheduler }) => {
    test.setTimeout(60000);
    void scheduler;
    const agentFile = join(server.bohemia, "agents", "engineer.md"), original = await readFile(agentFile, "utf8");
    await page.addInitScript(() => localStorage.setItem("spool:settings", '{"version":1,"theme":"light","defaultModel":"obsolete-browser-model"}'));
    await page.goto(`${server.url}/bohemia/tasks`);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("combobox", { name: "Default agent model", exact: true }).click();
    await page.getByRole("option", { name: "GPT-5.4 mini", exact: true }).click();
    await settings.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect(settings).toBeHidden();
    await page.goto(`${server.url}/bohemia/agents/engineer`);
    await page.getByRole("button", { name: "Agent actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    const agentSettings = page.getByRole("dialog", { name: "Agent settings", exact: true });
    await agentSettings.getByRole("combobox", { name: "Model", exact: true }).click();
    await page.getByRole("option", { name: "Use project default", exact: true }).click();
    await agentSettings.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect(agentSettings).toBeHidden();
    const savedAgent = await readFile(agentFile, "utf8");
    expect(savedAgent).not.toContain("model:");
    expect(savedAgent.split("---")[2]).toBe(original.split("---")[2]);
    await page.goto(`${server.url}/bohemia/tasks`);
    await page.getByRole("button", { name: "New", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New task", exact: true });
    await dialog.getByRole("textbox", { name: "Title", exact: true }).fill("Use saved model");
    await dialog.getByRole("textbox", { name: "Instructions", exact: true }).fill("Fixture only.");
    await dialog.getByRole("combobox", { name: "Agent", exact: true }).click();
    await page.getByRole("option", { name: "engineer", exact: true }).click();
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).toBeHidden();
    const files = await readdir(join(server.bohemia, "queues", "incoming"));
    expect(files).toHaveLength(1);
    const queued = JSON.parse(await readFile(join(server.bohemia, "queues", "incoming", files[0]), "utf8"));
    expect(queued.model).toBeUndefined();
    await rm(join(server.bohemia, "controls", "paused", "engineer"));
    await expect.poll(async () => {
      try { return JSON.parse(await readFile(join(server.root, "agent-call.json"), "utf8")).model; }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
    }, { timeout: 15000 }).toBe("gpt-5.4-mini");
    await expect.poll(() => readdir(join(server.bohemia, "queues", "in_progress"))).toEqual([]);
    await writeFile(join(server.bohemia, "spool.json"), '{"version":1,"defaultModel":"gpt-5.4"}');
    await writeFile(join(server.bohemia, "queues", "incoming", "runner-model.json"), JSON.stringify({
      id: "runner-model", agent: "engineer", title: "Runner-created work", prompt: "No UI or task override.", status: "incoming",
    }));
    await expect.poll(async () => JSON.parse(await readFile(join(server.root, "agent-call.json"), "utf8")).model,
      { timeout: 15000 }).toBe("gpt-5.4");
    await expect.poll(() => readdir(join(server.bohemia, "queues", "in_progress"))).toEqual([]);
    await page.goto(`${server.url}/bohemia/agents/engineer`);
    await page.getByRole("button", { name: "Agent actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await agentSettings.getByRole("combobox", { name: "Model", exact: true }).click();
    await page.getByRole("option", { name: "GPT-5.4 mini", exact: true }).click();
    await agentSettings.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect(agentSettings).toBeHidden();
    await writeFile(join(server.bohemia, "queues", "incoming", "runner-override.json"), JSON.stringify({
      id: "runner-override", agent: "engineer", title: "Explicit agent model", prompt: "No task override.", status: "incoming",
    }));
    await expect.poll(async () => JSON.parse(await readFile(join(server.root, "agent-call.json"), "utf8")).model,
      { timeout: 15000 }).toBe("gpt-5.4-mini");
  });
});
