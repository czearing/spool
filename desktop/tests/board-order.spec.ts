import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const story = "http://127.0.0.1:6006/iframe.html?id=workroom-board--default&viewMode=story";
async function drag(page: Page, source: Locator, target: Locator) {
  const from = (await source.boundingBox())!, to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();
}
test("reorders cards within a column using mouse and keyboard", async ({ page }) => {
  await page.goto(story);
  await expect(page.locator("#work-item-2")).toBeVisible();
  const list = page.getByRole("list", { name: "Backlog items" }).locator('[id^="work-item-"]');
  await drag(page, page.locator("#work-item-2"), page.locator("#work-item-1"));
  await expect(list).toHaveText(["Review requirements", "Plan next release"]);
  await page.locator("#work-item-1").focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#work-item-1")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.locator("#work-item-2").locator("..")).toHaveAttribute("data-insertion", "true");
  await expect(page.locator("[data-drop-indicator]")).toHaveAttribute("data-orientation", "horizontal");
  await page.keyboard.press("Space");
  await expect(list).toHaveText(["Plan next release", "Review requirements"]);
  await expect(page.locator("#work-item-1")).toBeFocused();
});
for (const theme of ["light", "dark"]) {
  test(`${theme}: one board has tinted columns, soft cards, and no view configuration`, async ({ page }) => {
    await page.goto(`${story}&globals=theme:${theme}`);
    await expect(page.locator("#work-item-1")).toBeVisible();
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Add view|Manage view|settings|subgroup/i })).toHaveCount(0);
    const colors = theme === "light" ? ["rgb(49, 95, 133)", "rgb(62, 101, 75)", "rgb(146, 80, 75)"]
      : ["rgb(163, 189, 211)", "rgb(171, 199, 176)", "rgb(217, 170, 164)"];
    for (const [index, status] of ["In progress", "Completed", "Blocked"].entries()) {
      const lane = page.getByRole("region", { name: status, exact: true });
      await expect(lane).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(lane.getByRole("heading")).toHaveCSS("color", colors[index]);
    }
    const card = page.locator("#work-item-1");
    await expect(card).toHaveCSS("border-color", theme === "light" ? "rgb(229, 229, 229)" : "rgb(43, 43, 43)");
    await expect(card).not.toHaveCSS("box-shadow", "none");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const lane of await page.locator("[data-status]").all()) expect((await lane.boundingBox())!.width).toBeGreaterThanOrEqual(256);
    const columnScroll = await page.locator("#board-items").evaluate((element) => {
      const parent = element.parentElement!;
      return { client: parent.clientWidth, scroll: parent.scrollWidth };
    });
    expect(columnScroll.scroll).toBeGreaterThan(columnScroll.client);
    await page.emulateMedia({ forcedColors: "active" });
    await expect(page.locator("#work-item-1")).toBeVisible();
    const canvasText = await page.locator("body").evaluate((element) => getComputedStyle(element).color);
    await expect(page.getByRole("heading", { name: "Completed", exact: true })).toHaveCSS("color", canvasText);
    await expect(card).toHaveCSS("box-shadow", "none");
  });
}
