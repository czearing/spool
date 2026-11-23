import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("working dot uses a stable colored center, a subtle halo, and reduced motion", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:6006/iframe.html?id=ui-status-dot--working&viewMode=story");
  const dot = page.getByRole("img", { name: "Working", exact: true });
  await expect(dot).toBeVisible();
  expect(await dot.locator("svg").count()).toBe(0);
  expect(await dot.evaluate((node) => ({ width: getComputedStyle(node).width, height: getComputedStyle(node).height })))
    .toEqual({ width: "8px", height: "8px" });
  expect(await dot.evaluate((node) => getComputedStyle(node, "::after").animationName)).not.toBe("none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await dot.evaluate((node) => getComputedStyle(node, "::after").animationName)).toBe("none");
  await expect(dot).toBeVisible();
  expect((await new AxeBuilder({ page }).include("#storybook-root").withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  expect(errors).toEqual([]);
});

test("interactive board shares archive menus without archiving other statuses", async ({ page }) => {
  await page.goto("http://127.0.0.1:6006/iframe.html?id=workroom-board--default&viewMode=story");
  await page.getByRole("button", { name: "Completed actions" }).click();
  await page.getByRole("menuitem", { name: "Move all to archive" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Move all to archive" }).click();
  await expect(page.getByRole("list", { name: "Completed items", exact: true }).locator("li")).toHaveCount(0);
  await expect(page.getByRole("list", { name: "In progress items", exact: true }).locator("li")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Archive (1)", exact: true })).toBeVisible();
});
