import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("archive list has multiple rows and columns and collapses with the keyboard", async ({ page }) => {
  await page.goto("http://127.0.0.1:6006/iframe.html?id=workroom-board--with-archive&viewMode=story");
  const trigger = page.getByRole("button", { name: "Archive (2)", exact: true });
  const list = page.getByRole("table", { name: "Archived work items" });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(list).toBeHidden();
  await trigger.click();
  await expect(list.getByRole("columnheader")).toHaveText(["Work item", "Status"]);
  await expect(list.getByRole("row")).toHaveCount(3);
  await expect(list.getByRole("row").nth(1).getByRole("cell")).toHaveText(["Plan next release", "Completed"]);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(list).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Space");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(list.getByRole("row")).toHaveCount(3);
  const results = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
});

test("a collapsed archive still accepts completed cards and preserves its closed state", async ({ page }) => {
  await page.goto("http://127.0.0.1:6006/iframe.html?id=workroom-board--default&viewMode=story");
  const archive = page.getByRole("region", { name: "Archive", exact: true });
  await expect(page.getByRole("button", { name: "Archive (0)", exact: true })).toHaveAttribute("aria-expanded", "false");
  const card = page.getByRole("button", { name: "Set up project", exact: true });
  await card.focus();
  await page.keyboard.press("Space");
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowDown");
  await expect(archive).toHaveAttribute("data-over", "true");
  await page.keyboard.press("Space");
  await expect(card).toHaveCount(0);
  await expect(archive).toBeFocused();
  const trigger = page.getByRole("button", { name: "Archive (1)", exact: true });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await expect(page.getByRole("table", { name: "Archived work items" }).getByRole("cell"))
    .toHaveText(["Set up project", "Completed"]);
});
