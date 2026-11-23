import { expect, test, type Locator, type Page } from "@playwright/test";
const boardStory = "http://127.0.0.1:6006/iframe.html?id=workroom-board--default&viewMode=story";

test.use({ hasTouch: true });

async function drag(page: Page, source: Locator, target: Locator) {
  const start = await source.boundingBox();
  const end = await target.boundingBox();
  if (!start || !end) throw new Error("Missing drag source or target");
  await page.mouse.move(start.x + start.width * .75, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width * .75 + 10, start.y + start.height / 2, { steps: 3 });
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 20 });
  await page.mouse.up();
}

test("the whole card moves between columns and then archives", async ({ page }) => {
  await page.goto(boardStory);
  const card = page.getByRole("button", { name: "Plan next release", exact: true });
  const archive = page.getByRole("region", { name: "Archive", exact: true });
  await drag(page, card, page.getByRole("region", { name: "Completed", exact: true }));
  await expect(page.getByRole("region", { name: "Completed", exact: true }).getByRole("button", { name: "Plan next release" })).toBeVisible();
  await drag(page, card, archive);
  await expect(card).toHaveCount(0);
  await archive.getByRole("button", { name: "Archive (1)", exact: true }).click();
  await expect(archive.getByRole("row").filter({ hasText: "Plan next release" })).toHaveText("Plan next releaseCompleted");
});

test("keyboard dragging moves one column per arrow, retains focus, and archives", async ({ page }) => {
  await page.goto(boardStory);
  const card = page.getByRole("button", { name: "Plan next release", exact: true });
  await card.focus();
  await page.keyboard.press("Space");
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("region", { name: "In progress", exact: true })).toHaveAttribute("data-over", "true");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("region", { name: "Completed", exact: true })).toHaveAttribute("data-over", "true");
  await page.keyboard.press("Space");
  await expect(page.getByRole("region", { name: "Completed", exact: true }).getByRole("button", { name: "Plan next release" })).toBeVisible();
  await expect(card).toBeFocused();
  await page.keyboard.press("Space");
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("region", { name: "Archive", exact: true })).toHaveAttribute("data-over", "true");
  await page.keyboard.press("Space");
  await expect(card).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Archive", exact: true })).toBeFocused();
});

test("Escape cancels dragging and dropping outside leaves work unchanged", async ({ page }) => {
  await page.goto(boardStory);
  const card = page.getByRole("button", { name: "Plan next release", exact: true });
  await card.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Backlog", exact: true }).getByRole("button", { name: "Plan next release" })).toBeVisible();
  const box = await card.boundingBox();
  await page.mouse.move(box!.x + 20, box!.y + 20);
  await page.mouse.down();
  await page.mouse.move(1, 1, { steps: 15 });
  await page.mouse.up();
  await expect(page.getByRole("region", { name: "Backlog", exact: true }).getByRole("button", { name: "Plan next release" })).toBeVisible();
});

test("touch dragging starts anywhere on the card after a short hold", async ({ page }) => {
  await page.goto(boardStory);
  const card = page.getByRole("button", { name: "Plan next release", exact: true });
  const target = page.getByRole("region", { name: "In progress", exact: true });
  const start = await card.boundingBox();
  const end = await target.boundingBox();
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart", touchPoints: [{ x: start!.x + start!.width * .75, y: start!.y + start!.height / 2 }],
  });
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await session.send("Input.dispatchTouchEvent", {
    type: "touchMove", touchPoints: [{ x: end!.x + end!.width / 2, y: end!.y + end!.height / 2 }],
  });
  await expect(target).toHaveAttribute("data-over", "true");
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(target.getByRole("button", { name: "Plan next release" })).toBeVisible();
});
