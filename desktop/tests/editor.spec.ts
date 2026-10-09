import { test, expect, type Page } from "@playwright/test";
const url = "http://127.0.0.1:6006/iframe.html?id=components-editor--";
const editor = (page: Page) => page.getByRole("textbox", { name: "Document", exact: true });
const toolbar = (page: Page) => page.getByRole("toolbar", { name: "Text formatting", exact: true });
test.beforeEach(async ({ page }) => { await page.goto(`${url}empty&viewMode=story&globals=theme:light`); await expect(editor(page)).toBeVisible(); });
test("Markdown shortcuts, lists, checklists and undo work while typing", async ({ page }) => {
  const content = editor(page);
  await content.click(); await page.keyboard.type("# A heading"); await page.keyboard.press("Enter");
  await page.keyboard.type("**Strong** "); await expect(content.locator("h1")).toHaveText("A heading");
  await expect(content.locator("strong")).toHaveText("Strong");
  await page.keyboard.press("Enter"); await page.keyboard.type("- A bullet"); await expect(content.locator("ul")).toContainText("A bullet");
  await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  await page.keyboard.type("- [ ] A task");
  await expect(content.getByRole("checkbox")).toHaveAttribute("aria-checked", "false");
  const box = await content.getByRole("checkbox").boundingBox();
  await page.mouse.click(box!.x + 6, box!.y + 10);
  await expect(content.getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
  await toolbar(page).getByRole("button", { name: "Undo", exact: true }).click();
  await expect(content.getByRole("checkbox")).toHaveAttribute("aria-checked", "false");
});
test("slash menu supports keyboard filtering, insertion, Escape and no matches", async ({ page }) => {
  const content = editor(page); await content.click(); await page.keyboard.type("/heading");
  await expect(page.getByRole("option")).toHaveCount(3);
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); await page.keyboard.type("A section");
  await expect(content.locator("h2")).toHaveText("A section");
  await page.keyboard.press("Enter"); await page.keyboard.type("/nonexistent");
  await expect(page.getByRole("status").filter({ hasText: "No matching blocks" })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(content).toContainText("/nonexistent");
});
test("selection formatting and link dialogs preserve the selected text", async ({ page }) => {
  const content = editor(page); await content.fill("A useful link"); await content.press("Control+a");
  await expect(page.getByRole("toolbar", { name: "Selection formatting", exact: true })).toBeVisible();
  await toolbar(page).getByRole("button", { name: "Bold", exact: true }).click();
  await expect(content.locator("strong")).toHaveText("A useful link");
  await toolbar(page).getByRole("button", { name: "Edit link", exact: true }).click();
  await page.getByLabel("URL", { exact: false }).fill("javascript:alert(1)");
  await page.getByRole("button", { name: "Save link", exact: true }).click();
  await expect(page.getByText("Use an http(s), mailto")).toBeVisible();
  await page.getByLabel("URL", { exact: false }).fill("https://example.com/docs");
  await page.getByRole("button", { name: "Save link", exact: true }).click();
  await expect(content.locator("a")).toHaveAttribute("href", "https://example.com/docs");
  await expect(content.locator("a")).toHaveText("A useful link");
  await expect(content).toBeFocused();
});
test("block conversion, duplication and movement keep content intact", async ({ page }) => {
  const content = editor(page); await content.fill("First");
  await page.keyboard.press("End"); await page.keyboard.press("Enter"); await page.keyboard.type("Second");
  await toolbar(page).getByRole("button", { name: "Turn into", exact: true }).click();
  await page.getByRole("menuitem", { name: "Heading 2", exact: true }).click();
  await expect(content.locator("h2")).toHaveText("Second");
  await toolbar(page).getByRole("button", { name: "Block actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Duplicate block", exact: true }).click();
  await expect(content.locator("h2")).toHaveCount(2);
  await toolbar(page).getByRole("button", { name: "Block actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete block", exact: true }).click();
  await expect(content.locator("h2")).toHaveCount(1);
  await expect(content).toContainText("First");
});
test("plain Markdown paste creates structure rather than raw syntax", async ({ page }) => {
  const content = editor(page); await content.click();
  await content.evaluate((element) => {
    const data = new DataTransfer(); data.setData("text/plain", "## Pasted heading\n\n- One\n- Two");
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(content.locator("h2")).toHaveText("Pasted heading"); await expect(content.locator("li")).toHaveCount(2);
});
test("document presentation retains selection formatting and usable on-demand tools", async ({ page }) => {
  await page.goto(`${url}document&viewMode=story&globals=theme:light`);
  const content = editor(page); await content.fill("A focused document"); await content.press("Control+a");
  await expect(toolbar(page)).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "Selection formatting", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Editing tools", exact: true }).click();
  await toolbar(page).getByRole("button", { name: "Bold", exact: true }).click();
  await expect(content.locator("strong")).toHaveText("A focused document");
  await page.keyboard.press("Escape"); await expect(toolbar(page)).toHaveCount(0);
});
