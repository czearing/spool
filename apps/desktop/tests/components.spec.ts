import { expect, test } from "@playwright/test";

const story = (name: string) => `http://127.0.0.1:6006/iframe.html?id=components-${name}&viewMode=story`;

test("buttons keep native button, disabled, and slotted link semantics", async ({ page }) => {
  await page.goto(story("button--default"));
  const button = page.getByRole("button", { name: "Button", exact: true });
  await expect(button).toHaveAttribute("type", "button");
  await button.focus();
  await expect(button).toBeFocused();
  await page.goto(story("button--disabled"));
  await expect(page.getByRole("button", { name: "Button", exact: true })).toBeDisabled();
  await page.goto(story("button--as-link"));
  await expect(page.getByRole("link", { name: "Link", exact: true })).toHaveAttribute("href", "#example");
  await expect(page.getByRole("button")).toHaveCount(0);
});

test("a slotted card is one focusable native button, not nested controls", async ({ page }) => {
  await page.goto(story("card--as-button"));
  const card = page.getByRole("button", { name: "Card action", exact: true });
  await expect(page.getByRole("button")).toHaveCount(1);
  await card.focus();
  await expect(card).toBeFocused();
  await expect(card).toHaveCSS("border-top-width", "1px");
});

test("accordion hides interactive content from focus until expanded", async ({ page }) => {
  await page.goto(story("accordion--default"));
  const trigger = page.getByRole("button", { name: "Details", exact: true });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Content action" })).toBeHidden();
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const content = page.getByRole("region", { name: "Details", exact: true });
  await expect(content).toHaveAttribute("id", (await trigger.getAttribute("aria-controls"))!);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Content action" })).toBeFocused();
});

test("list supports three columns, empty content, and long text on mobile", async ({ page }) => {
  await page.goto(story("list--default"));
  const list = page.getByRole("table", { name: "Work items", exact: true });
  await expect(list.getByRole("columnheader")).toHaveText(["ID", "Work item", "Status"]);
  await expect(list.getByRole("row")).toHaveCount(7);
  await page.goto(story("list--empty"));
  await expect(list.getByRole("cell")).toHaveText("No items.");
  await expect(list.getByRole("cell")).toHaveAttribute("colspan", "3");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(story("list--long-content"));
  await expect(list.getByRole("row")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
