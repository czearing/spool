import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const story = "http://127.0.0.1:6006/iframe.html?id=runners-building-blocks--webhook-automation&viewMode=story";
test("shared block forms expose HTTP, data, conditions and webhook configuration", async ({ page }) => {
  await page.goto(story);
  await page.getByRole("button", { name: "Edit Send to API", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "URL", exact: true })).toHaveValue("https://example.invalid/tasks");
  await expect(page.getByRole("textbox", { name: "JSON body", exact: true })).toHaveValue("{{input}}");
  await expect(page.getByRole("textbox", { name: "Bearer token environment variable", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to canvas", exact: true }).click();
  await page.getByRole("button", { name: "Edit Only opened items", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Input field", exact: true })).toHaveValue("action");
  await page.getByRole("button", { name: "Back to canvas", exact: true }).click();
  await page.getByRole("button", { name: "Edit Receive webhook", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Webhook token environment variable", exact: true })).toHaveValue("AUTOMATION_WEBHOOK_TOKEN");
  await expect(page.getByRole("spinbutton", { name: "Check every" })).toHaveCount(0);
});
for (const width of [1440, 390]) test(`run input and per-block results are inspectable at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(story);
  await page.getByRole("button", { name: "Logs", exact: true }).click();
  await page.getByRole("textbox", { name: "Test input (JSON)" }).fill('{"action":"opened","title":"Review item"}');
  await page.getByRole("region", { name: "Workflow executions" }).getByRole("button", { name: "Execute workflow", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Execution succeeded");
  await expect(page.getByRole("region", { name: "Workflow executions" })).toContainText("fixture-42");
  const input = await page.getByRole("region", { name: "Input", exact: true }).boundingBox();
  const output = await page.getByRole("region", { name: "Output", exact: true }).boundingBox();
  expect(input).not.toBeNull(); expect(output).not.toBeNull();
  if (width > 640) expect(output!.x).toBeGreaterThanOrEqual(input!.x + input!.width);
  else { expect(output!.x).toBe(input!.x); expect(output!.y).toBeGreaterThanOrEqual(input!.y + input!.height); }
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("invalid JSON is explicit, and dirty edits cannot accidentally execute the saved configuration", async ({ page }) => {
  await page.goto(story);
  await page.getByRole("button", { name: "Logs", exact: true }).click();
  await page.getByRole("textbox", { name: "Test input (JSON)" }).fill("{broken");
  await page.getByRole("region", { name: "Workflow executions" }).getByRole("button", { name: "Execute workflow", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Runner settings", exact: true }).click();
  await page.getByRole("checkbox", { name: "Enabled", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("region", { name: "Workflow executions" }).getByRole("button", { name: "Execute workflow", exact: true })).toBeDisabled();
  await expect(page.getByText("Save changes before executing.", { exact: true })).toBeVisible();
});
