import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const url = (story = "webhook-automation", theme = "light") =>
  `http://127.0.0.1:6006/iframe.html?id=runners-building-blocks--${story}&viewMode=story&globals=theme:${theme}`;
test("compact canvas matches reference dimensions without verbose cards or an expanded log", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url());
  expect((await page.locator("header").boundingBox())!.height).toBe(65);
  expect((await page.getByRole("region", { name: "Workflow executions" }).boundingBox())!.height).toBe(37);
  await expect(page.getByRole("textbox", { name: "Test input (JSON)" })).toHaveCount(0);
  await expect(page.getByText("Runner workflow", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Select a node to configure. Use + to add an action.")).toHaveCount(0);
  const card = (await page.getByRole("button", { name: "Edit Send to API", exact: true }).boundingBox())!;
  expect(card.width).toBe(96); expect(card.height).toBe(96);
  const execute = (await page.getByRole("button", { name: "Execute workflow", exact: true }).boundingBox())!;
  expect(execute.x + execute.width / 2).toBeCloseTo(720, 0);
  expect(execute.y).toBeGreaterThan(800);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole("heading", { name: "Webhook automation" })).toHaveCSS("font-family", /Geist/);
  const executeButton = page.getByRole("button", { name: "Execute workflow", exact: true });
  await expect(executeButton).toHaveAttribute("data-variant", "primary");
  const style = await executeButton.evaluate(element => {
    const computed = getComputedStyle(element);
    return [computed.fontFamily, computed.fontSize, computed.backgroundColor, computed.color, computed.borderRadius, computed.padding];
  });
  const reference = await page.context().newPage();
  await reference.goto("http://127.0.0.1:6006/iframe.html?id=components-button--primary&viewMode=story&globals=theme:light");
  const shared = await reference.getByRole("button", { name: "Button", exact: true }).evaluate(element => {
    const computed = getComputedStyle(element);
    return [computed.fontFamily, computed.fontSize, computed.backgroundColor, computed.color, computed.borderRadius, computed.padding];
  });
  expect(style).toEqual(shared);
  await reference.close();
});
for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`node parameters keep advanced guidance collapsed and remain accessible at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url("webhook-automation", theme));
    await page.getByRole("button", { name: "Edit Send to API", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Send to API" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("region", { name: "Output", exact: true })).toBeVisible();
    await expect(dialog.locator("details").filter({ hasText: "About this node" })).not.toHaveAttribute("open");
    await expect(dialog.getByRole("textbox", { name: "URL", exact: true })).toHaveValue("https://example.invalid/tasks");
    if (width > 640) {
      const input = (await dialog.getByRole("region", { name: "Input", exact: true }).boundingBox())!;
      const parameters = (await dialog.getByRole("textbox", { name: "URL", exact: true }).boundingBox())!;
      const output = (await dialog.getByRole("region", { name: "Output", exact: true }).boundingBox())!;
      expect(parameters.x).toBeGreaterThan(input.x + input.width);
      expect(output.x).toBeGreaterThan(parameters.x + parameters.width);
    }
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
}
test("execution and canvas tabs retain input, history and per-node results", async ({ page }) => {
  await page.goto(url());
  await page.getByRole("radio", { name: "Executions", exact: true }).click();
  await expect(page.getByRole("application", { name: "Runner workflow" })).toBeHidden();
  const input = page.getByRole("textbox", { name: "Test input (JSON)" });
  await input.fill('{"action":"opened","title":"Test item"}');
  await page.getByRole("button", { name: "Execute workflow", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Execution succeeded");
  await page.getByRole("radio", { name: "Editor", exact: true }).click();
  await page.getByRole("button", { name: "Edit Send to API", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("region", { name: "Output", exact: true })).toContainText("fixture-42");
  await page.keyboard.press("Escape");
  await page.getByRole("radio", { name: "Executions", exact: true }).click();
  await expect(input).toHaveValue('{"action":"opened","title":"Test item"}');
  await expect(page.getByRole("status")).toContainText("Execution succeeded");
});
