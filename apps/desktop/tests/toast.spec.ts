import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const story = (name: string, theme = "light") => `http://127.0.0.1:6006/iframe.html?id=components-toast--${name}&viewMode=story&globals=theme:${theme}`;

for (const theme of ["light", "dark"]) {
  test(`${theme}: Toast announces, dismisses, and can be shown again`, async ({ page }) => {
    await page.goto(story("default", theme));
    const trigger = page.getByRole("button", { name: "Save changes" });
    await trigger.click();
    const toast = page.locator('li[data-state="open"]');
    await expect(toast).toContainText("Changes saved");
    await expect(toast).toContainText("Your work item is up to date.");
    await expect(toast).toHaveCSS("background-color", theme === "light" ? "rgb(255, 255, 255)" : "rgb(20, 20, 20)");
    await expect(trigger).toBeFocused();
    await expect(page.locator('[role="status"][aria-live]').filter({ hasText: "Changes saved" })).toBeAttached();
    await toast.hover();
    expect((await new AxeBuilder({ page }).include('li[data-state="open"]').withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(toast).toHaveCount(0);
    await trigger.click();
    await expect(toast).toBeVisible();
    await page.keyboard.press("F8");
    await page.keyboard.press("Escape");
    await expect(toast).toHaveCount(0);
  });
}

test("ToastAction performs Undo and closes the notification", async ({ page }) => {
  await page.goto(story("with-action"));
  await page.getByRole("button", { name: "Archive item" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Item archived" }).first()).toBeAttached();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator("#storybook-root").getByRole("status")).toHaveText("Item restored");
  await expect(page.locator('li[data-state="open"]')).toHaveCount(0);
});

test("Toast timer pauses on hover and resumes without custom timers", async ({ page }) => {
  await page.goto(story("auto-dismiss"));
  await page.getByRole("button", { name: "Save changes" }).click();
  const toast = page.locator('li[data-state="open"]');
  await toast.hover();
  await page.waitForTimeout(2300);
  await expect(toast).toBeVisible();
  await page.mouse.move(1, 1);
  await expect(toast).toHaveCount(0, { timeout: 4000 });
});

test("Toast swipe dismisses without changing other content", async ({ page }) => {
  await page.goto(story("default"));
  await page.getByRole("button", { name: "Save changes" }).click();
  const toast = page.locator('li[data-state="open"]');
  const box = await toast.boundingBox();
  if (!box) throw new Error("Missing notification");
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 20, { steps: 10 });
  await page.mouse.up();
  await expect(toast).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
});
