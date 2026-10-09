import { expect, test } from "@playwright/test";

const story = "http://127.0.0.1:6006/iframe.html?id=components-accordion--default&viewMode=story";

test("chevron and measured content height animate together", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(story);
  const trigger = page.getByRole("button", { name: "Details", exact: true });
  await trigger.focus();
  const middle = await trigger.evaluate((button) => new Promise<{
    contentAnimations: number; chevronAnimations: number; height: number; fullHeight: number; rotation: number;
  }>((resolve) => {
    if (!(button instanceof HTMLButtonElement)) throw new Error("Expected an accordion button");
    button.click();
    requestAnimationFrame(() => {
      const content = document.getElementById(button.getAttribute("aria-controls")!);
      const chevron = button.querySelector("svg");
      if (!content || !chevron) throw new Error("Missing accordion content or chevron");
      const contentAnimations = content.getAnimations();
      const chevronAnimations = chevron.getAnimations();
      for (const animation of [...contentAnimations, ...chevronAnimations]) {
        animation.pause();
        animation.currentTime = 90;
      }
      resolve({
        contentAnimations: contentAnimations.length,
        chevronAnimations: chevronAnimations.length,
        height: content.getBoundingClientRect().height,
        fullHeight: parseFloat(getComputedStyle(content).getPropertyValue("--radix-accordion-content-height")),
        rotation: new DOMMatrix(getComputedStyle(chevron).transform).a,
      });
    });
  }));
  expect(middle.contentAnimations).toBe(1);
  expect(middle.chevronAnimations).toBe(1);
  expect(middle.height).toBeGreaterThan(0);
  expect(middle.height).toBeLessThan(middle.fullHeight);
  expect(middle.rotation).toBeGreaterThan(-1);
  expect(middle.rotation).toBeLessThan(1);
  await page.evaluate(() => document.getAnimations().forEach((animation) => animation.finish()));
  const content = page.getByRole("region", { name: "Details", exact: true });
  await expect(content).toHaveCSS("overflow", "visible");
  await expect(trigger.locator("svg")).toHaveCSS("transform", "matrix(-1, 0, 0, -1, 0, 0)");
  await trigger.click();
  await expect(content).toBeHidden();
  await expect(trigger.locator("svg")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await expect(trigger).toBeFocused();
});

test("reduced motion switches state immediately without rotating or height animations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(story);
  const trigger = page.getByRole("button", { name: "Details", exact: true });
  await expect(trigger.locator("svg")).toHaveAttribute("aria-hidden", "true");
  await expect(trigger.locator("svg")).toHaveAttribute("focusable", "false");
  await trigger.click();
  const content = page.getByRole("region", { name: "Details", exact: true });
  await expect(content).toBeVisible();
  await expect(content).toHaveCSS("animation-name", "none");
  await expect(trigger.locator("svg")).toHaveCSS("transition-duration", "0s");
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  await trigger.click();
  await expect(content).toBeHidden();
});

test("long headings retain a full-row target and a fixed-size chevron", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(story.replace("--default", "--long-content") + "&globals=theme:dark");
  const trigger = page.getByRole("button", { name: /A longer heading/ });
  await expect(trigger.locator("svg")).toHaveCSS("width", "16px");
  expect((await trigger.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await trigger.evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) throw new Error("Expected an accordion button");
    button.click(); button.click(); button.click();
  });
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Content action", exact: true })).toBeVisible();
});
