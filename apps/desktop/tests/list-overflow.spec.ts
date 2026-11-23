import { expect, test, type Locator } from "@playwright/test";

async function fits(region: Locator) {
  await expect(region).toBeVisible();
  await expect.poll(() => region.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
}

for (const theme of ["light", "dark"]) {
  test(`${theme}: visible dividers follow brand tokens without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    for (const story of ["default", "sorting", "empty", "loading", "compact", "with-actions", "long-content"]) {
      await page.goto(`http://127.0.0.1:6006/iframe.html?id=components-list--${story}&viewMode=story&globals=theme:${theme}`);
      const region = page.getByRole("region", { name: "Work items list", exact: true });
      await fits(region);
      await expect(region.locator('[aria-haspopup="menu"]')).toHaveCount(0);
      const handle = region.getByRole("separator", { name: "Resize Work item", exact: true });
      const appearance = () => handle.evaluate((element) => {
        const style = getComputedStyle(element, "::after");
        return { opacity: style.opacity, width: style.width, height: style.height, top: style.top, bottom: style.bottom, transform: style.transform, color: style.backgroundColor };
      });
      const height = await handle.evaluate((element) => getComputedStyle(element).height);
      const rest = { opacity: "1", width: "1px", height, top: "0px", bottom: "0px", transform: "none",
        color: theme === "light" ? "rgb(229, 229, 229)" : "rgb(43, 43, 43)" };
      await expect.poll(appearance).toEqual(rest);
      await handle.hover();
      const emphasis = theme === "light" ? "rgb(23, 23, 23)" : "rgb(237, 237, 237)";
      await expect.poll(appearance).toEqual({ ...rest, color: emphasis });
      await handle.focus();
      await expect.poll(appearance).toEqual({ ...rest, width: "2px", color: emphasis });
      await expect(handle).toHaveCSS("outline-style", "none");
      await page.keyboard.press("Tab");
      await page.mouse.move(1, 1);
      await expect.poll(appearance).toEqual(rest);
    }
  });
}

test("shrinking, saved widths, and reset do not create two-pixel overflow", async ({ page }) => {
  await page.goto("http://127.0.0.1:6006/iframe.html?id=components-list--remembered-layout&viewMode=story");
  const region = page.getByRole("region", { name: "Work items list", exact: true });
  await fits(region);
  await region.getByRole("separator", { name: "Resize Work item", exact: true }).focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await fits(region);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("spool:list:storybook-work-items"))).not.toBeNull();
  await page.reload();
  await fits(region);
  await region.getByRole("button", { name: "Work item", exact: true }).focus();
  await page.keyboard.press("Alt+Home");
  await fits(region);
});

test("genuine overflow remains scrollable and is confined to the list", async ({ page }) => {
  await page.goto("http://127.0.0.1:6006/iframe.html?id=components-list--sorting&viewMode=story");
  const region = page.getByRole("region", { name: "Work items list", exact: true });
  await fits(region);
  await region.getByRole("separator", { name: "Resize Work item", exact: true }).focus();
  await page.keyboard.press("End");
  await expect.poll(() => region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await region.getByRole("button", { name: "Updated", exact: true }).scrollIntoViewIfNeeded();
  await expect(region.getByRole("button", { name: "Updated", exact: true })).toBeInViewport();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("the archive fits without a minimum-width scrollbar", async ({ page }) => {
  await page.goto("http://127.0.0.1:6006/iframe.html?id=workroom-board--with-archive&viewMode=story");
  await page.getByRole("button", { name: "Archive (2)", exact: true }).click();
  const region = page.getByRole("region", { name: "Archived work items list", exact: true });
  await fits(region);
  await page.setViewportSize({ width: 390, height: 844 });
  await fits(region);
});
