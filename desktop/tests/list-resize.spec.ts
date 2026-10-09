import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const url = (name = "remembered-layout", theme = "light") =>
  `http://127.0.0.1:6006/iframe.html?id=components-list--${name}&viewMode=story&globals=theme:${theme}`;
const storageKey = "spool:list:storybook-work-items";
const header = (page: Page, name = "Work item") => page.getByRole("columnheader", { name, exact: true });
const size = async (page: Page, name = "Work item") => (await header(page, name).boundingBox())!.width;
async function resize(page: Page, delta: number, end = true, name = "Work item") {
  const handle = page.getByRole("separator", { name: `Resize ${name}`, exact: true });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, { steps: 8 });
  if (end) await page.mouse.up();
}

for (const theme of ["light", "dark"]) {
  test(`${theme}: resizing preserves neighboring widths and saves across reloads`, async ({ page }) => {
    await page.goto(url("remembered-layout", theme));
    await expect(header(page)).toBeVisible();
    const before = await size(page);
    const status = await size(page, "Status");
    await resize(page, 100);
    await expect.poll(() => size(page)).toBeCloseTo(before + 100, 0);
    expect(await size(page, "Status")).toBeCloseTo(status, 0);
    await expect(page.locator("th[aria-sort]")).toHaveCount(0);
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey)).not.toBeNull();
    await page.reload();
    await expect.poll(() => size(page)).toBeCloseTo(before + 100, 0);
    await expect(page.getByRole("separator", { name: "Resize Work item", exact: true })).toHaveAttribute("aria-valuenow", String(Math.round(before + 100)));
    const result = await new AxeBuilder({ page }).include("#storybook-root").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(result.violations).toEqual([]);
  });
}

test("keyboard resizing respects bounds and column opt-out; pointer cancellation restores geometry", async ({ page }) => {
  await page.goto(url("resize-limits"));
  const handle = page.getByRole("separator", { name: "Resize Work item", exact: true });
  await expect(handle).toBeVisible();
  await expect(page.getByRole("separator", { name: "Resize Updated", exact: true })).toHaveCount(0);
  await handle.focus();
  await page.keyboard.press("Home");
  await expect.poll(() => size(page)).toBeCloseTo(100, 0);
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => size(page)).toBeCloseTo(164, 0);
  await page.keyboard.press("End");
  await expect.poll(() => size(page)).toBeCloseTo(480, 0);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => size(page)).toBeCloseTo(480, 0);
  await resize(page, -90, false);
  await expect.poll(() => size(page)).toBeCloseTo(390, 0);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(() => size(page)).toBeCloseTo(480, 0);
  await expect(handle).toBeFocused();
});

test("column ordering persists with widths, keeps cells matched, and resets explicitly", async ({ page }) => {
  await page.goto(url());
  await expect(header(page)).toBeVisible();
  const before = await size(page);
  await resize(page, 80);
  await page.getByRole("button", { name: "Status", exact: true }).focus();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByRole("columnheader").first()).toHaveAccessibleName("Status");
  await expect(page.getByRole("table", { name: "Work items", exact: true }).locator("tbody tr").first().locator(":scope > :first-child")).toHaveText("Completed");
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").order?.[0], storageKey)).toBe("status");
  await page.reload();
  await expect(page.getByRole("columnheader").first()).toHaveAccessibleName("Status");
  await expect.poll(() => size(page)).toBeCloseTo(before + 80, 0);
  await page.getByRole("button", { name: "Status", exact: true }).focus();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByRole("columnheader").first()).toHaveAccessibleName("Status");
  await page.keyboard.press("Alt+Home");
  await expect(page.getByRole("columnheader").first()).toHaveAccessibleName("Work item");
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey)).toBeNull();
  await expect.poll(() => size(page)).toBeCloseTo(before, 0);
});

test("touch resizing and cancellation use captured pointer events", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 1024, height: 768 } });
  try {
    const page = await context.newPage();
    await page.goto(url());
    const handle = page.getByRole("separator", { name: "Resize Work item", exact: true });
    await expect(handle).toBeVisible();
    const initial = await size(page);
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    const session = await context.newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 60, y }] });
    await expect.poll(() => size(page)).toBeCloseTo(initial + 60, 0);
    await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await expect.poll(() => size(page)).toBeCloseTo(initial, 0);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 60, y }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => size(page)).toBeCloseTo(initial + 60, 0);
  } finally { await context.close(); }
});

test("RTL resizing follows visual arrow and pointer direction", async ({ page }) => {
  await page.goto(url("sorting"));
  await expect(header(page)).toBeVisible();
  await page.locator("html").evaluate((element) => element.setAttribute("dir", "rtl"));
  const before = await size(page);
  await resize(page, -80);
  await expect.poll(() => size(page)).toBeCloseTo(before + 80, 0);
  await page.getByRole("separator", { name: "Resize Work item", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => size(page)).toBeCloseTo(before + 96, 0);
});

test("the final column edge remains reachable inside the scroll frame", async ({ page }) => {
  await page.goto(url("sorting"));
  await expect(header(page, "Updated")).toBeVisible();
  const before = await size(page, "Updated");
  await resize(page, 70, true, "Updated");
  await expect.poll(() => size(page, "Updated")).toBeCloseTo(before + 70, 0);
});

test("malformed and blocked preference storage produces explicit errors", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "invalid"), storageKey);
  await page.goto(url());
  await expect(page.getByRole("alert")).toContainText("Could not restore list layout");
  await page.getByRole("button", { name: "Work item", exact: true }).focus();
  await page.keyboard.press("Alt+Home");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("spool:list:")) throw new DOMException("Storage blocked", "SecurityError");
      original.call(this, key, value);
    };
  });
  await resize(page, 60);
  await expect(page.getByRole("alert")).toContainText("Could not save list layout");
});

test("archive layout persists independently and reordered rows remain draggable", async ({ page }) => {
  await page.goto("http://127.0.0.1:6006/iframe.html?id=workroom-board--with-archive&viewMode=story");
  await page.getByRole("button", { name: "Archive (2)", exact: true }).click();
  const archive = page.getByRole("region", { name: "Archive", exact: true });
  await archive.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
  await archive.getByRole("separator", { name: "Resize Work item", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await archive.getByRole("button", { name: "Status", exact: true }).focus();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("spool:list:archive") ?? "{}").order?.[0])).toBe("status");
  const row = archive.locator("#work-item-archived-1");
  await row.focus();
  await page.keyboard.press("Space");
  await expect(row).toHaveAttribute("data-dragging", "true");
  await page.keyboard.press("ArrowUp");
  const destination = page.getByRole("region", { name: "Completed", exact: true });
  await expect(destination).toHaveAttribute("data-over", "true");
  await page.keyboard.press("Space");
  await expect(destination.locator("#work-item-archived-1")).toBeFocused();
  await page.reload();
  await page.getByRole("button", { name: "Archive (2)", exact: true }).click();
  await expect(archive.getByRole("columnheader").first()).toHaveAccessibleName("Status");
  await page.goto(url());
  await expect(page.getByRole("columnheader").first()).toHaveAccessibleName("Work item");
});
