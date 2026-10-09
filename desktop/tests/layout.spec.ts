import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const story = (id: string, theme = "light") => `http://127.0.0.1:6006/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`;

for (const theme of ["light", "dark"]) {
  test(`${theme}: the board uses a compact four-column grid with token spacing`, async ({ page }) => {
    await page.goto(story("workroom-board--default", theme));
    const board = page.getByRole("region", { name: "Work items", exact: true });
    const archive = page.getByRole("region", { name: "Archive", exact: true });
    await expect(board).toHaveCSS("display", "grid");
    await expect(board).toHaveCSS("gap", "16px");
    await expect(board.getByRole("region")).toHaveCount(4);
    await expect(page.locator("main")).toHaveCSS("display", "flex");
    await expect(page.locator("main")).toHaveCSS("gap", "24px");
    await expect(archive.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    await expect(archive.getByRole("table")).toBeHidden();
    const lanes = await board.getByRole("region").evaluateAll((elements) => elements.map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }));
    for (const lane of lanes) {
      expect(lane.y).toBe(lanes[0].y);
      expect(lane.width).toBeCloseTo(lanes[0].width, 0);
      expect(lane.height).toBe(lanes[0].height);
    }
    const gridBox = await board.boundingBox();
    const archiveBox = await archive.boundingBox();
    expect(archiveBox!.x).toBe(gridBox!.x);
    expect(archiveBox!.width).toBe(gridBox!.width);
    expect(archiveBox!.y - gridBox!.y - gridBox!.height).toBeCloseTo(24, 0);
    expect(archiveBox!.height).toBeLessThan(100);
    expect(gridBox!.height).toBeLessThan(280);
  });
}

test("Stack preserves native sections and supports token gaps and wrapping rows", async ({ page }) => {
  await page.goto(story("components-stack--as-child"));
  const section = page.getByRole("region", { name: "Related work" });
  await expect(section).toHaveCSS("display", "flex");
  await expect(section).toHaveCSS("flex-direction", "column");
  await expect(section).toHaveCSS("gap", "16px");
  await expect(section.locator(":scope > div")).toHaveCount(2);
  await page.setViewportSize({ width: 180, height: 600 });
  await page.goto(story("components-stack--row"));
  const row = page.locator("#storybook-root > div");
  await expect(row).toHaveCSS("gap", "8px");
  await expect(row).toHaveCSS("flex-direction", "row");
  await expect(row).toHaveCSS("flex-wrap", "wrap");
  const first = await page.getByRole("button").first().boundingBox();
  const last = await page.getByRole("button").last().boundingBox();
  expect(last!.y).toBeGreaterThan(first!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("Grid preserves native semantics, equal columns, and source order", async ({ page }) => {
  await page.goto(story("components-grid--as-child"));
  const section = page.getByRole("region", { name: "Related work" });
  await expect(section).toHaveCSS("display", "grid");
  await expect(section).toHaveCSS("gap", "16px");
  await expect(section.locator(":scope > div")).toHaveText(["First item", "Second item"]);
  await page.goto(story("components-grid--four-columns"));
  const cells = page.locator("#storybook-root > div > div");
  await expect(cells).toHaveCount(4);
  const boxes = await cells.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()));
  for (const box of boxes) {
    expect(box.y).toBe(boxes[0].y);
    expect(box.width).toBeCloseTo(boxes[0].width, 0);
  }
  const results = await new AxeBuilder({ page }).include("#storybook-root").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations).toEqual([]);
});
