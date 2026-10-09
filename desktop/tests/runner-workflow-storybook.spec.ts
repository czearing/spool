import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const story = (variant = "default", theme = "light") =>
  `http://127.0.0.1:6006/iframe.html?id=runners-workflow-editor--${variant}&viewMode=story&globals=theme:${theme}`;
for (const theme of ["light", "dark"]) {
  test(`${theme}: isolated canvas, node editing and save use shared controls`, async ({ page }) => {
    const errors: string[] = [], requests: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.url().includes("/api/projects/")) requests.push(request.url()); });
    await page.goto(story("default", theme));
    await expect(page.getByRole("heading", { name: "Daily notes" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit Schedule", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Edit Schedule", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Check every" }).fill("2");
    await page.getByRole("button", { name: "Back to canvas", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit Schedule", exact: true })).toHaveAttribute("title", "Every 120 min");
    await page.getByRole("button", { name: "Edit Check for work", exact: true }).click();
    await page.getByRole("textbox", { name: "PowerShell command" }).fill("Write-Output 'isolated story'");
    await page.getByRole("button", { name: "Back to canvas", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Saved");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    expect((await new AxeBuilder({ page }).include("#storybook-root").withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    expect(errors).toEqual([]);
    expect(requests).toEqual([]);
  });
}
test("create, validate, add and remove steps without executing anything", async ({ page }) => {
  await page.goto(story("new-runner"));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("working directory");
  await page.getByRole("button", { name: "Runner settings", exact: true }).click();
  await page.getByRole("textbox", { name: "Runner name" }).fill("Book checks");
  await page.getByRole("textbox", { name: "Working directory" }).fill("C:\\Work\\book");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Add first step", exact: true }).click();
  await page.getByRole("button", { name: /On a schedule/ }).click();
  await page.getByRole("button", { name: "Back to canvas", exact: true }).click();
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page.getByRole("button", { name: /Run script/ }).click();
  await page.getByRole("textbox", { name: "PowerShell command" }).fill("Write-Output 'check'");
  await page.getByRole("button", { name: "Back to canvas", exact: true }).click();
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page.getByRole("button", { name: /^Repository/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("radio", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Delete step", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
});
test("a failed save preserves edits and allows retry", async ({ page }) => {
  await page.goto(story("save-failure"));
  await page.getByRole("button", { name: "Runner settings", exact: true }).click();
  await page.getByRole("checkbox", { name: "Enabled" }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("changed elsewhere");
  await page.getByRole("button", { name: "Runner settings", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Enabled" })).toBeChecked();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
});
test("managed runner preserves its execution contract and works on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(story("managed-runner"));
  await expect(page.getByRole("button", { name: "Add step", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit Repository", exact: true }).click();
  await page.getByText("About this node", { exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("workspace ownership");
  await page.getByRole("textbox", { name: "Repository directory" }).fill("C:\\Work\\another-checkout");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Back to canvas", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("resizing refits the workflow and canvas selection is not an unsaved edit", async ({ page }) => {
  await page.goto(story());
  for (const width of [1440, 390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ["Schedule", "Update workspace", "Check for work"])
      await expect(page.getByRole("button", { name: `Edit ${name}`, exact: true })).toBeInViewport();
  }
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Fit workflow", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});

test("nodes drag from their card and disconnected steps can be reconnected", async ({ page }) => {
  await page.goto(story());
  const node = page.locator('.react-flow__node[data-id="update"]');
  await expect(page.getByRole("button", { name: "Edit Update workspace", exact: true })).toBeInViewport();
  const before = (await node.boundingBox())!;
  await page.mouse.move(before.x + 25, before.y + 20);
  await page.mouse.down();
  await page.mouse.move(before.x + 70, before.y + 75, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await node.boundingBox())!.y).toBeGreaterThan(before.y + 30);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  const edge = page.locator('.react-flow__edge[data-id="schedule-update"]');
  await edge.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Backspace");
  await expect(edge).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Connect all steps");
  const source = page.locator('.react-flow__node[data-id="schedule"] .react-flow__handle.source');
  const target = page.locator('.react-flow__node[data-id="update"] .react-flow__handle.target');
  await source.click();
  await target.click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
});
