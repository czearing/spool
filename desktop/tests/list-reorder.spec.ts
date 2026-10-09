import { expect, test } from "@playwright/test";

const story = "http://127.0.0.1:6006/iframe.html?id=components-list--remembered-layout&viewMode=story";

for (const rtl of [false, true]) {
  test(`${rtl ? "RTL" : "LTR"}: drag headings directly without sorting or losing saved column identity`, async ({ page }) => {
    await page.goto(story);
    const table = page.getByRole("table", { name: "Work items", exact: true });
    await expect(table).toBeVisible();
    if (rtl) await page.locator("html").evaluate((element) => element.setAttribute("dir", "rtl"));
    const source = table.getByRole("button", { name: "Status", exact: true });
    const destination = table.getByRole("button", { name: "Work item", exact: true });
    const from = (await source.boundingBox())!, to = (await destination.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
    await expect(source).toHaveAttribute("data-dragging", "true");
    await expect(page.locator("[data-drop-indicator]")).toHaveAttribute("data-orientation", "vertical");
    await page.mouse.up();
    await expect(table.getByRole("columnheader").first()).toHaveAccessibleName("Status");
    await expect(table.locator("th[aria-sort]")).toHaveCount(0);
    await expect(source).toBeFocused();
    await expect(table.locator("tbody tr").first().locator(":scope > :first-child")).toHaveText("Completed");
    await page.reload();
    await expect(table.getByRole("columnheader").first()).toHaveAccessibleName("Status");
  });
}

test("Escape and dropping outside cancel a column move without sorting", async ({ page }) => {
  await page.goto(story);
  const source = page.getByRole("button", { name: "Status", exact: true });
  await expect(source).toBeVisible();
  const box = (await source.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 100, box.y + box.height / 2, { steps: 5 });
  await expect(source).toHaveAttribute("data-dragging", "true");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.getByRole("columnheader").first()).toHaveAccessibleName("Work item");
  await expect(page.locator("th[aria-sort]")).toHaveCount(0);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(1, 1, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByRole("columnheader").first()).toHaveAccessibleName("Work item");
  await expect(page.locator("th[aria-sort]")).toHaveCount(0);
  await source.click();
  await expect(page.getByRole("columnheader", { name: "Status", exact: true })).toHaveAttribute("aria-sort", "ascending");
});

test("touch moves a heading without opening menus or starting archive drag logic", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 1024, height: 768 } });
  try {
    const page = await context.newPage();
    await page.goto(story);
    const source = page.getByRole("button", { name: "Status", exact: true });
    const target = page.getByRole("button", { name: "Work item", exact: true });
    await expect(source).toBeVisible();
    const from = (await source.boundingBox())!, to = (await target.boundingBox())!;
    const session = await context.newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart",
      touchPoints: [{ x: from.x + from.width / 2, y: from.y + from.height / 2 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove",
      touchPoints: [{ x: to.x + to.width / 2, y: to.y + to.height / 2 }] });
    await expect(source).toHaveAttribute("data-dragging", "true");
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(page.getByRole("columnheader").first()).toHaveAccessibleName("Status");
    await expect(page.locator("th[aria-sort]")).toHaveCount(0);
  } finally { await context.close(); }
});
