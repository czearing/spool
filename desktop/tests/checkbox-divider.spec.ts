import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const story = (id: string, theme = "light") => `http://127.0.0.1:6006/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`;
for (const theme of ["light", "dark"]) test(`${theme}: shared checkboxes have native keyboard, label, mixed and disabled behavior`, async ({ page }) => {
  await page.goto(story("components-checkbox--default", theme));
  const checkbox = page.getByRole("checkbox", { name: "Send me updates", exact: true });
  await page.getByText("Send me updates", { exact: true }).click(); await expect(checkbox).toBeChecked();
  await checkbox.focus(); await page.keyboard.press("Space"); await expect(checkbox).not.toBeChecked();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.goto(story("components-checkbox--indeterminate", theme));
  await expect(page.getByRole("checkbox")).toHaveAttribute("aria-checked", "mixed");
  await page.getByRole("checkbox").press("Space"); await expect(page.getByRole("checkbox")).toBeChecked();
  await page.goto(story("components-checkbox--disabled", theme));
  await expect(page.getByRole("checkbox")).toBeDisabled(); await expect(page.getByRole("checkbox")).toBeChecked();
});
test("the shared checkbox participates in form validation and submission", async ({ page }) => {
  await page.goto(story("components-checkbox--form"));
  await page.getByRole("button", { name: "Save preference" }).click();
  await expect(page.getByRole("status")).toBeEmpty();
  await page.getByRole("checkbox").check(); await page.getByRole("button", { name: "Save preference" }).click();
  await expect(page.getByRole("status")).toHaveText("subscribed");
});
test("dividers expose the intended semantics and vertical dividers fill their row", async ({ page }) => {
  await page.goto(story("components-divider--default")); await expect(page.getByRole("separator")).toHaveCount(0);
  await page.goto(story("components-divider--semantic")); await expect(page.getByRole("separator")).toHaveCount(1);
  await page.goto(story("components-divider--vertical"));
  const divider = page.getByRole("separator");
  await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  const dimensions = await divider.evaluate((node) => ({ height: node.getBoundingClientRect().height, parent: node.parentElement!.getBoundingClientRect().height, width: node.getBoundingClientRect().width }));
  expect(dimensions.height).toBe(dimensions.parent); expect(dimensions.width).toBe(1);
});
test("the reusable toolbar owns keyboard navigation and shared separators", async ({ page }) => {
  for (const vertical of [false, true]) {
    await page.goto(story(`components-toolbar--${vertical ? "vertical" : "default"}`));
    await page.getByRole("button", { name: "Download" }).focus(); await page.keyboard.press(vertical ? "ArrowDown" : "ArrowRight");
    await expect(page.getByRole("button", { name: "Print" })).toBeFocused();
    const separator = page.getByRole("separator");
    await expect(separator).toHaveAttribute("data-orientation", vertical ? "horizontal" : "vertical");
  }
});
test("editor tasks reuse the shared checkbox without losing text, checked state or focus", async ({ page }) => {
  await page.goto(story("components-editor--default"));
  const editor = page.getByRole("textbox", { name: "Document", exact: true });
  const finished = editor.getByRole("checkbox", { name: "Find a direction", exact: true });
  await expect(finished).toBeChecked();
  await finished.uncheck(); await expect(finished).not.toBeChecked();
  await page.getByRole("button", { name: "Undo", exact: true }).click(); await expect(finished).toBeChecked();
  const task = editor.getByRole("checkbox", { name: "Write the first draft", exact: true });
  await task.focus(); await page.keyboard.press("Space"); await expect(task).toBeChecked(); await expect(task).toBeFocused();
  await page.keyboard.press("Space"); await expect(task).not.toBeChecked();
  const text = editor.locator("[data-list-content]").filter({ hasText: /^Write the first draft$/ });
  await text.click(); await page.keyboard.press("End"); await page.keyboard.type(" today");
  await expect(editor.getByRole("checkbox", { name: "Write the first draft today", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor.getByRole("checkbox", { name: "Write the first draft", exact: true })).toBeVisible();
  await expect(editor.locator("li[role=checkbox]")).toHaveCount(0);
});
test("new empty lists preserve the caret and typed checklists mount shared controls", async ({ page }) => {
  await page.goto(story("components-editor--empty"));
  const editor = page.getByRole("textbox", { name: "Document", exact: true });
  await editor.click(); await page.keyboard.type("- [ ] First task");
  await expect(editor.getByRole("checkbox", { name: "First task", exact: true })).toBeVisible();
  await page.keyboard.press("Enter"); await page.keyboard.type("Second task");
  await expect(editor.getByRole("checkbox", { name: "Second task", exact: true })).toBeVisible();
  await page.keyboard.press("Tab"); await page.keyboard.type(" nested");
  await expect(editor.getByRole("checkbox", { name: "Second task nested", exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});
