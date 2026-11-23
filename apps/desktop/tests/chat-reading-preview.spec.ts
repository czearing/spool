import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const storyUrl = "http://127.0.0.1:6006/iframe.html?id=tasks-reading-preview--proposed&viewMode=story";
test("uses the shared reading style without changing outgoing messages or adding a response label", async ({ page }) => {
  await page.goto(`${storyUrl}&globals=theme:light`);
  const proposed = page.getByRole("region", { name: "Approved chat", exact: true });
  const message = proposed.getByRole("article", { name: "software-engineer message" });
  await expect(message).toContainText("The duplicate fetch");
  await expect(message.getByText("Response", { exact: true })).toHaveCount(0);
  const paragraph = message.locator("p").first();
  const reading = await paragraph.evaluate(node => {
    const style = getComputedStyle(node);
    return { fontSize: style.fontSize, lineHeight: style.lineHeight, margin: parseFloat(style.marginBottom) };
  });
  expect(reading.fontSize).toBe("16px");
  expect(reading.lineHeight).toBe("26.4px");
  expect(reading.margin).toBeGreaterThan(12);
  const header = message.locator("th").first();
  expect(await header.evaluate(node => getComputedStyle(node).borderLeftWidth)).toBe("0px");
  const numeric = message.locator("tbody tr").first().locator("td").nth(1);
  expect(await numeric.evaluate(node => getComputedStyle(node).textAlign)).toBe("right");
  expect(await numeric.evaluate(node => getComputedStyle(node).fontVariantNumeric)).toBe("tabular-nums");
  const outgoing = proposed.getByRole("article", { name: "You message" });
  expect(await outgoing.locator("p").evaluate(node => getComputedStyle(node).fontSize)).toBe("14px");
  expect(await proposed.getByRole("heading", { name: "The fix is ready" }).evaluate(node => getComputedStyle(node).borderBottomWidth)).toBe("0px");
  await proposed.evaluate(node => { node.style.setProperty("--font-size-reading", "1.125rem"); });
  expect(await paragraph.evaluate(node => getComputedStyle(node).fontSize)).toBe("18px");
  expect(await outgoing.locator("p").evaluate(node => getComputedStyle(node).fontSize)).toBe("14px");
});

for (const theme of ["light", "dark"]) test(`${theme}: wide tables stay inside the chat at narrow widths and enlarged text`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${storyUrl}&globals=theme:${theme}`);
  await page.getByRole("combobox", { name: "Content" }).click();
  await page.getByRole("option", { name: "Wide table", exact: true }).click();
  const table = page.getByRole("region", { name: "Message table" });
  await expect(table).toBeAttached();
  await table.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await table.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  await table.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => table.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("the app's shared task chat keeps 1,000 history messages virtualized while editing", async ({ page }) => {
  await page.goto(storyUrl.replace("--proposed", "--long-history"));
  const viewport = page.getByRole("region", { name: "Task conversation" });
  await expect(page.getByRole("list", { name: "Conversation messages" })).toHaveAttribute("data-message-count", "1002");
  await viewport.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const response = page.getByRole("article", { name: "software-engineer message" }).filter({ hasText: "The duplicate fetch" });
  await expect(response).toContainText("The duplicate fetch");
  expect(await page.getByRole("article").count()).toBeLessThan(20);
  const element = await response.elementHandle();
  const input = page.getByRole("textbox", { name: "Preview message", exact: true });
  await input.fill("Keep the existing controls.");
  await input.press("End");
  await page.keyboard.type(" Tables and spacing should remain readable.");
  await expect(input).toContainText("Tables and spacing should remain readable.");
  expect(await element!.evaluate(node => node.isConnected)).toBe(true);
  expect(await page.getByRole("article").count()).toBeLessThan(20);
});
