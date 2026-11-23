import { test, expect } from "@playwright/test";
import { story, editor, pickup, drag } from "./editor-drag-helpers";

test("repeated moves across unequal-height blocks preserve controls and exact Markdown", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(story("markdown-round-trip")); const content = editor(page);
  const input = page.getByRole("textbox", { name: "Markdown source", exact: true });
  const markdown = `# Title\n\n${"A paragraph with enough context to wrap onto multiple lines. ".repeat(12)}\n\n> Quote\n\n- [x] Finished\n- [ ] Pending\n\n## Tail`;
  await input.fill(markdown); await page.getByRole("button", { name: "Load Markdown", exact: true }).click();
  await page.getByRole("button", { name: "Export Markdown", exact: true }).click();
  const original = await input.inputValue();
  await content.locator("h1").scrollIntoViewIfNeeded();
  await drag(page, content.locator("h1"), content.locator("h2"));
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(content.locator(":scope > *").first()).toHaveText("Title");
  for (let index = 0; index < 3; index++) {
    await content.locator("h1").scrollIntoViewIfNeeded();
    await drag(page, content.locator("h1"), content.locator("h2"));
    await expect(content.locator(":scope > *").last()).toHaveText("Title");
    await drag(page, content.locator("h1"), content.locator(":scope > p"), true);
    await expect(content.locator(":scope > *").first()).toHaveText("Title");
  }
  await expect(content.getByRole("checkbox", { name: "Finished", exact: true })).toBeChecked();
  await expect(content.getByRole("checkbox", { name: "Pending", exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Export Markdown", exact: true }).click(); await expect(input).toHaveValue(original);
  await expect(content.locator("[data-block-dragging]")).toHaveCount(0);
});
test("reversing a drag then cancelling leaves no transforms, duplicate content or model changes", async ({ page }) => {
  await page.goto(story("default")); const content = editor(page), original = await content.innerText();
  const heading = (await content.locator("h2").boundingBox())!, paragraph = (await content.locator(":scope > p").first().boundingBox())!;
  await pickup(page, content.locator("h1"));
  await page.mouse.move(heading.x + 40, heading.y + heading.height - 2, { steps: 10 });
  await expect(page.locator("[data-drop-indicator]")).toBeVisible();
  await page.mouse.move(paragraph.x + 40, paragraph.y + 5, { steps: 10 });
  await page.keyboard.press("Escape"); await page.mouse.up();
  expect(await content.innerText()).toBe(original);
  expect(await content.locator(":scope > *").evaluateAll((nodes) => nodes.every((node) => !(node as HTMLElement).style.transform))).toBe(true);
  await expect(page.locator("[data-drop-indicator]")).toHaveCount(0);
});
test("nested containers auto-scroll during pickup and cancellation restores the document", async ({ page }) => {
  await page.goto(story("scrollable")); const content = editor(page), original = await content.innerText();
  const region = page.getByRole("region", { name: "Scrollable document" }), bounds = (await region.boundingBox())!;
  await pickup(page, content.locator("h1"));
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 12, { steps: 12 });
  await expect.poll(() => region.evaluate((node) => node.scrollTop)).toBeGreaterThan(120);
  await page.keyboard.press("Escape"); await page.mouse.up();
  expect(await content.innerText()).toBe(original); await expect(page.locator("[data-drop-indicator]")).toHaveCount(0);
  await region.evaluate((node) => { node.scrollTop = 0; });
  await drag(page, content.locator("h1"), content.locator(":scope > p").first());
  await expect(content.locator(":scope > *").nth(1)).toHaveText("A little room to think");
});
test("splitting and deleting text updates the sortable registry without moving another editor", async ({ page }) => {
  await page.goto(story("independent-editors"));
  const first = page.getByRole("textbox", { name: "First document", exact: true });
  const second = page.getByRole("textbox", { name: "Second document", exact: true });
  await first.click(); await page.keyboard.press("End"); await page.keyboard.press("Enter");
  await expect(first.locator(":scope > p")).toHaveCount(2); await page.keyboard.type("New block");
  await expect(first.locator(":scope > p")).toHaveText(["First document", "New block"]);
  await page.keyboard.press("Enter"); await expect(first.locator(":scope > p")).toHaveCount(3);
  await page.keyboard.type("Remove me"); await expect(first.locator(":scope > p").last()).toHaveText("Remove me");
  await page.keyboard.press("Home"); await page.keyboard.press("Shift+End");
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("Remove me");
  await page.keyboard.press("Backspace"); await expect(first.locator(":scope > p").last()).toBeEmpty(); await page.keyboard.press("Backspace");
  await expect(first.locator(":scope > p")).toHaveCount(2);
  await drag(page, first.locator(":scope > p").last(), first.locator(":scope > p").first(), true);
  await expect(first.locator(":scope > p")).toHaveText(["New block", "First document"]);
  await expect(second).toHaveText("Second document");
});
