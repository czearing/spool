import { test, expect } from "@playwright/test";
import { story, editor, handleFor, drag } from "./editor-drag-helpers";
test("paragraphs really reorder in the document and undo restores their order", async ({ page }) => {
  await page.goto(story("empty")); const content = editor(page);
  await content.fill("First"); await page.keyboard.press("End"); await page.keyboard.press("Enter"); await page.keyboard.type("Second");
  await page.keyboard.press("Enter"); await page.keyboard.type("Third");
  await drag(page, content.locator(":scope > p").first(), content.locator(":scope > p").last());
  await expect(content.locator(":scope > p")).toHaveText(["Second", "Third", "First"]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(content.locator(":scope > p")).toHaveText(["First", "Second", "Third"]);
});
test("headings and compound blocks move intact and survive Markdown export", async ({ page }) => {
  await page.goto(story("markdown-round-trip")); const content = editor(page);
  await drag(page, content.locator("h2"), content.locator("h1"), true);
  await expect(content.locator(":scope > *").first()).toHaveText("Make the next step obvious");
  const callout = content.locator("aside");
  await callout.scrollIntoViewIfNeeded();
  await drag(page, callout, content.locator("blockquote"), true);
  await expect(content.locator("aside strong")).toHaveText("Keep it simple.");
  await page.getByRole("button", { name: "Export Markdown", exact: true }).click();
  const markdown = await page.getByRole("textbox", { name: "Markdown source", exact: true }).inputValue();
  expect(markdown.indexOf(":::callout")).toBeLessThan(markdown.indexOf("> Good writing"));
  expect(markdown.startsWith("## Make the next step obvious")).toBe(true);
});
test("keyboard pickup, reordering and cancellation use the same block model", async ({ page }) => {
  await page.goto(story("default")); const content = editor(page);
  const handle = await handleFor(page, content.locator("h1"));
  await handle.focus(); await page.keyboard.press("Space"); await expect(handle).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowDown"); await expect(page.locator("[data-drop-indicator]")).toBeVisible(); await page.keyboard.press("Space");
  await expect(content.locator(":scope > *").nth(1)).toHaveText("A little room to think");
  const moved = await handleFor(page, content.locator("h1"));
  await moved.focus(); await page.keyboard.press("Space"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Escape");
  await expect(content.locator(":scope > *").nth(1)).toHaveText("A little room to think");
  await expect(page.locator("[data-drop-indicator]")).toBeHidden();
});
test("dropping outside leaves content unchanged and dragging does not move text selections", async ({ page }) => {
  await page.goto(story("default")); const content = editor(page), before = await content.innerText();
  const handle = await handleFor(page, content.locator("h1")), bounds = await handle.boundingBox();
  await page.mouse.move(bounds!.x + 10, bounds!.y + 10); await page.mouse.down();
  await page.mouse.move(10, 10, { steps: 15 }); await page.mouse.up();
  await expect(content).toBeVisible();
  expect(await content.innerText()).toBe(before);
  await content.locator("p").first().click(); await page.keyboard.press("Home"); await page.keyboard.press("Shift+End");
  expect(await page.evaluate(() => window.getSelection()?.toString().length)).toBeGreaterThan(0);
  await expect(page.locator("[data-drop-indicator]")).toBeHidden();
});
test("focus has no canvas outline and read-only documents have no drag handles", async ({ page }) => {
  await page.goto(story("default")); await editor(page).focus();
  const styles = await editor(page).evaluate((node) => {
    const css = getComputedStyle(node); return { outline: css.outlineStyle, border: css.borderInlineStartWidth, shadow: css.boxShadow };
  });
  expect(styles).toEqual({ outline: "none", border: "0px", shadow: "none" });
  await page.goto(story("read-only")); await expect(editor(page)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Move block:/ })).toHaveCount(0);
});
test("block insertion stays accurate after the page has scrolled", async ({ page }) => {
  await page.goto(story("long-document")); const content = editor(page);
  const source = content.locator("h2").filter({ hasText: /^Section 200$/ });
  await source.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(1000);
  const target = content.locator("h2").filter({ hasText: /^Section 201$/ });
  await drag(page, source, target);
  await expect(content.locator("h2").nth(199)).toHaveText("Section 201");
  await expect(content.locator("h2").nth(200)).toHaveText("Section 200");
});
test("touch can move a block by its grip without turning document scrolling into dragging", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage(); await page.goto(story("default"));
    const content = editor(page);
    await content.locator("h1").tap();
    const handle = page.getByRole("button", { name: /^Move block:/ });
    await expect(handle).toBeVisible();
    const start = await handle.boundingBox(), end = await content.locator(":scope > p").first().boundingBox();
    const session = await context.newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start!.x + 12, y: start!.y + 12 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start!.x + 20, y: start!.y + 20 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: end!.x + 30, y: end!.y + end!.height - 2 }] });
    await expect(page.locator("[data-drop-indicator]")).toBeVisible();
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(content.locator(":scope > *").nth(1)).toHaveText("A little room to think");
  } finally { await context.close(); }
});
