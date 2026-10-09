import { expect, test } from "@playwright/test";

const stories = [
  ["dropdown--default", '[role="listbox"]', "floating"],
  ["menu--default", '[role="menu"]', "floating"],
  ["dialog--default", '[role="dialog"]', "dialog"],
  ["toast--default", 'li[data-state="open"]', "toast"],
  ["tooltip--default", "[data-radix-popper-content-wrapper] > [data-state]", "tooltip"],
] as const;

for (const theme of ["light", "dark"]) {
  test(`${theme}: every overlay uses its global shadow alias and shared surface border`, async ({ page }) => {
    for (const [story, selector, alias] of stories) {
      await page.goto(`http://127.0.0.1:6006/iframe.html?id=components-${story}&viewMode=story&globals=theme:${theme}`);
      if (story.startsWith("dropdown")) await page.getByRole("combobox").click();
      else if (story.startsWith("tooltip")) await page.getByRole("button").focus();
      else await page.getByRole("button").click();
      const panel = page.locator(selector);
      await expect(panel).toBeVisible();
      const shadow = await panel.evaluate((element) => getComputedStyle(element).boxShadow);
      expect(shadow).toContain(theme === "light" ? "0.06" : "0.32");
      expect(shadow).toContain(theme === "light" ? "0.1)" : "0.4)");
      await expect(panel).toHaveCSS("border-top-color", theme === "light" ? "rgb(229, 229, 229)" : "rgb(43, 43, 43)");
      await page.addStyleTag({ content: `:root { --shadow-${alias}: 0 0 0 3px rgb(23, 23, 23); }` });
      await expect(panel).toHaveCSS("box-shadow", "rgb(23, 23, 23) 0px 0px 0px 3px");
    }
  });
}

test("every elevation disappears in forced colors, without losing the boundary", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  for (const [story, selector] of stories) {
    await page.goto(`http://127.0.0.1:6006/iframe.html?id=components-${story}&viewMode=story`);
    if (story.startsWith("dropdown")) await page.getByRole("combobox").click();
    else if (story.startsWith("tooltip")) await page.getByRole("button").focus();
    else await page.getByRole("button").click();
    await expect(page.locator(selector)).toHaveCSS("box-shadow", "none");
    await expect(page.locator(selector)).toHaveCSS("border-top-width", "1px");
  }
});

test("toast shadows have reserved scroll gutters that do not intercept pointer events", async ({ page }) => {
  await page.goto("http://127.0.0.1:6006/iframe.html?id=components-toast--default&viewMode=story");
  await page.getByRole("button", { name: "Save changes" }).click();
  const toast = page.locator('li[data-state="open"]');
  await expect(toast).toBeVisible();
  const result = await toast.evaluate((element) => {
    const parent = element.parentElement!;
    const outer = parent.getBoundingClientRect();
    const inner = element.getBoundingClientRect();
    return {
      top: inner.top - outer.top, bottom: outer.bottom - inner.bottom,
      left: inner.left - outer.left, right: outer.right - inner.right,
      gutter: parseFloat(getComputedStyle(parent).paddingTop),
      intercepted: parent.contains(document.elementFromPoint(outer.right - 2, outer.bottom - 2)),
    };
  });
  expect(result.gutter).toBe(32);
  for (const edge of ["top", "bottom", "left", "right"] as const) expect(result[edge]).toBeGreaterThanOrEqual(result.gutter);
  expect(result.intercepted).toBe(false);
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(toast).toHaveCount(0);
});

test("stacked toasts scroll without collapsing their content or blocking dismiss buttons", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 450 });
  await page.goto("http://127.0.0.1:6006/iframe.html?id=components-toast--stacked&viewMode=story");
  await page.getByRole("button", { name: "Show notifications" }).click();
  const toasts = page.locator('li[data-state="open"]');
  await expect(toasts).toHaveCount(6);
  expect(await toasts.first().evaluate((element) => element.parentElement!.scrollHeight > element.parentElement!.clientHeight)).toBe(true);
  for (const toast of await toasts.all()) expect(await toast.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  const last = toasts.last();
  await last.scrollIntoViewIfNeeded();
  await last.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(toasts).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
