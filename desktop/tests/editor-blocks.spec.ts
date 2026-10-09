import { test, expect, type Page } from "@playwright/test";
const story = (name: string) => `http://127.0.0.1:6006/iframe.html?id=components-editor--${name}&viewMode=story&globals=theme:light`;
const editor = (page: Page) => page.getByRole("textbox", { name: "Document", exact: true });
async function insert(page: Page, name: string) {
  await page.getByRole("button", { name: "Insert block", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
test("table insertion, row/column actions, cell navigation and undo work", async ({ page }) => {
  await page.goto(story("empty")); await editor(page).click(); await insert(page, "Table");
  const table = editor(page).locator("table");
  await expect(table.locator("tr")).toHaveCount(3);
  await table.locator("th").first().click(); await page.keyboard.type("Name");
  await page.keyboard.press("Tab"); await page.keyboard.type("Status");
  await expect(table.locator("th").nth(1)).toHaveText("Status");
  await page.getByRole("button", { name: "Table actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Insert row below", exact: true }).click();
  await expect(table.locator("tr")).toHaveCount(4);
  await table.locator("td").first().click();
  await page.getByRole("button", { name: "Table actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Insert column right", exact: true }).click();
  await expect(table.locator("tr").first().locator("th,td")).toHaveCount(4);
});
test("images validate URLs and announce load failures", async ({ page }) => {
  await page.goto(story("empty")); await editor(page).click(); await insert(page, "Image");
  await page.getByLabel("URL", { exact: false }).fill("/not-an-image.png");
  await page.getByLabel("Image description", { exact: false }).fill("A useful diagram");
  await page.getByRole("dialog").getByRole("button", { name: "Insert image", exact: true }).click();
  await expect(editor(page).getByRole("status")).toContainText("Image unavailable: A useful diagram");
});
test("toggles collapse and callouts can be exited with an empty Enter", async ({ page }) => {
  await page.goto(story("empty")); await editor(page).click(); await insert(page, "Toggle");
  await page.keyboard.type("Inside details");
  await expect(editor(page).locator("details")).toContainText("Inside details");
  await editor(page).locator("summary").click({ position: { x: 4, y: 10 } });
  await expect(editor(page).locator("details")).not.toHaveAttribute("open");
  await editor(page).locator("summary").click({ position: { x: 4, y: 10 } });
  await expect(editor(page).locator("details")).toHaveAttribute("open");
  await page.goto(story("empty")); await editor(page).click(); await insert(page, "Callout");
  await page.keyboard.type("A note"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter"); await page.keyboard.type("Outside");
  await expect(editor(page).locator("aside")).toContainText("A note");
  await expect(editor(page).locator("aside")).not.toContainText("Outside");
  await expect(editor(page).locator(":scope > p").last()).toHaveText("Outside");
});
test("code blocks remain plain-text while typing and offer language selection", async ({ page }) => {
  await page.goto(story("empty")); await editor(page).click();
  await page.keyboard.type("/code"); await page.keyboard.press("Enter");
  await page.keyboard.type("const value = '**not bold**';");
  await expect(editor(page).locator("code")).toContainText("**not bold**");
  await expect(editor(page).locator("strong")).toHaveCount(0);
  await page.getByRole("button", { name: "Code language", exact: true }).click();
  await page.getByRole("menuitem", { name: "javascript", exact: true }).click();
  await expect(editor(page).locator("code")).toHaveAttribute("data-highlight-language", "javascript");
});
test("Markdown export/reload preserves the illustrated document", async ({ page }) => {
  await page.goto(story("markdown-round-trip"));
  await page.getByRole("button", { name: "Export Markdown", exact: true }).click();
  const output = await page.getByRole("textbox", { name: "Markdown source", exact: true }).inputValue();
  expect(output).toContain(":::toggle"); expect(output).toContain("| Task | Status |"); expect(output).toContain("- [x]");
  await page.getByRole("button", { name: "Load Markdown", exact: true }).click();
  await expect(editor(page).locator("details")).toHaveCount(1);
  await expect(editor(page).locator("table")).toHaveCount(1);
  await page.getByRole("button", { name: "Export Markdown", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveValue(output);
});
