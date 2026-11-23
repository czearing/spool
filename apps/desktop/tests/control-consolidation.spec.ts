import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const story = (id: string, theme = "light") => `http://127.0.0.1:6006/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`;

for (const theme of ["light", "dark"]) test(`${theme}: shared popovers manage focus, dismissal and accessible content`, async ({ page }) => {
  await page.goto(story("components-popover--default", theme));
  const trigger = page.getByRole("button", { name: "Quick edit", exact: true });
  await trigger.click(); const dialog = page.getByRole("dialog", { name: "Quick edit", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Work item", exact: true })).toBeFocused();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape"); await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
  await trigger.click(); await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
});
test("command presentation composes with Radix keyboard navigation, disabled items and selection", async ({ page }) => {
  await page.goto(story("components-commandlist--default"));
  const trigger = page.getByRole("button", { name: "Actions", exact: true });
  await trigger.focus(); await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: /^Create document/ })).toBeFocused();
  await expect(page.getByRole("menuitem", { name: /^Archive/ })).toBeDisabled();
  await page.keyboard.press("ArrowDown"); await expect(page.getByRole("menuitem", { name: /^Open project/ })).toBeFocused();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.keyboard.press("Enter"); await expect(page.getByRole("status")).toHaveText("Opened project");
  await expect(trigger).toBeFocused();
});
test("shared disclosures support native button composition, controlled state and disabled behavior", async ({ page }) => {
  for (const name of ["default", "composed", "controlled"]) {
    await page.goto(story(`components-collapsible--${name}`));
    const trigger = page.getByRole("button", { name: "Project details", exact: true });
    await trigger.focus(); await page.keyboard.press("Space"); await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Supporting context stays here until you need it.")).toBeVisible();
    const contentId = await trigger.getAttribute("aria-controls"); expect(contentId).toBeTruthy();
    await expect(page.locator(`[id="${contentId}"]`)).toBeVisible();
    if (name === "controlled") await expect(page.getByRole("status")).toHaveText("Expanded");
    await page.keyboard.press("Enter"); await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("Supporting context stays here until you need it.")).toBeHidden();
  }
  await page.goto(story("components-collapsible--disabled"));
  await expect(page.getByRole("button", { name: "Project details", exact: true })).toBeDisabled();
});
test("board actions share roving focus without stealing search editing keys", async ({ page }) => {
  await page.goto(story("workroom-board--default"));
  const toolbar = page.getByRole("toolbar", { name: "Board actions", exact: true });
  await toolbar.getByRole("button", { name: "Search board", exact: true }).focus();
  for (const name of ["Filter by status", "Sort work items", "New"]) {
    await page.keyboard.press("ArrowRight"); await expect(toolbar.getByRole("button", { name, exact: true })).toBeFocused();
  }
  await page.keyboard.press("Home"); await page.keyboard.press("Enter");
  const input = toolbar.getByRole("searchbox", { name: "Search work items", exact: true });
  await expect(input).toBeFocused(); await expect(input).toHaveAttribute("data-density", "compact");
  await input.fill("draft"); await page.keyboard.press("ArrowLeft"); await expect(input).toBeFocused();
  await page.keyboard.press("Escape"); await expect(input).toHaveCount(0);
  await expect(toolbar.getByRole("button", { name: "Search board", exact: true })).toBeFocused();
});
test("conditional editor commands participate in the shared toolbar's arrow-key order", async ({ page }) => {
  await page.goto(story("components-editor--default"));
  const editor = page.getByRole("textbox", { name: "Document", exact: true });
  const toolbar = page.getByRole("toolbar", { name: "Text formatting", exact: true });
  for (const [selector, name] of [["code[data-highlight-language]", "Code language"], ["th", "Table actions"]]) {
    await editor.locator(selector).first().click(); await expect(toolbar.getByRole("button", { name, exact: true })).toBeVisible();
    await toolbar.getByRole("button", { name: "Insert block", exact: true }).focus(); await page.keyboard.press("ArrowRight");
    await expect(toolbar.getByRole("button", { name, exact: true })).toBeFocused();
  }
});
test("compact inputs keep a real accessible label and primary toolbar buttons retain their variant", async ({ page }) => {
  await page.goto(story("components-input--compact"));
  const input = page.getByRole("textbox", { name: "Work item", exact: true });
  await expect(input).toHaveCSS("min-height", "32px"); await input.fill("A compact field");
  await expect(input).toHaveValue("A compact field");
  await page.goto(story("components-toolbar--primary-action"));
  const primary = page.getByRole("button", { name: "Create", exact: true });
  await expect(primary).toHaveCSS("background-color", "rgb(23, 23, 23)");
  await expect(primary).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(page.getByRole("button", { name: "Unavailable", exact: true })).toBeDisabled();
});
test("editor callouts and disclosures use the standalone surfaces while retaining editable content", async ({ page }) => {
  await page.goto(story("components-callout--default"));
  const surface = await page.getByRole("note", { name: "Project note", exact: true }).evaluate((node) => {
    const css = getComputedStyle(node); return [css.padding, css.borderRadius, css.backgroundColor, css.borderColor];
  });
  await page.goto(story("components-editor--default"));
  const editor = page.getByRole("textbox", { name: "Document", exact: true }), note = editor.getByRole("note");
  expect(await note.evaluate((node) => { const css = getComputedStyle(node); return [css.padding, css.borderRadius, css.backgroundColor, css.borderColor]; })).toEqual(surface);
  await note.locator("p").click(); await page.keyboard.press("End"); await page.keyboard.type(" More context.");
  await expect(note).toContainText("More context.");
  const summary = editor.locator("summary"); await summary.click({ position: { x: 4, y: 10 } });
  await expect(editor.locator("details")).not.toHaveAttribute("open");
  await summary.click({ position: { x: 4, y: 10 } }); await expect(editor.locator("details")).toHaveAttribute("open");
  await summary.click({ position: { x: 100, y: 10 } }); await page.keyboard.press("End"); await page.keyboard.type(" updated");
  await expect(summary).toContainText("updated");
});
test("shared insertion indicators match their anchor along either axis", async ({ page }) => {
  for (const orientation of ["horizontal", "vertical"]) {
    await page.goto(story(`components-dropindicator--${orientation}`));
    const target = page.getByText("Drop target", { exact: true }), indicator = page.locator("[data-drop-indicator]");
    await expect(indicator).toBeVisible(); await expect(indicator).toHaveAttribute("data-orientation", orientation);
    const reference = (await target.boundingBox())!, marker = (await indicator.boundingBox())!;
    expect(orientation === "horizontal" ? marker.width : marker.height).toBe(orientation === "horizontal" ? reference.width : reference.height);
    expect(orientation === "horizontal" ? marker.height : marker.width).toBe(2);
  }
});
