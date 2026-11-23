import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { labels, statuses } from "../src/lib/work-items";

const story = "http://127.0.0.1:6006/iframe.html?id=workroom-board--with-archive&viewMode=story";

async function openArchive(page: Page) {
  await page.goto(story);
  await page.getByRole("button", { name: "Archive (2)", exact: true }).click();
  const archive = page.getByRole("region", { name: "Archive", exact: true });
  await expect(archive.getByRole("table")).toBeVisible();
  await archive.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
  return archive;
}

for (const status of statuses) {
  for (const input of ["mouse", "keyboard"]) {
    test(`${input} restores an archive row into ${status}`, async ({ page }) => {
      const archive = await openArchive(page);
      const row = archive.getByRole("row", { name: "Plan next release Completed", exact: true });
      const target = page.getByRole("region", { name: labels[status], exact: true });
      if (input === "mouse") {
        const start = await row.getByRole("cell", { name: "Completed", exact: true }).boundingBox();
        const end = await target.boundingBox();
        if (!start || !end) throw new Error("Missing restore source or target");
        await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
        await page.mouse.down();
        await page.mouse.move(start.x + start.width / 2 + 8, start.y + start.height / 2, { steps: 3 });
        await expect(row).toHaveAttribute("data-dragging", "true");
        await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 20 });
      } else {
        await row.focus();
        await page.keyboard.press("Space");
        await expect(row).toHaveAttribute("data-dragging", "true");
        await page.keyboard.press("ArrowUp");
        await expect(page.getByRole("region", { name: "Completed", exact: true })).toHaveAttribute("data-over", "true");
        const index = statuses.indexOf(status);
        for (let current = 2; current !== index;) {
          await page.keyboard.press(index < current ? "ArrowLeft" : "ArrowRight");
          current += index < current ? -1 : 1;
          await expect(page.getByRole("region", { name: labels[statuses[current]], exact: true })).toHaveAttribute("data-over", "true");
        }
      }
      await expect(target).toHaveAttribute("data-over", "true");
      if (input === "mouse") await page.mouse.up();
      else await page.keyboard.press("Space");
      await expect(row).toHaveCount(0);
      const restored = target.locator("#work-item-archived-1");
      await expect(restored).toHaveText("Plan next release");
      if (input === "keyboard") await expect(restored).toBeFocused();
      await expect(archive.getByRole("button", { name: "Archive (1)", exact: true })).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator("#work-item-archived-1")).toHaveCount(1);

      await restored.focus();
      await page.keyboard.press("Space");
      await expect(restored).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press("ArrowDown");
      await expect(archive).toHaveAttribute("data-over", "true");
      await page.keyboard.press("Space");
      await expect(restored).toHaveCount(0);
      await expect(archive.getByRole("row", { name: `Plan next release ${labels[status]}`, exact: true })).toBeVisible();
      await expect(archive.getByRole("button", { name: "Archive (2)", exact: true })).toBeVisible();
    });
  }
}

test("archive rows retain table semantics, visible focus, and cancellation in dark mode", async ({ page }) => {
  const archive = await openArchive(page);
  await page.locator("html").evaluate((element) => element.setAttribute("data-theme", "dark"));
  const row = archive.getByRole("row", { name: "Plan next release Completed", exact: true });
  await expect(row).toHaveAttribute("tabindex", "0");
  await expect(row).not.toHaveAttribute("aria-pressed");
  await expect(row.getByRole("cell")).toHaveCount(2);
  await archive.getByRole("button", { name: "Archive (2)", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(archive.getByRole("region", { name: "Archived work items list" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(archive.getByRole("button", { name: "Work item", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(archive.getByRole("separator", { name: "Resize Work item", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(archive.getByRole("button", { name: "Status", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(archive.getByRole("separator", { name: "Resize Status", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(row).toBeFocused();
  await expect(row).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Space");
  await expect(row).toHaveAttribute("data-dragging", "true");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Escape");
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute("data-dragging", "false");
  await expect(archive.getByRole("button", { name: "Archive (2)", exact: true })).toBeVisible();
  const results = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
});

test("dropping an archive row back into archive or outside is a no-op", async ({ page }) => {
  const archive = await openArchive(page);
  const row = archive.getByRole("row", { name: "Plan next release Completed", exact: true });
  await row.focus();
  await page.keyboard.press("Space");
  await expect(row).toHaveAttribute("data-dragging", "true");
  await page.keyboard.press("ArrowDown");
  await expect(archive).toHaveAttribute("data-over", "true");
  await page.keyboard.press("Space");
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute("data-dragging", "false");
  const box = await row.boundingBox();
  if (!box) throw new Error("Missing archive row");
  await page.mouse.move(box.x + 20, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(1, 1, { steps: 20 });
  await page.mouse.up();
  await expect(row).toBeVisible();
  await expect(archive.getByRole("button", { name: "Archive (2)", exact: true })).toBeVisible();
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
});

test("restoring the last archive row leaves an empty expanded archive and a focused card", async ({ page }) => {
  const archive = await openArchive(page);
  for (const id of ["archived-1", "archived-2"]) {
    const row = archive.locator(`#work-item-${id}`);
    await row.focus();
    await page.keyboard.press("Space");
    await expect(row).toHaveAttribute("data-dragging", "true");
    await page.keyboard.press("ArrowUp");
    await expect(page.getByRole("region", { name: "Completed", exact: true })).toHaveAttribute("data-over", "true");
    await page.keyboard.press("Space");
    await expect(page.getByRole("region", { name: "Completed", exact: true }).locator(`#work-item-${id}`)).toBeFocused();
  }
  await expect(archive.getByRole("button", { name: "Archive (0)", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(archive.getByRole("cell", { name: "Drop items here." })).toBeVisible();
  await expect(archive.locator("tr[tabindex]")).toHaveCount(0);
});

test("touch restores from the status cell into a horizontally scrolled column", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    const archive = await openArchive(page);
    const target = page.getByRole("region", { name: "Blocked", exact: true });
    await target.scrollIntoViewIfNeeded();
    const row = archive.getByRole("row", { name: "Plan next release Completed", exact: true });
    const start = await row.getByRole("cell", { name: "Completed", exact: true }).boundingBox();
    const end = await target.boundingBox();
    if (!start || !end) throw new Error("Missing restore source or target");
    const session = await context.newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart",
      touchPoints: [{ x: start.x + start.width / 2, y: start.y + start.height / 2 }] });
    await expect(row).toHaveAttribute("data-dragging", "true");
    await session.send("Input.dispatchTouchEvent", { type: "touchMove",
      touchPoints: [{ x: end.x + end.width / 2, y: end.y + end.height / 2 }] });
    await expect(target).toHaveAttribute("data-over", "true");
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(target.locator("#work-item-archived-1")).toBeVisible();
    await expect(row).toHaveCount(0);
  } finally { await context.close(); }
});
