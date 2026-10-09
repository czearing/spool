import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const story = (variant: string) =>
  `http://127.0.0.1:6006/iframe.html?id=runners-workflow-editor--${variant}&viewMode=story`;
test("searchable action picker inserts repository operations without requiring scripts", async ({ page }) => {
  await page.goto(story("repository-workflow"));
  await expect(page.getByRole("button", { name: "Add action after Refresh repository", exact: true })).toHaveCount(0);
  const edge = page.locator('.react-flow__edge[data-id="update-scan"]');
  await edge.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Insert action on connection", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "What happens next?" })).toBeVisible();
  await page.getByRole("textbox", { name: "Search nodes" }).fill("prepare");
  await expect(page.getByRole("button", { name: /Run script/ })).toHaveCount(0);
  await page.getByRole("button", { name: /^Repository/ }).click();
  await page.getByRole("combobox", { name: "Operation" }).click();
  await page.getByRole("option", { name: "Prepare workspace", exact: true }).click();
  await page.getByText("About this node", { exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("shared Bohemia tools");
  await expect(page.getByRole("textbox", { name: "PowerShell command" })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to canvas", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit Repository", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  await page.getByRole("button", { name: "Edit Repository", exact: true }).click();
  await page.getByRole("radio", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Delete step", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
});
test("new runner offers events and agent tasks, with keyboard-accessible mobile picker", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(story("new-runner"));
  const bounds = (await page.getByRole("button", { name: "Add first step", exact: true }).boundingBox())!;
  expect(bounds.width).toBe(96); expect(bounds.height).toBe(96);
  await page.getByRole("button", { name: "Add first step", exact: true }).click();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: /When a file changes/ }).click();
  await page.getByRole("textbox", { name: "File to watch" }).fill("chapter.md");
  await page.getByRole("button", { name: "Back to canvas", exact: true }).click();
  await page.getByRole("button", { name: "Add action after When a file changes", exact: true }).click();
  await page.getByRole("button", { name: /^Agent/ }).click();
  await page.getByRole("combobox", { name: "Agent", exact: true }).click();
  await page.getByRole("option", { name: "editor", exact: true }).click();
  await page.getByRole("textbox", { name: "Task instructions" }).fill("Review chapter.md for clarity.");
  await page.getByRole("button", { name: "Back to canvas", exact: true }).click();
  await page.getByRole("button", { name: "Runner settings", exact: true }).click();
  await page.getByRole("textbox", { name: "Working directory" }).fill("C:\\Work\\book");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("docked picker supports arrow-key selection without covering the toolbar", async ({ page }) => {
  await page.goto(story("repository-workflow"));
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "What happens next?" });
  await expect(dialog).toHaveAttribute("data-modal", "false");
  const panel = (await dialog.boundingBox())!, header = (await page.locator("header").boundingBox())!;
  expect(panel.y).toBeGreaterThanOrEqual(header.y + header.height);
  await page.getByRole("textbox", { name: "Search nodes" }).press("ArrowDown");
  await expect(dialog.getByRole("button", { name: /^Repository/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByRole("button", { name: /^Agent/ })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await page.getByText("About this node", { exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("shared Bohemia tools");
});
test("connection toolbar deletes an edge without silently deleting its steps", async ({ page }) => {
  await page.goto(story("repository-workflow"));
  const edge = page.locator('.react-flow__edge[data-id="update-scan"]');
  await edge.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Delete connection", exact: true }).click();
  await expect(edge).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit Check changes", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add action after Refresh repository", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Connect all steps");
});
test("node icons and toolbar icons are centered using shared buttons", async ({ page }) => {
  await page.goto(story("repository-workflow"));
  for (const name of ["Edit Refresh repository", "Runner settings", "Zoom in"]) {
    const button = page.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    const bounds = (await button.boundingBox())!, icon = (await button.locator("svg").boundingBox())!;
    expect(Math.abs((bounds.x + bounds.width / 2) - (icon.x + icon.width / 2))).toBeLessThan(1);
    expect(Math.abs((bounds.y + bounds.height / 2) - (icon.y + icon.height / 2))).toBeLessThan(1);
    await expect(button).toHaveAttribute("data-variant", "secondary");
  }
});
test("keyboard deletion reconnects the sequence instead of leaving broken edges", async ({ page }) => {
  await page.goto(story("default"));
  const node = page.locator('.react-flow__node[data-id="update"]');
  await node.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Delete");
  await expect(node).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
});
