import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const story = (name: string, theme = "light") => `http://127.0.0.1:6006/iframe.html?id=components-${name}&viewMode=story&globals=theme:${theme}`;

for (const theme of ["light", "dark"]) {
  test(`${theme}: Menu handles keyboard navigation, disabled items, and selection`, async ({ page }) => {
    await page.goto(story("menu--default", theme));
    const trigger = page.getByRole("button", { name: "Work item actions", exact: true });
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Rename", exact: true })).toBeFocused();
    await expect(page.getByRole("menuitem", { name: "Share", exact: true })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Archive", exact: true })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.getByRole("menuitem", { name: "Rename", exact: true })).toBeFocused();
    await page.keyboard.press("a");
    await expect(page.getByRole("menuitem", { name: "Archive", exact: true })).toBeFocused();
    expect((await new AxeBuilder({ page }).include('[role="menu"]').withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toHaveText("Archived");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test(`${theme}: nested Menu supports two submenu levels and returns focus`, async ({ page }) => {
    await page.goto(story("menu--nested", theme));
    const trigger = page.getByRole("button", { name: "Work item actions", exact: true });
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Move to", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("menuitem", { name: "Planning", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("menuitem", { name: "Backlog", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("menuitem", { name: "Planning", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toHaveText("Moved to Backlog");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });

  test(`${theme}: Dropdown button preserves button variants and disabled behavior`, async ({ page }) => {
    await page.goto(story("dropdown-button--primary", theme));
    const trigger = page.getByRole("button", { name: "Actions", exact: true });
    await expect(trigger).toHaveAttribute("type", "button");
    await expect(trigger).toHaveCSS("color", theme === "light" ? "rgb(255, 255, 255)" : "rgb(10, 10, 10)");
    await trigger.click();
    await expect(page.locator("#storybook-root button")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await page.goto(story("dropdown-button--disabled", theme));
    await expect(page.getByRole("button", { name: "Actions", exact: true })).toBeDisabled();
    await expect(page.getByRole("menu")).toHaveCount(0);
  });
}

test("checkbox and radio menu items report selection through Radix", async ({ page }) => {
  await page.goto(story("menu--selection"));
  const trigger = page.getByRole("button", { name: "View options", exact: true });
  await trigger.click();
  const checkbox = page.getByRole("menuitemcheckbox", { name: "Show details" });
  await expect(checkbox).toHaveAttribute("aria-checked", "true");
  await checkbox.click();
  await expect(page.getByRole("status")).toHaveText("Details hidden; comfortable");
  await trigger.click();
  await expect(page.getByRole("menuitemcheckbox")).toHaveAttribute("aria-checked", "false");
  await page.getByRole("menuitemradio", { name: "Compact", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Details hidden; compact");
  await trigger.click();
  await expect(page.getByRole("menuitemradio", { name: "Compact", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("menuitemradio", { name: "Comfortable", exact: true })).toHaveAttribute("aria-checked", "false");
});

test("nested menus remain usable by pointer on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(story("menu--nested"));
  await page.getByRole("button", { name: "Work item actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Planning", exact: true }).hover();
  const item = page.getByRole("menuitem", { name: "In progress", exact: true });
  await expect(item).toBeInViewport();
  const box = await item.boundingBox();
  if (!box) throw new Error("Missing nested menu item");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByRole("status")).toHaveText("Moved to In progress");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
