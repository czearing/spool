import { expect, test } from "@playwright/test";
const boardStory = "http://127.0.0.1:6006/iframe.html?id=workroom-board--default&viewMode=story";

for (const expanded of [false, true]) {
  for (const edge of ["top", "left", "right", "bottom"] as const) {
    test(`archive accepts a ${edge}-edge pointer drop while ${expanded ? "expanded" : "collapsed"}`, async ({ page }) => {
      await page.goto(boardStory);
      const archive = page.getByRole("region", { name: "Archive", exact: true });
      const trigger = archive.getByRole("button", { name: "Archive (0)", exact: true });
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      if (expanded) {
        await trigger.click();
        await expect(archive.getByRole("table")).toBeVisible();
        await archive.evaluate(async (element) => {
          await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
        });
      }
      const card = page.getByRole("button", { name: "Set up project", exact: true });
      const start = await card.boundingBox();
      const end = await archive.boundingBox();
      if (!start || !end) throw new Error("Missing drag source or target");
      const x = edge === "left" ? end.x + 2 : edge === "right" ? end.x + end.width - 2 : start.x + start.width / 2;
      const y = edge === "top" ? end.y + 2 : edge === "bottom" ? end.y + end.height - 2 : end.y + end.height / 2;
      await page.mouse.move(start.x + start.width / 2, start.y + start.height - 2);
      await page.mouse.down();
      await page.mouse.move(start.x + start.width / 2 + 8, start.y + start.height - 2, { steps: 3 });
      await page.mouse.move(x, y, { steps: 20 });
      await expect(archive).toHaveAttribute("data-over", "true");
      await page.mouse.up();
      await expect(card).toHaveCount(0);
      const updated = archive.getByRole("button", { name: "Archive (1)", exact: true });
      await expect(updated).toHaveAttribute("aria-expanded", String(expanded));
      if (!expanded) await updated.click();
      await expect(archive.getByRole("cell")).toHaveText(["Set up project", "Completed"]);
    });
  }
}

test("touch drop at the collapsed archive edge works after horizontal scrolling", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto(boardStory);
    const card = page.getByRole("button", { name: "Set up project", exact: true });
    await card.scrollIntoViewIfNeeded();
    const archive = page.getByRole("region", { name: "Archive", exact: true });
    const start = await card.boundingBox();
    const end = await archive.boundingBox();
    if (!start || !end) throw new Error("Missing drag source or target");
    const session = await context.newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ x: start.x + start.width / 2, y: start.y + start.height - 2 }],
    });
    await expect(card).toHaveAttribute("aria-pressed", "true");
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove", touchPoints: [{ x: end.x + end.width / 2, y: end.y + 2 }],
    });
    await expect(archive).toHaveAttribute("data-over", "true");
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(card).toHaveCount(0);
    await expect(archive.getByRole("button", { name: "Archive (1)", exact: true })).toHaveAttribute("aria-expanded", "false");
  } finally { await context.close(); }
});

test("a pointer outside the archive does not archive an overlapping card", async ({ page }) => {
  await page.goto(boardStory);
  const card = page.getByRole("button", { name: "Set up project", exact: true });
  const archive = page.getByRole("region", { name: "Archive", exact: true });
  const start = await card.boundingBox();
  const end = await archive.boundingBox();
  if (!start || !end) throw new Error("Missing drag source or target");
  await page.mouse.move(start.x + start.width / 2, start.y + 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 8, start.y + 2, { steps: 3 });
  await page.mouse.move(start.x + start.width / 2, end.y - 2, { steps: 20 });
  await expect(archive).toHaveAttribute("data-over", "false");
  await page.mouse.up();
  await expect(card).toBeVisible();
  await expect(archive.getByRole("button", { name: "Archive (0)", exact: true })).toBeVisible();
});
