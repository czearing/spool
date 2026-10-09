import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./spool-task-fixture";

test("creates an agent through native MCP, discovers it live and persists image and concurrency settings", async ({ page, projectServer: server, scheduler }) => {
  test.setTimeout(90000);
  void scheduler;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${server.url}/bohemia`);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Create agent", exact: true });
  await create.getByRole("textbox", { name: "Name (required)", exact: true }).fill("researcher");
  await expect(create.getByRole("textbox", { name: "Description", exact: true })).toHaveCount(0);
  await expect(create.getByRole("combobox", { name: "Icon", exact: true })).toHaveCount(0);
  const portrait = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 400; canvas.height = 300;
    const context = canvas.getContext("2d")!; context.fillStyle = "#287360"; context.fillRect(0, 0, 400, 300);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await create.locator('input[type="file"]').setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: Buffer.from(portrait, "base64") });
  await expect(create.getByRole("img", { name: "Agent image", exact: true }).locator("img")).toBeVisible();
  await create.getByRole("textbox", { name: "Instructions", exact: true }).fill("Research the requested topic.");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  await create.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(page).toHaveURL(`${server.url}/bohemia/agents/researcher`);
  const displayedImage = page.getByRole("heading", { name: "researcher", exact: true }).locator("img");
  await expect(displayedImage).toBeVisible();
  const imageUrl = await displayedImage.getAttribute("src");
  expect(imageUrl).toMatch(/\/image\?v=[a-f0-9]{64}$/);
  const response = await page.request.get(`${server.url}${imageUrl}`);
  expect(response.headers()["content-type"]).toBe("image/webp");
  expect(response.headers()["cache-control"]).toContain("immutable");
  expect(await displayedImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(256);
  const live = await (await page.request.get(`${server.url}/api/projects/bohemia/live`)).json();
  expect(JSON.stringify(live)).not.toContain("data:image");
  const file = join(server.bohemia, "agents", "researcher.md"), original = await readFile(file, "utf8");
  expect(original).toContain("max_concurrent_runs: 1");
  await page.getByRole("button", { name: "Agent actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Agent settings", exact: true });
  const limit = settings.getByRole("spinbutton", { name: "Max concurrent runs", exact: true });
  for (const invalid of ["0", "1.5"]) {
    await limit.fill(invalid);
    await expect(settings.getByRole("button", { name: "Save settings", exact: true })).toBeDisabled();
    await expect(settings.getByRole("alert")).toContainText("whole-number run limit");
  }
  await limit.fill("2");
  await settings.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(settings).toBeHidden();
  expect(await readFile(file, "utf8")).toContain("max_concurrent_runs: 2");
  await page.getByRole("button", { name: "Agent actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(limit).toHaveValue("2");
  await settings.getByRole("checkbox", { name: "No limit", exact: true }).check();
  await expect(limit).toBeDisabled();
  await settings.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(settings).toBeHidden();
  const source = await readFile(file, "utf8");
  expect(source).toContain("max_concurrent_runs: null");
  expect(source).toContain('image: "data:image/webp;base64,');
  expect(source).not.toContain("description:");
  expect(source).toContain("Research the requested topic.");
  await page.reload();
  await expect(displayedImage).toHaveAttribute("src", imageUrl!);
  await page.getByRole("button", { name: "Agent actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(settings.getByRole("checkbox", { name: "No limit", exact: true })).toBeChecked();
  await settings.getByRole("button", { name: "Remove image", exact: true }).click();
  await settings.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(settings).toBeHidden();
  await expect(displayedImage).toHaveCount(0);
  expect(await readFile(file, "utf8")).not.toContain("image:");
  expect((await page.request.get(`${server.url}${imageUrl}`)).status()).toBe(404);
  await page.keyboard.press("Escape");
  await writeFile(join(server.bohemia, "queues", "incoming", "new-agent-live.json"), JSON.stringify({
    id: "new-agent-live", agent: "researcher", title: "Fixture", prompt: "Fixture only", status: "incoming",
  }));
  await expect.poll(async () => {
    const files = await readdir(join(server.bohemia, "queues", "completed"));
    return files.includes("new-agent-live.json");
  }, { timeout: 20000 }).toBe(true);
  expect(errors).toEqual([]);
});

test("agent menu is hover/focus-only on pointer devices and remains visible while open", async ({ page, projectServer: server }) => {
  await page.goto(`${server.url}/bohemia/agents/engineer`);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const trigger = page.getByRole("button", { name: "engineer actions", exact: true, includeHidden: true }), wrapper = trigger.locator("xpath=..");
  await page.mouse.move(900, 100);
  await expect(wrapper).toHaveCSS("opacity", "0");
  await page.getByRole("link", { name: "engineer", exact: true }).hover();
  await expect(wrapper).toHaveCSS("opacity", "1");
  await trigger.click(); await page.mouse.move(900, 100);
  await expect(wrapper).toHaveCSS("opacity", "1");
  await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
  await expect(wrapper).toHaveCSS("opacity", "1");
});

test("native agent creation rejects duplicate names and writes from other origins", async ({ request, projectServer: server, scheduler }) => {
  void scheduler;
  const url = `${server.url}/api/projects/bohemia/agents`;
  const input = { name: "helper", prompt: "Help with the task.", max_concurrent_runs: null };
  expect((await request.post(url, { data: input })).status()).toBe(403);
  expect((await request.post(url, { headers: { Origin: server.url }, data: input })).status()).toBe(201);
  expect((await request.post(url, { headers: { Origin: server.url }, data: input })).status()).toBe(409);
  expect((await request.post(url, { headers: { Origin: server.url }, data: { ...input, name: "../escape" } })).status()).toBe(400);
});

test("touch actions remain visible and mobile creation can scroll and cancel without saving", async ({ browser, projectServer: server }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto(`${server.url}/bohemia/agents/engineer`);
    await page.getByRole("button", { name: "Open sidebar", exact: true }).tap();
    await page.getByRole("button", { name: "Agents", exact: true }).tap();
    expect(await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches)).toBe(false);
    const trigger = page.getByRole("button", { name: "engineer actions", exact: true });
    await expect(trigger.locator("xpath=..")).toHaveCSS("opacity", "1");
    await trigger.tap();
    await expect(page.getByRole("menuitem", { name: "Settings", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Create agent", exact: true }).tap();
    const dialog = page.getByRole("dialog", { name: "Create agent", exact: true });
    await dialog.getByRole("textbox", { name: "Instructions", exact: true }).waitFor();
    const submit = dialog.getByRole("button", { name: "Create agent", exact: true });
    await submit.scrollIntoViewIfNeeded();
    await expect(submit).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect((await readdir(join(server.bohemia, "agents"))).sort()).toEqual(["engineer.md", "reviewer.md"]);
  } finally { await context.close(); }
});
