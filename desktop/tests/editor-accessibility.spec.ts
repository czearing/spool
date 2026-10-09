import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const story = (name: string, theme = "light") => `http://127.0.0.1:6006/iframe.html?id=components-editor--${name}&viewMode=story&globals=theme:${theme}`;
for (const theme of ["light", "dark"]) test(`${theme}: editor, slash picker and selection controls are accessible`, async ({ page }) => {
  await page.goto(story("default", theme));
  const editor = page.getByRole("textbox", { name: "Document", exact: true });
  await expect(editor.locator("table")).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.goto(story("empty", theme)); await editor.click(); await page.keyboard.type("/head");
  await expect(page.getByRole("option").first()).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape"); await editor.fill("Selected text"); await editor.press("Control+a");
  await expect(page.getByRole("toolbar", { name: "Selection formatting", exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});
test("mobile, enlarged text and forced colors keep the editor usable without page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(story("default"));
  const editor = page.getByRole("textbox", { name: "Document", exact: true });
  await expect(editor).toBeVisible();
  for (const fontSize of ["100%", "200%"]) {
    await page.evaluate((value) => { document.documentElement.style.fontSize = value; }, fontSize);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" }); await editor.focus();
  expect(await editor.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe("none");
  const control = page.getByRole("button", { name: "Turn into", exact: true });
  await control.focus();
  expect(await control.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe("solid");
});
test("read-only content cannot be edited and independent editors keep separate histories", async ({ page }) => {
  await page.goto(story("read-only"));
  const editor = page.getByRole("textbox", { name: "Document", exact: true });
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("toolbar")).toHaveCount(0);
  await page.goto(story("independent-editors"));
  const first = page.getByRole("textbox", { name: "First document", exact: true });
  const second = page.getByRole("textbox", { name: "Second document", exact: true });
  await first.click(); await first.press("Control+End"); await page.keyboard.type(" updated");
  await expect(first).toHaveText("First document updated"); await expect(second).toHaveText("Second document");
  await first.press("Control+z"); await expect(first).toHaveText("First document"); await expect(second).toHaveText("Second document");
});
test("typing does not commit React UI or export the document on every keystroke", async ({ page }) => {
  await page.goto(story("change-notifications"));
  const editor = page.getByRole("textbox", { name: "Document", exact: true });
  await editor.click(); await page.keyboard.type("Warm up");
  await expect(page.getByRole("status").filter({ hasText: "exported Markdown" })).toHaveText("7 exported Markdown characters");
  await page.getByRole("button", { name: "Inspect React commits", exact: true }).click();
  const before = Number((await page.getByText(/^Commits:/).innerText()).split(": ")[1]);
  await editor.click(); await editor.press("Control+End"); await page.keyboard.type(" abcdefghijklmnopqrstuvwxyz0123456789");
  await expect(page.getByRole("status").filter({ hasText: "exported Markdown" })).toHaveText("44 exported Markdown characters");
  await page.getByRole("button", { name: "Inspect React commits", exact: true }).click();
  const after = Number((await page.getByText(/^Commits:/).innerText()).split(": ")[1]);
  expect(after - before).toBeLessThan(10);
});
test("a large document remains editable without losing surrounding blocks", async ({ page }) => {
  await page.goto(story("long-document"));
  const editor = page.getByRole("textbox", { name: "Document", exact: true });
  await expect(editor.locator("h2")).toHaveCount(400);
  await editor.locator("p").nth(199).click(); await page.keyboard.press("End");
  const start = Date.now();
  await page.keyboard.type(" A fast, local update.");
  expect(Date.now() - start).toBeLessThan(3000);
  await expect(editor.locator("p").nth(199)).toContainText("A fast, local update.");
  await expect(editor.locator("h2")).toHaveCount(400);
});
