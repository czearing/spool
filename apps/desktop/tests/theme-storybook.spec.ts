import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const documentBounds = (element: Element) => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x: x + scrollX, y: y + scrollY, width, height };
};

test("theme toolbar changes the preview without resetting work or accordion state", async ({ page }) => {
  await page.goto("http://127.0.0.1:6006/?path=/story/workroom-board--default&globals=theme:light");
  const preview = page.frameLocator("#storybook-preview-iframe");
  const card = preview.getByRole("button", { name: "Set up project", exact: true });
  await card.focus();
  await page.keyboard.press("Space");
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowDown");
  await expect(preview.getByRole("region", { name: "Archive", exact: true })).toHaveAttribute("data-over", "true");
  await page.keyboard.press("Space");
  await expect(card).toHaveCount(0);
  await expect(preview.getByRole("button", { name: "Archive (1)", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(preview.getByRole("table", { name: "Archived work items" })).toBeHidden();
  const remainingCard = preview.getByRole("button", { name: "Plan next release", exact: true });
  const initialLayout = await remainingCard.evaluate(documentBounds);
  await page.getByRole("button", { name: "Color theme Light", exact: true }).click();
  await page.getByRole("listbox", { name: "Color theme" }).getByText("Dark", { exact: true }).click();
  await expect(preview.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(preview.getByRole("button", { name: "Archive (1)", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(card).toHaveCount(0);
  expect(await remainingCard.evaluate(documentBounds)).toEqual(initialLayout);
  await page.getByRole("button", { name: "Color theme Dark", exact: true }).click();
  await page.getByRole("listbox", { name: "Color theme" }).getByText("System", { exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(preview.locator("html")).toHaveAttribute("data-theme", "system");
  await expect(preview.locator("html")).toHaveCSS("background-color", "rgb(10, 10, 10)");
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: every shared component uses the palette and remains accessible`, async ({ page }) => {
    const stories = ["button--default", "button--disabled", "card--as-button", "list--default", "accordion--expanded"];
    for (const story of stories) {
      await page.goto(`http://127.0.0.1:6006/iframe.html?id=components-${story}&viewMode=story&globals=theme:${theme}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      if (story === "button--default" || story === "card--as-button") {
        await expect(page.getByRole("button")).toHaveCSS("background-color", theme === "light" ? "rgb(255, 255, 255)" : "rgb(20, 20, 20)");
        await expect(page.getByRole("button")).toHaveCSS("color", theme === "light" ? "rgb(23, 23, 23)" : "rgb(237, 237, 237)");
        await page.getByRole("button").focus();
        await expect(page.getByRole("button")).toHaveCSS("outline-width", "2px");
      }
      if (story === "button--default") {
        await page.getByRole("button").hover();
        await expect(page.getByRole("button")).toHaveCSS("background-color", theme === "light" ? "rgb(245, 245, 245)" : "rgb(36, 36, 36)");
        await page.mouse.down();
        await expect(page.getByRole("button")).toHaveCSS("background-color", theme === "light" ? "rgb(237, 237, 237)" : "rgb(46, 46, 46)");
        await page.mouse.up();
      }
      if (story === "button--disabled") {
        const button = page.getByRole("button", { name: "Button", exact: true });
        await expect(button).toHaveCSS("opacity", "1");
        await expect(button).toHaveCSS("color", theme === "light" ? "rgb(115, 115, 115)" : "rgb(119, 119, 119)");
      }

      const results = await new AxeBuilder({ page }).include("#storybook-root")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(results.violations, story).toEqual([]);
    }
  });
}

test("the app preserves its light default until a preference is chosen", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
});
