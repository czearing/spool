import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const story = (name: string, theme = "light") => `http://127.0.0.1:6006/iframe.html?id=components-${name}&viewMode=story&globals=theme:${theme}`;

for (const theme of ["light", "dark"]) {
  test(`${theme}: Avatar exposes one accessible name and keeps its size through image loading and failure`, async ({ page }) => {
    await page.goto(story("avatar--default", theme));
    const avatar = page.getByRole("img", { name: "Jordan Rivers" });
    await expect(avatar).toHaveText("JR");
    await expect(avatar).toHaveCSS("width", "32px");
    await expect(avatar).toHaveCSS("height", "32px");
    await page.goto(story("avatar--image", theme));
    await expect(avatar.locator("img")).toBeVisible();
    await expect(avatar).toHaveText("");
    await expect(page.getByRole("img")).toHaveCount(1);
    await page.goto(story("avatar--image-failure", theme));
    await expect(avatar).toHaveText("JR");
    await expect(avatar).toHaveCSS("width", "32px");
    await page.goto(story("avatar--sizes", theme));
    for (const [name, size] of [["Jordan Rivers", 24], ["Sam Lee", 32], ["Alex Morgan", 40]] as const) {
      await expect(page.getByRole("img", { name })).toHaveCSS("width", `${size}px`);
    }
    expect((await new AxeBuilder({ page }).include("#storybook-root").withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  });

  test(`${theme}: Pivot connects tabs and panels and skips disabled tabs`, async ({ page }) => {
    await page.goto(story("pivot--default", theme));
    const overview = page.getByRole("tab", { name: "Overview" });
    const activity = page.getByRole("tab", { name: "Activity" });
    await expect(page.getByRole("tablist", { name: "Work item views" })).toBeVisible();
    await expect(overview).toHaveAttribute("aria-selected", "true");
    const panel = page.getByRole("tabpanel", { name: "Overview" });
    await expect(overview).toHaveAttribute("aria-controls", await panel.getAttribute("id") ?? "");
    await overview.focus();
    await page.keyboard.press("ArrowRight");
    await expect(activity).toBeFocused();
    await expect(activity).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByRole("tabpanel", { name: "Activity" })).toHaveText("No recent activity.");
    await page.keyboard.press("ArrowRight");
    await expect(overview).toBeFocused();
    await expect(page.getByRole("tab", { name: "History" })).toBeDisabled();
    expect((await new AxeBuilder({ page }).include("#storybook-root").withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  });
}

test("manual, vertical, and controlled Pivot modes retain Radix keyboard behavior", async ({ page }) => {
  await page.goto(story("pivot--manual"));
  await page.getByRole("tab", { name: "Overview" }).focus();
  await page.keyboard.press("ArrowRight");
  const activity = page.getByRole("tab", { name: "Activity" });
  await expect(activity).toBeFocused();
  await expect(activity).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Enter");
  await expect(activity).toHaveAttribute("aria-selected", "true");
  await page.goto(story("pivot--vertical"));
  await expect(page.getByRole("tablist")).toHaveAttribute("aria-orientation", "vertical");
  await page.getByRole("tab", { name: "Overview" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(activity).toBeFocused();
  await expect(activity).toHaveAttribute("aria-selected", "true");
  await page.goto(story("pivot--controlled"));
  await activity.click();
  await expect(page.getByRole("status")).toHaveText("Selected: activity");
});
