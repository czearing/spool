import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"]) {
  test(`${theme}: row rhythm and text alignment match the shared list tokens`, async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(`http://127.0.0.1:6006/iframe.html?id=components-list--default&viewMode=story&globals=theme:${theme}`);
    const table = page.getByRole("table", { name: "Work items", exact: true });
    await expect(table.locator("tbody tr")).toHaveCount(4);
    await page.evaluate(() => document.fonts.ready);
    const metrics = await table.evaluate((element) => {
      const header = element.querySelector("thead th")!;
      const row = element.querySelector("tbody tr")!;
      const cell = row.querySelector("th")!;
      const primary = cell.querySelector("span:not([aria-hidden])")!;
      const label = header.querySelector("button > span:not([aria-hidden])")!;
      return {
        headerHeight: header.getBoundingClientRect().height,
        rowHeight: row.getBoundingClientRect().height,
        labelX: label.getBoundingClientRect().x,
        titleX: primary.getBoundingClientRect().x,
        weight: getComputedStyle(primary).fontWeight,
      };
    });
    expect(metrics.headerHeight).toBeGreaterThanOrEqual(40);
    expect(metrics.rowHeight).toBeCloseTo(56, 0);
    expect(metrics.titleX).toBeCloseTo(metrics.labelX, 0);
    expect(metrics.weight).toBe("500");
    const sort = table.getByRole("button", { name: "Work item", exact: true });
    const indicator = sort.locator(":scope > svg");
    await expect(indicator).toHaveCSS("opacity", "0");
    await sort.hover();
    await expect(indicator).toHaveCSS("opacity", "1");
    await sort.click();
    await page.mouse.move(1, 1);
    await expect(indicator).toHaveCSS("opacity", "1");
    await expect(table.getByRole("columnheader", { name: "Work item", exact: true })).toHaveAttribute("aria-sort", "ascending");
  });
}

test("the narrow list scrolls within its frame and exposes the final column", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:6006/iframe.html?id=components-list--default&viewMode=story");
  const region = page.getByRole("region", { name: "Work items list" });
  await expect(region).toBeVisible();
  expect(await region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await region.focus();
  await page.keyboard.press("End");
  await page.getByRole("button", { name: "Updated", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Updated", exact: true })).toBeInViewport();
  expect(await region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
