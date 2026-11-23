import { expect, test, type Locator } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const story = (id: string, theme: string) => `http://127.0.0.1:6006/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`;
async function typeRole(element: Locator, weight: number, size = 14) {
  await expect(element).toHaveCSS("font-size", `${size}px`);
  await expect(element).toHaveCSS("font-weight", String(weight));
  await expect(element).toHaveCSS("line-height", `${size * 1.5}px`);
  await expect(element).toHaveCSS("font-family", /"Geist Sans"/);
}

for (const theme of ["light", "dark"]) {
  test(`${theme}: Text roles cover every component without changing semantics`, async ({ page }) => {
    await page.goto(story("components-text--specimen", theme));
    await page.evaluate(() => document.fonts.ready);
    await typeRole(page.getByRole("heading", { name: "Organize this - 600" }), 600);
    await typeRole(page.getByText("Read this - 400.", { exact: false }), 400);
    await typeRole(page.getByText("Act on this - 500", { exact: true }), 500);
    const count = page.getByText("Supplementary counts:", { exact: false });
    await typeRole(count, 500, 12);
    await expect(count).toHaveCSS("font-variant-numeric", "tabular-nums");
    await typeRole(page.getByText("Generic content stays regular", { exact: false }), 400);
    for (const name of ["Review work", "Complete work"]) await typeRole(page.getByRole("button", { name, exact: true }), 500);
    await expect(page.getByRole("button", { name: "Complete work" }))
      .toHaveCSS("color", theme === "light" ? "rgb(255, 255, 255)" : "rgb(10, 10, 10)");
    const list = page.getByRole("table", { name: "Typography archive" });
    await typeRole(list.getByRole("columnheader", { name: "Work item" }), 500, 12);
    await typeRole(list.getByRole("cell", { name: "Review José's proposal" }), 400);
    await expect(list.locator("td p").first()).toHaveText("Review José's proposal");
    const trigger = page.getByRole("button", { name: "Archive (2)", exact: true });
    await typeRole(trigger.locator(":scope > span"), 600);
    await typeRole(trigger.getByText("(2)", { exact: true }), 500, 12);
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(list).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(list).toBeVisible();
    const results = await new AxeBuilder({ page }).include("#storybook-root")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
  });

  test(`${theme}: board roles include draggable titles, archive rows, counts, and instructions`, async ({ page }) => {
    await page.goto(story("workroom-board--with-archive", theme));
    const board = page.getByRole("region", { name: "Work items", exact: true });
    await typeRole(board.getByRole("heading", { name: "Backlog" }), 600);
    await typeRole(board.getByRole("button", { name: "Plan next release", exact: true }).locator("span"), 500);
    const archive = page.getByRole("table", { name: "Archived work items" });
    await page.getByRole("button", { name: "Archive (2)", exact: true }).click();
    await typeRole(archive.getByRole("cell", { name: "Plan next release", exact: true }), 400);
    await typeRole(archive.getByText("Completed", { exact: true }).first(), 400);
    await expect(archive.getByText("Completed", { exact: true }).first())
      .toHaveCSS("color", theme === "light" ? "rgb(82, 82, 82)" : "rgb(179, 179, 179)");
    await page.goto(story("workroom-board--empty", theme));
    await page.getByRole("button", { name: "Archive (0)", exact: true }).click();
    await typeRole(page.getByRole("cell", { name: "Drop items here." }), 400);
  });

  test(`${theme}: Text survives narrow layouts, double text size, and spacing overrides`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto(story("components-text--specimen", theme));
    await page.addStyleTag({ content: `
      html { font-size: 200% !important; }
      #storybook-root * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; }
      #storybook-root p { margin-bottom: 2em !important; }
    ` });
    await expect(page.getByRole("heading", { name: "Organize this - 600" })).toHaveCSS("font-size", "28px");
    for (const button of await page.getByRole("button").all()) {
      expect(await button.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByText("Drop items here.", { exact: true })).toBeVisible();
    const trigger = page.getByRole("button", { name: "Archive (2)", exact: true });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
  });
}
