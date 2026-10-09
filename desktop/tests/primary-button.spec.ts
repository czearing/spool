import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const palettes = {
  light: { background: "rgb(23, 23, 23)", color: "rgb(255, 255, 255)", hover: "rgb(51, 51, 51)", pressed: "rgb(64, 64, 64)" },
  dark: { background: "rgb(237, 237, 237)", color: "rgb(10, 10, 10)", hover: "rgb(212, 212, 212)", pressed: "rgb(189, 189, 189)" },
};

for (const theme of ["light", "dark"] as const) {
  test(`primary button uses brand tokens for every ${theme} state`, async ({ page }) => {
    await page.goto(`http://127.0.0.1:6006/iframe.html?id=components-button--primary&viewMode=story&globals=theme:${theme}`);
    const button = page.getByRole("button", { name: "Button", exact: true });
    const palette = palettes[theme];
    await expect(button).toHaveAttribute("type", "button");
    await expect(button).toHaveCSS("background-color", palette.background);
    await expect(button).toHaveCSS("color", palette.color);
    await button.focus();
    await expect(button).toHaveCSS("outline-width", "2px");
    await expect(button).toHaveCSS("outline-offset", "3px");
    await button.hover();
    await expect(button).toHaveCSS("background-color", palette.hover);
    await page.mouse.down();
    await expect(button).toHaveCSS("background-color", palette.pressed);
    await expect(button).toHaveCSS("color", palette.color);
    await page.mouse.up();
    const results = await new AxeBuilder({ page }).include("#storybook-root")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);

    await page.goto(`http://127.0.0.1:6006/iframe.html?id=components-button--primary-disabled&viewMode=story&globals=theme:${theme}`);
    await expect(button).toBeDisabled();
    await button.hover({ force: true });
    await expect(button).toHaveCSS("background-color", theme === "light" ? "rgb(245, 245, 245)" : "rgb(28, 28, 28)");
    await expect(button).toHaveCSS("color", theme === "light" ? "rgb(115, 115, 115)" : "rgb(119, 119, 119)");
  });
}
