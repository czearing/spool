import { expect, test } from "@playwright/test";
import { seedItems } from "../src/lib/seed";
import { labels, statuses } from "../src/lib/work-items";

test.use({ hasTouch: true });

for (const status of statuses) {
  for (const input of ["mouse", "keyboard", "touch"]) {
    test(`${input} archives ${status} work without changing its status`, async ({ page }) => {
      await page.goto("http://127.0.0.1:6006/iframe.html?id=workroom-board--default&viewMode=story");
      const item = seedItems.find((item) => item.status === status)!;
      const card = page.getByRole("button", { name: item.title, exact: true });
      const archive = page.getByRole("region", { name: "Archive", exact: true });
      await expect(archive.getByRole("button")).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByText("Only completed items can be archived.")).toHaveCount(0);

      if (input === "keyboard") {
        await card.focus();
        await page.keyboard.press("Space");
        await expect(card).toHaveAttribute("aria-pressed", "true");
        await page.keyboard.press("ArrowDown");
        await expect(archive).toHaveAttribute("data-over", "true");
        await page.keyboard.press("Space");
      } else {
        const start = await card.boundingBox();
        const end = await archive.boundingBox();
        if (!start || !end) throw new Error("Missing drag source or target");
        const x = start.x + start.width / 2;
        const y = start.y + start.height / 2;
        const target = { x: end.x + end.width / 2, y: end.y + end.height / 2 };
        if (input === "mouse") {
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x + 8, y, { steps: 3 });
          await page.mouse.move(target.x, target.y, { steps: 20 });
          await expect(archive).toHaveAttribute("data-over", "true");
          await page.mouse.up();
        } else {
          const session = await page.context().newCDPSession(page);
          await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
          await expect(card).toHaveAttribute("aria-pressed", "true");
          await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [target] });
          await expect(archive).toHaveAttribute("data-over", "true");
          await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await session.detach();
        }
      }

      await expect(card).toHaveCount(0);
      if (input === "keyboard") await expect(archive).toBeFocused();
      const trigger = archive.getByRole("button", { name: "Archive (1)", exact: true });
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await trigger.click();
      await expect(archive.getByRole("cell")).toHaveText([item.title, labels[status]]);
    });
  }
}
