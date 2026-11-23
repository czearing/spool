import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const story = (name: string, theme = "light") => `http://127.0.0.1:6006/iframe.html?id=components-${name}&viewMode=story&globals=theme:${theme}`;

for (const theme of ["light", "dark"]) {
  test(`${theme}: Dialog has a connected title, description, focus trap, and focus return`, async ({ page }) => {
    await page.goto(story("dialog--default", theme));
    const trigger = page.getByRole("button", { name: "Edit work item", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Edit work item", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Title", exact: true })).toBeFocused();
    await expect(dialog).toHaveAccessibleDescription("Keep the title clear and the next step actionable.");
    await expect(dialog).toHaveCSS("background-color", theme === "light" ? "rgb(255, 255, 255)" : "rgb(20, 20, 20)");
    for (let step = 0; step < 6; step++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Shift+Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    expect((await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.mouse.click(2, 2);
    await expect(dialog).toBeHidden();
  });

  test(`${theme}: Tooltip works on keyboard focus, is described, hoverable, and dismissible`, async ({ page }) => {
    await page.goto(story("tooltip--default", theme));
    const trigger = page.getByRole("button", { name: "Archive item", exact: true });
    await trigger.focus();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toHaveText("Move this item into the archive.");
    await expect(trigger).toHaveAttribute("aria-describedby", await tooltip.getAttribute("id") ?? "");
    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.blur();
    await trigger.hover();
    await expect(tooltip).toBeVisible();
    await page.locator("[data-radix-popper-content-wrapper]").hover();
    await expect(tooltip).toBeVisible();
    await page.mouse.move(2, 2);
    await expect(tooltip).toBeHidden();
  });
}

test("controlled Dialog saves native form data and closes without losing trigger focus", async ({ page }) => {
  await page.goto(story("dialog--controlled"));
  const trigger = page.getByRole("button", { name: "Edit work item" });
  await trigger.click();
  await page.getByRole("textbox", { name: "Title" }).fill("Review release");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("status")).toHaveText("Saved: Review release");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(page.getByRole("textbox")).toHaveValue("Review release");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("portaled Dropdown and Tooltip inside Dialog preserve layering and Escape ownership", async ({ page }) => {
  await page.goto(story("dialog--nested-overlays", "dark"));
  await page.getByRole("button", { name: "Edit work item" }).click();
  const dialog = page.getByRole("dialog");
  const dropdown = page.getByRole("combobox", { name: "Status" });
  await dropdown.click();
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  await expect(listbox).toHaveCSS("background-color", "rgb(20, 20, 20)");
  await page.keyboard.press("Escape");
  await expect(listbox).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(dropdown).toBeFocused();
  await dropdown.click();
  await page.getByRole("option", { name: "Completed", exact: true }).click();
  await expect(dropdown).toHaveText("Completed");
  await page.getByRole("button", { name: "About this change" }).focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();
  await expect(dialog).toBeVisible();
});

test("Dialog without description has no dangling ARIA reference or Radix warning", async ({ page }) => {
  const warnings: string[] = [];
  page.on("console", (message) => { if (["warning", "error"].includes(message.type())) warnings.push(message.text()); });
  await page.goto(story("dialog--without-description"));
  await page.getByRole("button", { name: "Edit work item" }).click();
  await expect(page.getByRole("dialog")).not.toHaveAttribute("aria-describedby");
  expect(warnings).toEqual([]);
});
