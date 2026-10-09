import { expect, test } from "@playwright/test";

const story = (name: string, theme = "light") => `http://127.0.0.1:6006/iframe.html?id=components-${name}&viewMode=story&globals=theme:${theme}`;

for (const theme of ["light", "dark"]) {
  test(`${theme}: narrow layouts and double text size preserve new controls and overlays`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 360, height: 740 });
    for (const name of ["input--invalid", "textarea--invalid", "pivot--default", "avatar--sizes", "dropdown-button--default",
      "dialog--long-content", "dropdown--long-options", "tooltip--long-content", "toast--long-content"]) {
      await page.goto(story(name, theme));
      await expect(page.locator("#storybook-root")).not.toBeEmpty();
      await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      if (name.startsWith("dialog")) {
        await page.getByRole("button", { name: "Edit work item" }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeInViewport();
        const box = await dialog.boundingBox();
        expect(box!.height).toBeLessThanOrEqual(708);
        expect(await dialog.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
        await page.getByRole("button", { name: "Close dialog" }).click();
        await expect(dialog).toBeHidden();
      } else if (name.startsWith("dropdown--")) {
        await page.getByRole("combobox").focus();
        await page.keyboard.press("Space");
        await expect(page.getByRole("listbox", { name: "Status" })).toBeInViewport();
        await page.keyboard.press("End");
        await expect(page.getByRole("option", { name: "Project 50", exact: true })).toBeFocused();
        await expect(page.getByRole("option", { name: "Project 50", exact: true })).toBeInViewport();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("combobox")).toHaveText("Project 50");
      } else if (name.startsWith("tooltip")) {
        await page.getByRole("button", { name: "Archive item" }).focus();
        await expect(page.getByRole("tooltip")).toBeVisible();
        const popup = page.locator("[data-radix-popper-content-wrapper]");
        const box = await popup.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(360);
      } else if (name.startsWith("toast")) {
        await page.getByRole("button", { name: "Save changes" }).click();
        await expect(page.locator('li[data-state="open"]')).toBeInViewport();
        await page.getByRole("button", { name: "Dismiss notification" }).click();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name).toBe(true);
      for (const control of await page.locator("#storybook-root input, #storybook-root textarea").all()) {
        await expect(control).toHaveCSS("font-size", "28px");
        expect(await control.evaluate((element) => element.clientWidth > 0)).toBe(true);
      }
    }
  });
}

test("forced colors keeps fields, selected tabs, menu focus, and dialog controls identifiable", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto(story("input--default"));
  const input = page.getByRole("textbox");
  await input.focus();
  await expect(input).toHaveCSS("outline-width", "2px");
  expect(await input.evaluate((element) => {
    const style = getComputedStyle(element);
    return style.color !== style.backgroundColor && style.borderColor !== style.backgroundColor;
  })).toBe(true);
  await page.goto(story("pivot--default"));
  const tab = page.getByRole("tab", { name: "Overview" });
  await expect(tab).toHaveCSS("border-bottom-width", "2px");
  await page.goto(story("menu--default"));
  await page.getByRole("button").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Rename" })).toHaveCSS("outline-width", "2px");
  await page.goto(story("dialog--default"));
  await page.getByRole("button").click();
  await expect(page.getByRole("dialog")).toHaveCSS("border-top-width", "1px");
  await expect(page.getByRole("dialog")).toHaveCSS("box-shadow", "none");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Edit work item" })).toBeFocused();
});

test("reduced motion disables floating panel and toast entrance animations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const name of ["dialog--default", "menu--default", "dropdown--default", "toast--default", "tooltip--default"]) {
    await page.goto(story(name));
    if (name.startsWith("tooltip")) await page.getByRole("button").focus();
    else if (name.startsWith("dropdown")) await page.getByRole("combobox").click();
    else await page.getByRole("button").click();
    const panel = page.locator('[role="dialog"], [role="menu"], [role="listbox"], li[data-state="open"], [data-radix-popper-content-wrapper] > [data-state]');
    await expect(panel.first()).toBeVisible();
    for (const element of await panel.all()) await expect(element).toHaveCSS("animation-name", "none");
  }
});

test("RTL nested menus use the opposite submenu arrow keys", async ({ page }) => {
  await page.goto(story("menu--right-to-left"));
  await page.getByRole("button", { name: "Work item actions" }).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Move to" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("menuitem", { name: "Planning" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("menuitem", { name: "Backlog" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Moved to Backlog");
});

test("touch can open a submenu, choose an option, and dismiss a dialog", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto(story("menu--nested"));
    await page.getByRole("button", { name: "Work item actions" }).tap();
    await page.getByRole("menuitem", { name: "Move to", exact: true }).tap();
    await page.getByRole("menuitem", { name: "Planning", exact: true }).tap();
    await page.getByRole("menuitem", { name: "Backlog", exact: true }).tap();
    await expect(page.getByRole("status")).toHaveText("Moved to Backlog");
    await page.goto(story("dropdown--default"));
    await page.getByRole("combobox").tap();
    await page.getByRole("option", { name: "Completed", exact: true }).tap();
    await expect(page.getByRole("combobox")).toHaveText("Completed");
    await page.goto(story("dialog--default"));
    await page.getByRole("button", { name: "Edit work item" }).tap();
    await page.getByRole("button", { name: "Close dialog" }).tap();
    await expect(page.getByRole("dialog")).toBeHidden();
  } finally { await context.close(); }
});
