import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { input, openStory } from "./messaging-helpers";

test("streaming preserves caret, edits and partial content on stop", async ({ page }) => {
  await openStory(page, "messaging", "streaming-while-typing");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible();
  await expect(input(page)).toHaveText("");
  await input(page).fill("Another thought");
  await input(page).press("Home"); await input(page).press("ArrowRight"); await page.keyboard.type("X");
  await expect(input(page)).toHaveText("AXnother thought");
  await page.getByRole("button", { name: "Stop response" }).click();
  const last = page.getByRole("article", { name: "Assistant message" }).last();
  await expect(last).toContainText("Stopped");
  const partial = await last.innerText();
  await page.waitForTimeout(150); expect(await last.innerText()).toBe(partial);
  await expect(input(page)).toHaveText("AXnother thought");
});
test("conversation replacement aborts late acceptance", async ({ page }) => {
  await openStory(page, "messaging", "conversation-switch");
  await input(page).fill("Old conversation"); await input(page).press("Enter");
  await page.getByRole("button", { name: "New conversation" }).click();
  await page.waitForTimeout(650);
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(input(page)).toHaveText("");
  await input(page).fill("Start a stream"); await input(page).press("Enter");
  await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible();
  await page.getByRole("button", { name: "New conversation" }).click();
  await page.waitForTimeout(200);
  await expect(page.getByRole("article")).toHaveCount(0);
});
test("completion retains the response element and the next send preserves history", async ({ page }) => {
  await openStory(page, "messaging", "empty");
  await input(page).fill("First"); await input(page).press("Enter");
  const response = page.getByRole("article", { name: "Assistant message" });
  await expect(response).toBeVisible();
  const element = await response.elementHandle();
  await expect(page.getByRole("status").filter({ hasText: "Response complete." })).toBeVisible({ timeout: 10_000 });
  expect(await element!.evaluate((node) => node.isConnected)).toBe(true);
  await input(page).fill("Second"); await input(page).press("Enter");
  await expect(page.getByRole("article")).toHaveCount(4);
  await expect(page.getByRole("article", { name: "You message" }).first()).toContainText("First");
});
test("scrolling up interrupts following and Latest messages restores it", async ({ page }) => {
  await openStory(page, "messaging", "long-history");
  const viewport = page.getByRole("region", { name: "Messages", exact: true });
  await expect(page.getByRole("article")).toHaveCount(500);
  await input(page).fill("A new response"); await input(page).press("Enter");
  await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible();
  await viewport.hover(); await page.mouse.wheel(0, -800);
  await expect(page.getByRole("button", { name: "Latest messages" })).toBeVisible();
  const top = await viewport.evaluate((element) => element.scrollTop);
  await page.waitForTimeout(250);
  expect(Math.abs((await viewport.evaluate((element) => element.scrollTop)) - top)).toBeLessThan(5);
  await page.getByRole("button", { name: "Latest messages" }).click();
  await expect(page.getByRole("button", { name: "Latest messages" })).toHaveCount(0);
});
for (const theme of ["light", "dark"]) test(`${theme}: messaging is accessible and usable at narrow widths and enlarged text`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStory(page, "messaging", "basic-markdown", theme);
  await expect(input(page)).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await input(page).focus();
  expect(await input(page).evaluate((element) => getComputedStyle(element.parentElement!.parentElement!).outlineStyle)).toBe("solid");
});
test("untrusted Markdown cannot execute HTML, create unsafe links or load remote images", async ({ page }) => {
  const imageRequests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("tracking.png")) imageRequests.push(request.url()); });
  await openStory(page, "message-bubble", "untrusted-content");
  const message = page.getByRole("article");
  await expect(message).toContainText("Remote image");
  await expect(message.locator("script,img,iframe")).toHaveCount(0);
  await expect(message.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(imageRequests).toEqual([]);
});
