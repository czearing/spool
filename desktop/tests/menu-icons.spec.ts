import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

for (const theme of ["light", "dark"]) {
  test(`${theme}: menu icons keep shared sizing, accessible names, keyboard selection, and links`, async ({ page }) => {
    await page.goto(`http://127.0.0.1:6006/iframe.html?id=components-menu--with-icons&viewMode=story&globals=theme:${theme}`);
    const trigger = page.getByRole("button", { name: "Work item actions", exact: true });
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    const rename = page.getByRole("menuitem", { name: "Rename", exact: true });
    await expect(rename).toBeFocused();
    for (const item of await page.getByRole("menuitem").all()) {
      const icon = item.locator('span[aria-hidden="true"] > svg');
      await expect(icon).toHaveCSS("width", "16px");
      await expect(icon).toHaveCSS("height", "16px");
      await expect(icon).toHaveCSS("color", await item.evaluate((element) => getComputedStyle(element).color));
    }
    await expect(page.getByRole("menuitem", { name: "Read guide", exact: true })).toHaveAttribute("href", "#guide");
    await expect(page.getByRole("menuitem", { name: "Read guide", exact: true })).toHaveCSS("color", theme === "light" ? "rgb(23, 23, 23)" : "rgb(237, 237, 237)");
    await expect(page.getByRole("menuitem", { name: "Read guide", exact: true })).toHaveCSS("text-decoration-line", "none");
    await expect(page.getByRole("menuitem", { name: "Share", exact: true })).toHaveAttribute("aria-disabled", "true");
    expect((await new AxeBuilder({ page }).include('[role="menu"]').withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Move to", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("menuitem", { name: "Backlog", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toHaveText("Moved to Backlog");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByRole("menuitem", { name: "Read guide", exact: true }).click();
    await expect(page).toHaveURL(/#guide$/);
  });
}
