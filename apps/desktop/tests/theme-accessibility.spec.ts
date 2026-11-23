import { expect, test } from "@playwright/test";

test("dark mode preserves keyboard dragging into a collapsed archive", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("http://127.0.0.1:6006/iframe.html?id=workroom-board--default&viewMode=story&globals=theme:dark");
  await expect(page.getByRole("button", { name: "Archive (0)", exact: true })).toHaveAttribute("aria-expanded", "false");
  const card = page.getByRole("button", { name: "Set up project", exact: true });
  await card.focus();
  await page.keyboard.press("Space");
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowDown");
  const archive = page.getByRole("region", { name: "Archive", exact: true });
  await expect(archive).toHaveAttribute("data-over", "true");
  await expect(archive).toHaveCSS("background-color", "rgb(36, 36, 36)");
  await page.keyboard.press("Space");
  await expect(archive).toBeFocused();
  await expect(page.getByRole("button", { name: "Archive (1)", exact: true })).toHaveAttribute("aria-expanded", "false");
});

test("forced colors retains keyboard focus and visible control boundaries", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark", forcedColors: "active" });
  await page.goto("http://127.0.0.1:6006/iframe.html?id=workroom-board--default&viewMode=story&globals=theme:dark");
  const card = page.getByRole("button", { name: "Plan next release", exact: true });
  await card.focus();
  await expect(card).toHaveCSS("outline-width", "2px");
  await expect(card).toHaveCSS("outline-style", "solid");
  expect(await card.evaluate((element) => {
    const style = getComputedStyle(element);
    return style.color !== style.backgroundColor && style.borderColor !== style.backgroundColor;
  })).toBe(true);
});

test("reduced motion and 200% text sizing preserve content and horizontal scrolling", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 640, height: 450 });
  await page.goto("http://127.0.0.1:6006/iframe.html?id=workroom-board--default&viewMode=story&globals=theme:dark");
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  const card = page.getByRole("button", { name: "Plan next release", exact: true });
  await expect(card).toHaveCSS("font-size", "28px");
  await expect(card).toHaveCSS("transition-duration", "0s");
  expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--duration-fast").trim())).toMatch(/^0(?:ms|s)$/);
});
